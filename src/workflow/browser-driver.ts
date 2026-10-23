import type { Store } from '../memory/store.js';
import type { BrowserAdapter, BrowserTarget, CapturedBrowserApproval } from '../browser/adapter.js';
import { locatorEquals, normalizeLocator, readLocatorProposalSource } from '../knowledge/locator-proposals.js';
import type { WorkflowAssertion, WorkflowDocument, WorkflowStep, WorkflowTarget } from './contract.js';

export type WorkflowExecutableStep = Extract<WorkflowStep, { action: 'navigate' | 'scroll' | 'click' | 'fill' | 'type' | 'press' | 'select' }>;
export type WorkflowWaitStep = Extract<WorkflowStep, { action: 'wait' }>;
export type WorkflowAssertResult = { passed: boolean; observedCount?: number };
export type WorkflowFailureCaptureMode = 'screenshot' | 'snapshot' | 'console_errors';
export type WorkflowFailureCapture = { screenshot?: string | null; snapshot?: Record<string, number>; console_errors?: number };
export type WorkflowSessionState = { closed: boolean };
export type WorkflowDriverRunContext = { workflow: WorkflowDocument; workflowNodeId: string; workflowId: string; runId: string; knowledgeRoot?: string };

/** Backend-neutral operations required by shared deterministic workflow orchestration. */
export interface WorkflowDriver {
  beginRun(context: WorkflowDriverRunContext): void;
  validateWorkflow(workflow: WorkflowDocument): Promise<void> | void;
  validateSession(session: WorkflowSessionState): boolean;
  setActionTimeout(timeoutMs: number): void;
  routeMatches?(screenId: string): Promise<boolean | undefined>;
  assert(check: WorkflowAssertion, variables: Record<string, string>, timeoutMs: number): Promise<WorkflowAssertResult>;
  wait(step: WorkflowWaitStep, variables: Record<string, string>, timeoutMs: number): Promise<void>;
  execute(step: WorkflowExecutableStep, variables: Record<string, string>, timeoutMs: number): Promise<void>;
  proposeFallbacks?(step: WorkflowStep): Promise<string[]>;
  captureFailure?(mode: WorkflowFailureCaptureMode): Promise<WorkflowFailureCapture>;
  cleanup(): void;
}

type Approval = CapturedBrowserApproval;
type BrowserDriverOptions = {
  store: Store;
  browser: BrowserAdapter;
  authorize: (action: string, target: BrowserTarget, revision: number) => Promise<Approval | undefined>;
};

function screenId(value: string) { return value.replace(/^(screen:|role:)/, ''); }
function substitute(value: string, variables: Record<string, string>) {
  const match = value.match(/^\$\{\{\s*variables\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/);
  return match ? variables[match[1]!] ?? '' : value;
}

/** Playwright-only adapter. It deliberately exposes no Page, Locator, or DesktopService to the runner. */
export function createBrowserWorkflowDriver(options: BrowserDriverOptions): WorkflowDriver {
  const { store, browser } = options;
  let initialConsoleErrors = 0;
  let runContext: WorkflowDriverRunContext | undefined;
  const resolveTarget = (target: WorkflowTarget): any => {
    if ('screen' in target) {
      const sid = screenId(target.screen), node = store.getByTypeKey('ui_element', `screen:${sid}/${target.element}`) as any;
      if (!node || node.origin !== 'yaml') throw Error('target_invalid');
      const attrs = JSON.parse(node.attributes_json), locator = normalizeLocator(attrs?.locator);
      return store.inactiveWorkflowLocator({ screenId: sid, elementId: target.element, currentLocator: locator }) ?? locator;
    }
    return target;
  };
  const currentScreenRoute = async (id: string) => {
    const normalized = screenId(id), node = store.getByTypeKey('screen', normalized) as any;
    if (!node || node.origin !== 'yaml') return undefined;
    try { const local = JSON.parse(node.attributes_json).route; if (typeof local === 'string') return local; } catch {}
    const appSubject = store.applicationSubject() as any;
    if (!appSubject) return undefined;
    let app = store.get(appSubject.id) as any;
    if (app?.origin !== 'yaml') app = store.db.prepare("SELECT * FROM nodes WHERE project_id=? AND environment=? AND type='application' AND origin='yaml' AND tombstone=0 ORDER BY id LIMIT 1").get(store.projectId, store.memoryEnvironment);
    if (!app || app.origin !== 'yaml') return undefined;
    try {
      const routes = JSON.parse(app.attributes_json).route_patterns;
      if (!Array.isArray(routes)) return undefined;
      const matched = routes.find((route: any) => route && screenId(String(route.screen ?? '')) === normalized && typeof route.path === 'string');
      return matched?.path as string | undefined;
    } catch { return undefined; }
  };
  const routeMatches = async (id: string): Promise<boolean | undefined> => {
    const route = await currentScreenRoute(id);
    if (!route) return undefined;
    try { return new URL(browser.currentUrl()).pathname === new URL(route, 'http://workflow.invalid').pathname; } catch { return false; }
  };
  const proposeFallbacks = async (step: WorkflowStep): Promise<string[]> => {
    const proposalIds: string[] = [];
    if (!runContext || !('target' in step) || !step.target || typeof step.target !== 'object' || !('screen' in step.target) || !runContext.knowledgeRoot) return proposalIds;
    const sid = screenId(step.target.screen), eid = step.target.element, key = `screen:${sid}/${eid}`;
    const element = store.getByTypeKey('ui_element', key) as any, screen = store.getByTypeKey('screen', sid) as any;
    const owner = store.db.prepare("SELECT source_path,hash FROM yaml_ownership WHERE project_id=? AND environment=? AND entity_type='ui_element' AND entity_key=? AND tombstone=0 ORDER BY source_path LIMIT 1").get(store.projectId, store.memoryEnvironment, key) as any;
    if (!element || element.origin !== 'yaml' || !screen || screen.origin !== 'yaml' || !owner) return proposalIds;
    try {
      const attrs = JSON.parse(element.attributes_json), primary = normalizeLocator(attrs.locator), fallbacks = attrs.fallback_locators;
      if (!Array.isArray(fallbacks) || fallbacks.length === 0 || fallbacks.length > 8) return proposalIds;
      const source = await readLocatorProposalSource(runContext.knowledgeRoot, owner.source_path, sid, eid);
      if (source.sourceHash !== owner.hash || !locatorEquals(primary, source.element.locator)) return proposalIds;
      const history = fallbacks.map(normalizeLocator);
      for (const fallback of history) {
        if (locatorEquals(primary, fallback)) continue;
        let found;
        try { found = await browser.find(fallback); } catch { continue; }
        if (found.count !== 1 || !found.visible) continue;
        const proposal = store.createWorkflowLocatorProposal({ runId: runContext.runId, workflowNodeId: runContext.workflowNodeId, workflowId: runContext.workflowId, stepId: step.id, screenId: sid, elementId: eid, screenNodeId: screen.id, elementNodeId: element.id, sourcePath: owner.source_path, sourceHash: source.sourceHash, baselineHash: source.baselineHash, previousLocator: primary, fallbackHistory: history, candidateLocator: fallback, reasonCode: 'target_invalid' }) as any;
        if (proposal?.id) proposalIds.push(proposal.id);
      }
    } catch {}
    return proposalIds;
  };

  return {
    beginRun: context => { runContext = context; initialConsoleErrors = browser.consoleErrorCount(); },
    validateWorkflow: () => {},
    validateSession: session => !session.closed,
    setActionTimeout: timeoutMs => browser.setActionTimeout(timeoutMs),
    routeMatches,
    assert: async (check, variables, timeoutMs) => {
      const c = check as any, target = c.target ? resolveTarget(c.target) : undefined;
      const expected = typeof c.expected === 'string' ? substitute(c.expected, variables) : c.expected;
      return browser.assertCondition(c.condition, target, expected, Math.max(1, Math.min(timeoutMs, 30_000)), c.match ?? 'contains');
    },
    wait: async (step, variables, timeoutMs) => { await browser.waitFor(step.condition, typeof step.target === 'string' ? substitute(step.target, variables) : resolveTarget(step.target), timeoutMs); },
    execute: async (step, variables, timeoutMs) => {
      if (step.action === 'navigate') { await browser.navigate(step.path, 'load', timeoutMs); return; }
      if (step.action === 'scroll') { await browser.scroll(step.direction, step.amount); return; }
      const target = resolveTarget(step.target), action = step.action, approval = await options.authorize(action, target, browser.revision);
      try {
        if (approval) await browser.performCaptured(action, approval.handle, action === 'press' ? step.key : action === 'fill' || action === 'type' || action === 'select' ? substitute(step.value, variables) : undefined, 0, approval.guard);
        else if (action === 'click') await browser.act('click', target);
        else if (action === 'press') await browser.act('press', target, step.key);
        else if (action === 'fill' || action === 'select') await browser.act(action, target, substitute(step.value, variables));
        else if (action === 'type') await browser.type(target, substitute(step.value, variables));
        else throw Error('action_failed');
      } finally { await approval?.release(); }
    },
    proposeFallbacks,
    captureFailure: async mode => {
      if (mode === 'screenshot') { try { return { screenshot: (await browser.takeScreenshot(false)).artifactPath }; } catch { return { screenshot: null }; } }
      if (mode === 'snapshot') {
        try {
          const snapshot = await browser.snapshot({ mode: 'interactive' }) as any, counts: Record<string, number> = {};
          for (const e of snapshot.elements ?? []) { const role = typeof e.role === 'string' && /^[a-z_-]{1,30}$/i.test(e.role) ? e.role : 'unknown'; counts[role] = Math.min(10_000, (counts[role] ?? 0) + 1); }
          return { snapshot: counts };
        } catch { return { snapshot: {} }; }
      }
      return { console_errors: Math.min(10_000, Math.max(0, browser.consoleErrorCount() - initialConsoleErrors)) };
    },
    cleanup: () => browser.setActionTimeout(30_000),
  };
}
