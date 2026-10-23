import type { DesktopService } from '../desktop/index.js';
import type { WorkflowAssertion, WorkflowDocument, WorkflowStep, WorkflowTarget } from './contract.js';
import type { WorkflowDriver, WorkflowExecutableStep, WorkflowSessionState, WorkflowWaitStep, WorkflowAssertResult } from './browser-driver.js';
import { WorkflowPreflightError } from './runner.js';

export type DesktopHighRiskRule = { action: string; target?: unknown };
export type DesktopWorkflowDriverOptions = {
  service: DesktopService;
  role?: string;
  environment?: string;
  /** Configured action-level rules. CSS targets cannot be safely equated to semantic rule targets, so matching actions fail closed. */
  highRiskRules?: readonly DesktopHighRiskRule[];
};

const MAX_REQUEST_TIMEOUT_MS = 5_000;
const MAX_WAIT_TIMEOUT_MS = 10_000;
const MUTATING_ACTIONS = new Set(['click', 'type', 'scroll']);
const ALLOWED_ASSERTIONS = new Set(['present', 'visible', 'hidden', 'enabled', 'text']);
const ALLOWED_WAITS = new Set(['present', 'visible', 'hidden', 'enabled']);

function failPrecondition(): never { throw new WorkflowPreflightError('precondition_failed'); }
function cssSelector(target: unknown): string {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return failPrecondition();
  const value = target as Record<string, unknown>;
  if (value.by !== 'css' || typeof value.value !== 'string' || !value.value.length || value.value.length > 1000) return failPrecondition();
  return value.value;
}
function hasUnsupportedRouteFields(workflow: WorkflowDocument): boolean {
  return workflow.start_screen !== undefined || workflow.end_screen !== undefined;
}
function normalizedRole(value: string): string { return value.replace(/^(screen:|role:)/, ''); }
function checkAssertion(check: WorkflowAssertion): void {
  const value = check as unknown as { condition: string; target?: unknown; expected?: unknown; match?: unknown };
  if (!ALLOWED_ASSERTIONS.has(value.condition)) failPrecondition();
  cssSelector(value.target);
  if (value.condition === 'text') {
    if (typeof value.expected !== 'string' || (value.match !== undefined && value.match !== 'exact' && value.match !== 'contains')) failPrecondition();
  }
}
function substitute(value: string, variables: Record<string, string>): string {
  const match = value.match(/^\$\{\{\s*variables\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/);
  return match ? variables[match[1]!] ?? '' : value;
}
function boundedTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return 1;
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.floor(timeoutMs));
}

/** Narrow native desktop adapter. It never starts a service or exposes browser primitives. */
export function createDesktopWorkflowDriver(options: DesktopWorkflowDriverOptions): WorkflowDriver {
  const { service } = options;
  const highRiskRules = options.highRiskRules ?? [];
  let actionTimeoutMs = MAX_REQUEST_TIMEOUT_MS;

  const validateActionRisk = (action: string) => {
    if (MUTATING_ACTIONS.has(action) && highRiskRules.some(rule => rule.action === 'any' || rule.action === action)) throw new WorkflowPreflightError('approval_denied');
  };
  const actionTarget = async (target: WorkflowTarget): Promise<string> => {
    const selector = cssSelector(target);
    const matches = await service.find(selector, 50);
    if (matches.length !== 1 || !matches[0]!.visible || !matches[0]!.enabled) throw Error('target_invalid');
    return selector;
  };
  const inspect = async (selector: string) => service.find(selector, 50);
  const withRequestTimeout = async <T>(timeoutMs: number, operation: () => Promise<T>): Promise<T> => {
    service.setActionRequestTimeout(boundedTimeout(timeoutMs));
    try { return await operation(); }
    finally { service.setActionRequestTimeout(actionTimeoutMs); }
  };

  return {
    beginRun: () => {},
    validateWorkflow: workflow => {
      if (hasUnsupportedRouteFields(workflow)) failPrecondition();
      if (workflow.requires?.role && normalizedRole(workflow.requires.role) !== normalizedRole(options.role ?? '')) failPrecondition();
      if (workflow.requires?.environment?.length && !workflow.requires.environment.includes(options.environment ?? '')) failPrecondition();
      if (workflow.on_failure?.capture?.some(mode => mode !== 'desktop_screenshot')) failPrecondition();
      for (const check of workflow.preconditions ?? []) checkAssertion(check);
      for (const step of workflow.steps) {
        const item = step as WorkflowStep & Record<string, unknown>;
        if (item.action === 'click' || item.action === 'type') {
          cssSelector(item.target);
          validateActionRisk(item.action);
        } else if (item.action === 'scroll') {
          if (item.direction !== 'up' && item.direction !== 'down') failPrecondition();
          if (item.amount !== undefined && (!Number.isInteger(item.amount) || item.amount < 1 || item.amount > 3000)) failPrecondition();
          validateActionRisk('scroll');
        } else if (item.action === 'wait') {
          if (!ALLOWED_WAITS.has(String(item.condition))) failPrecondition();
          cssSelector(item.target);
        } else if (item.action === 'assert') {
          checkAssertion(item as unknown as WorkflowAssertion);
        } else failPrecondition();
      }
    },
    validateSession: (session: WorkflowSessionState) => !session.closed,
    setActionTimeout: timeoutMs => {
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw Error('timeout');
      actionTimeoutMs = boundedTimeout(timeoutMs);
      service.setActionRequestTimeout(actionTimeoutMs);
    },
    assert: async (check, variables, timeoutMs): Promise<WorkflowAssertResult> => {
      checkAssertion(check);
      const item = check as unknown as { condition: string; target?: unknown; expected?: string; match?: 'exact' | 'contains' };
      const selector = cssSelector(item.target);
      const budget = Math.max(1, Math.min(timeoutMs, 30_000));
      const deadline = Date.now() + budget;
      const inspectWithRemaining = () => withRequestTimeout(Math.max(1, deadline - Date.now()), () => inspect(selector));
      let matches = await inspectWithRemaining();
      const targetMatch = () => {
        const count = matches.length;
        if (item.condition === 'present') return count > 0;
        if (item.condition === 'visible') return count === 1 && matches[0]!.visible;
        if (item.condition === 'hidden') return count === 0 || (count === 1 && !matches[0]!.visible);
        if (item.condition === 'enabled') return count === 1 && matches[0]!.enabled;
        if (count !== 1) return false;
        return undefined;
      };
      let passed = false;
      do {
        const condition = targetMatch();
        if (condition !== undefined) passed = condition;
        else {
          try {
            const observed = await withRequestTimeout(Math.max(1, deadline - Date.now()), () => service.text(selector));
            const expected = substitute(item.expected!, variables);
            passed = (item.match ?? 'contains') === 'exact' ? observed === expected : observed.includes(expected);
          } catch { passed = false; }
        }
        if (passed || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
        matches = await inspectWithRemaining();
      } while (true);
      return { passed, observedCount: matches.length };
    },
    wait: async (step: WorkflowWaitStep, _variables, timeoutMs) => {
      if (!ALLOWED_WAITS.has(step.condition)) failPrecondition();
      const selector = cssSelector(step.target);
      const deadline = Date.now() + Math.max(1, timeoutMs);
      const condition = step.condition as 'present' | 'visible' | 'hidden' | 'enabled';
      while (Date.now() < deadline) {
        const chunk = Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
        const found = await withRequestTimeout(chunk, () => service.waitFor(selector, condition, chunk));
        if (found) return;
        if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())));
      }
      throw Error('timeout');
    },
    execute: async (step: WorkflowExecutableStep, variables, timeoutMs) => {
      if (step.action === 'click' || step.action === 'type' || step.action === 'scroll') validateActionRisk(step.action);
      else failPrecondition();
      const oldTimeout = actionTimeoutMs;
      const perStepTimeout = boundedTimeout(timeoutMs);
      service.setActionRequestTimeout(perStepTimeout);
      try {
        if (step.action === 'scroll') {
          const amount = Math.min(3000, Math.max(1, step.amount ?? 500));
          await service.scroll(undefined, 0, step.direction === 'up' ? -amount : amount);
          return;
        }
        if (step.action !== 'click' && step.action !== 'type') failPrecondition();
        const selector = await actionTarget(step.target);
        if (step.action === 'click') await service.click(selector);
        else await service.type(selector, substitute(step.value, variables));
      } finally {
        actionTimeoutMs = oldTimeout;
        service.setActionRequestTimeout(oldTimeout);
      }
    },
    cleanup: () => {
      actionTimeoutMs = MAX_REQUEST_TIMEOUT_MS;
      service.setActionRequestTimeout(undefined);
    },
  };
}
