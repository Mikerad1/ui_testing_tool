import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config/config.js';
import { safePath } from '../config/config.js';
import type { Store } from '../memory/store.js';
import type { LearningWriter } from '../memory/learning-writer.js';
import type { BrowserController } from '../browser/controller.js';
import { runWorkflow, runWorkflowWithDriver } from '../workflow/runner.js';
import { createDesktopWorkflowDriver } from '../workflow/desktop-driver.js';
import { reconcile } from '../knowledge/reconcile.js';
import { startKnowledgeWatcher, type KnowledgeWatchEvent, type KnowledgeWatchHandle } from '../knowledge/watcher.js';
import { publishJiraScreenshotComment } from '../jira/comment.js';
import { ArtifactCleanupError, DesktopService, type CaptureKind, type DesktopBuildCommand, type DesktopConfig } from '../desktop/index.js';
import { imageBundleToolCallResult, imageToolCallResult, MAX_MCP_IMAGE_BYTES, MAX_MCP_IMAGE_BUNDLE_BYTES } from './image-content.js';
import { comparePngs } from '../desktop/png-diff.js';

export function originAllowed(origin: string | undefined, tokenMode: boolean, port: number): boolean {
  if (!origin) return true;
  if (!tokenMode) return false;
  try {
    const u = new URL(origin), effectivePort = Number(u.port || (u.protocol === 'https:' ? '443' : '80'));
    return ['http:', 'https:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password && effectivePort === port;
  } catch { return false; }
}

type Session = { id: string; server: McpServer; transport: any; timer?: NodeJS.Timeout; closed: boolean; activeToolCalls: number; cleanupPromise?: Promise<void>; serverClosePromise?: Promise<void>; closePromise?: Promise<void>; cleanup?: () => Promise<void> };
const MAX_BODY = 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_MEMORY_SEARCH_CALL_RESULT_BYTES=48*1024;
function sanitizeErrorMessage(message:string){return message.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi,token=>{const suffix=token.match(/[),.;]+$/)?.[0]??'',candidate=suffix?token.slice(0,-suffix.length):token;try{const url=new URL(candidate);url.username='';url.password='';url.search='';url.hash='';return `${url.origin}${url.pathname}${suffix}`;}catch{return candidate.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@\s]+@/i,'$1').replace(/[?#].*$/,'')+suffix;}}).slice(0,500);}
function hasArtifactCleanupFailure(error: unknown, seen = new Set<unknown>()): boolean {
  if (error === null || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  if (error instanceof ArtifactCleanupError || (error as { code?: unknown }).code === 'ARTIFACT_CLEANUP_FAILED') return true;
  if (error instanceof Error && (/artifact (?:deletion|rollback) failed|could not restore desktop mask|mask (?:cleanup|rollback) failed/i.test(error.message))) return true;
  if (error instanceof AggregateError && [...error.errors].some(item => hasArtifactCleanupFailure(item, seen))) return true;
  return hasArtifactCleanupFailure((error as { cause?: unknown }).cause, seen);
}

export function memorySearchCallToolResult(envelope:Record<string,any>,pageSize:number){
  const wrap=(structuredContent:Record<string,any>)=>({structuredContent,content:[{type:'text' as const,text:JSON.stringify(structuredContent)}]});
  let result=wrap(envelope);
  if(Buffer.byteLength(JSON.stringify(result),'utf8')<=MAX_MEMORY_SEARCH_CALL_RESULT_BYTES)return result;
  const bounded={...envelope,data:[],pagination:{status:'too_broad',page_size:pageSize}};
  result=wrap(bounded);
  return result;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += b.length; if (size > MAX_BODY) throw new Error('Request body too large'); chunks.push(b); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid JSON request body'); }
}
function reply(res: ServerResponse, status: number, message: string) { if (!res.headersSent) { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(message); } }

export type ServeOptions={stdio?:boolean;idleTimeoutMs?:number;applicationReady?:boolean;approver?:(prompt:string)=>Promise<boolean>;knowledgeRoot?:string;projectRoot?:string;learningWriter?:LearningWriter;watchKnowledge?:boolean;watcherFactory?:(root:string,listener:KnowledgeWatchEvent)=>KnowledgeWatchHandle;watchDebounceMs?:number;jiraFetch?:typeof fetch;desktopServiceFactory?:(config:DesktopConfig)=>DesktopService};
export async function serve(config: Config, store: Store, browser: BrowserController, options: ServeOptions = {}) {
  const token = !options.stdio && config.server.auth.mode === 'token' ? process.env[config.server.auth.token_env] : undefined;
  if (!options.stdio && config.server.auth.mode === 'token' && !token) throw Error(`Set ${config.server.auth.token_env} before starting server`);
  if (!options.stdio && !['127.0.0.1', '::1', 'localhost'].includes(config.server.host)) throw Error('Only loopback server binding is permitted');
  if (!options.stdio && config.server.auth.mode === 'none') console.warn('WARNING: MCP HTTP authentication disabled');
  const sessions = new Map<string, Session>();
  const knowledgeRoot=options.knowledgeRoot??path.resolve(config.knowledge.path);
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 1) throw Error('idleTimeoutMs must be a positive finite number');
  let closing = false, pendingInitializers = 0, initializationDrain: (() => void) | undefined, activePosts=0,postDrain:(()=>void)|undefined,activeToolCalls=0,toolDrain:(()=>void)|undefined;
  let browserQueue: Promise<void> = Promise.resolve();
  let desktopQueue: Promise<void> = Promise.resolve();
  let applicationReady = options.applicationReady ?? true;
  const assertApplicationReady = () => { if (!applicationReady) throw Error('Application is not ready. Start the configured application, then retry browser_refresh.'); };
  const browserStatus = async () => ({ ...await browser.status(), application_ready: applicationReady });
  const runBrowser = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = browserQueue.then(fn, fn);
    browserQueue = next.then(() => undefined, () => undefined);
    return next;
  };
  const runDesktop = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = desktopQueue.then(fn, fn);
    desktopQueue = next.then(() => undefined, () => undefined);
    return next;
  };
  const armIdle = (session: Session) => {
    if (session.closed || session.activeToolCalls > 0) return;
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => { void closeSession(session); }, idleTimeoutMs);
    session.timer.unref();
  };
  const closeSession = async (session: Session) => {
    if (session.closePromise) return session.closePromise;
    session.closed = true;
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
    sessions.delete(session.id);
    session.closePromise = (async () => {
      try { await session.transport.close(); } finally { try { await session.cleanup?.(); } finally { await (session.serverClosePromise ??= session.server.close()); } }
    })();
    return session.closePromise;
  };

  function createSession(): Session {
    const mcp = new McpServer({ name: 'ui-memory-browser', version: '0.1.0' });
    let desktopService: DesktopService | undefined;
    const session: Session = { id: '', server: mcp, transport: undefined as unknown as StreamableHTTPServerTransport, closed: false, activeToolCalls: 0 };
    session.cleanup = () => session.cleanupPromise ??= runDesktop(async () => { await desktopService?.stop(); });
    const getDesktopService = async (requireEnabled = false) => {
      if (requireEnabled && !config.desktop?.enabled) throw Error('Desktop testing is disabled. Set desktop.enabled: true explicitly in umb.config.yaml before starting or controlling an app.');
      if (desktopService) return desktopService;
      const configRoot = options.projectRoot ?? process.cwd();
      const desktopRoot = await safePath(configRoot, config.desktop?.root ?? '.', true);
      const desktop = config.desktop;
      const serviceConfig: DesktopConfig = {
        projectRoot: desktopRoot,
        tauriBinary: desktop?.automation.binary_path,
        driverExecutable: desktop?.automation.driver_path,
        windowTitle: desktop?.window.title,
        buildCommand: desktop?.build_command as DesktopBuildCommand | undefined,
        buildTimeoutMs: (desktop?.automation.ready_timeout_seconds ?? 120) * 1000,
        readinessTimeoutMs: (desktop?.automation.ready_timeout_seconds ?? 120) * 1000,
        artifactDirectory: desktop?.visual.output_directory ?? config.artifacts?.directory ?? './.umb/artifacts',
        maxArtifactBytes: config.artifacts?.max_total_bytes,
        maxArtifactFileBytes: config.artifacts?.max_file_bytes,
         maxArtifactCount: config.artifacts?.max_count,
         maxArtifactAgeDays: desktop?.visual.retain_artifacts_max_age_days,
         maskSelectors: desktop?.visual.mask_selectors,
      };
      desktopService = options.desktopServiceFactory?.(serviceConfig) ?? new DesktopService(serviceConfig);
      return desktopService;
    };
    const prepareDesktopArtifacts = async () => {
      const configRoot = options.projectRoot ?? process.cwd();
      const desktopRoot = await safePath(configRoot, config.desktop?.root ?? '.', true);
      const artifactPath = config.desktop?.visual.output_directory ?? config.artifacts?.directory ?? './.umb/artifacts';
      const artifactRoot = await safePath(desktopRoot, artifactPath, true);
      const realRoot = await realpath(desktopRoot);
      const relative = path.relative(realRoot, artifactRoot);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('Desktop artifact directory escapes the configured desktop project root.');
      let current = realRoot;
      const components = relative ? relative.split(path.sep) : [];
      for (const component of [...components, '.umb-managed', 'desktop']) {
        current = path.join(current, component);
        try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw Error('Desktop artifact path components must be regular directories, not symlinks.');
        await chmod(current, 0o700);
      }
      const realManaged = await realpath(current), managedRelative = path.relative(realRoot, realManaged);
      if (managedRelative === '..' || managedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(managedRelative)) throw Error('Managed desktop artifact directory escapes the configured desktop project root.');
      return path.relative(realRoot, realManaged).split(path.sep).join('/');
    };
      const setRequestHandler = mcp.server.setRequestHandler.bind(mcp.server);
    (mcp.server as any).setRequestHandler = (schema: unknown, handler: (request: any, extra: any) => Promise<any> | any) =>
      setRequestHandler(schema as any, async (request: any, extra: any) => {
        const result = await handler(request, extra);
        if (schema !== CallToolRequestSchema || !result?.isError || result.structuredContent) return result;
        const text = result.content?.find((item: any) => item.type === 'text')?.text ?? 'Invalid tool input';
        if (!/input validation error/i.test(text)) return result;
        const envelope = { ok: false, project_id: config.project.id, session_id: session.id, error: { code: 'invalid_input', message: text }, ...(request.params?.name === 'desktop_run_workflow' ? {} : { state_revision: browser.revision }) };
        return { ...result, isError: true, structuredContent: envelope, content: [{ type: 'text', text: JSON.stringify(envelope) }] };
      });
       const invokeTool = (fn: (args: any) => unknown | Promise<unknown>, memorySearch=false, includeImage=false, omitStateRevision=false) => async (args: any) => {
         activeToolCalls++;
         session.activeToolCalls++;
         if (session.timer) clearTimeout(session.timer);
         session.timer = undefined;
         let result: any, imageBytes: Uint8Array | undefined;
          try {
            let value:any=await fn(args);
             if (includeImage && value && typeof value === 'object' && Array.isArray(value.imageBundle)) {
               const { imageBundle, ...metadata } = value;
                result = { ok: true, project_id: config.project.id, session_id: session.id, data: metadata, ...(omitStateRevision ? {} : { state_revision: browser.revision }) };
               imageBytes = undefined;
               const images = imageBundle as Array<{ name: string; bytes: Uint8Array }>;
               return imageBundleToolCallResult(result, images, { enabled: config.desktop?.visual.return_mcp_images !== false, maxBytes: MAX_MCP_IMAGE_BUNDLE_BYTES });
             }
             if (includeImage && value && typeof value === 'object' && value.bytes instanceof Uint8Array) {
              imageBytes = Buffer.from(value.bytes);
              const { bytes: _bytes, ...metadata } = value;
              value = metadata;
            }
             result={ok:true,project_id:config.project.id,session_id:session.id,...(value&&Array.isArray(value.data)&&value.pagination?{data:value.data,pagination:value.pagination}:{data:value}),...(omitStateRevision?{}:{state_revision:browser.revision})};
          }
        catch (error) {
          const message = sanitizeErrorMessage(error instanceof Error ? error.message : 'Operation failed');
            const code = /Wayland|permission|capture denied/i.test(message)?'permission_denied':/desktop testing is disabled/i.test(message)?'desktop_disabled':/no managed (?:desktop|WebDriver) session/i.test(message)?'desktop_session_not_running':/application is not ready|application is not reachable/i.test(message)?'application_not_ready':/revision_conflict/i.test(message)?'revision_conflict':/approval_denied/i.test(message)?'approval_denied':/unsupported|unavailable/i.test(message)?'capability_unavailable':/persistent learning writes are disabled/i.test(message)?'learning_writes_disabled':/revision conflict/i.test(message) ? 'revision_conflict' : /expired snapshot reference|stale ref/i.test(message) ? 'stale_ref' : /ambiguous|matches: 0|no match/i.test(message) ? 'ambiguous_or_missing_target' : /origin not allowed|navigation.*denied/i.test(message) ? 'navigation_denied' : /timeout|timed out/i.test(message) ? 'timeout' : /invalid|must be|requires/i.test(message) ? 'invalid_input' : 'internal';
           result = { ok: false, project_id: config.project.id, session_id: session.id, error: { code, message }, ...(omitStateRevision ? {} : { state_revision: browser.revision }) };
           return { isError: true, structuredContent: result, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } finally {
           activeToolCalls--;
           if (activeToolCalls === 0) { toolDrain?.(); toolDrain = undefined; }
           session.activeToolCalls--;
           if (session.activeToolCalls === 0 && !session.closed) armIdle(session);
        }
          if (memorySearch) return memorySearchCallToolResult(result,args.page_size??50);
           if (imageBytes) return imageToolCallResult(result, imageBytes, { enabled: config.desktop?.visual.return_mcp_images !== false, maxBytes: Math.min(MAX_MCP_IMAGE_BYTES, config.artifacts?.max_file_bytes ?? MAX_MCP_IMAGE_BYTES) });
          return { structuredContent: result, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        };
      const tool = (name: string, description: string, schema: any, fn: (args: any) => unknown | Promise<unknown>) => mcp.tool(name, description, schema, invokeTool(fn,name==='memory_search'));
       const strictTool = (name: string, description: string, schema: z.ZodTypeAny, fn: (args: any) => unknown | Promise<unknown>, omitStateRevision = false) => mcp.registerTool(name, { description, inputSchema: schema }, invokeTool(fn, false, false, omitStateRevision));
      const beforeDesktopOperation = async (service: DesktopService) => {
        const maxAgeDays = config.desktop?.visual.retain_artifacts_max_age_days;
        if (config.desktop?.enabled && maxAgeDays !== undefined) {
          const references = store.listDesktopArtifactReferences();
          await service.pruneUnreferencedArtifacts(references, maxAgeDays);
        }
      };
      const desktopTool = (name: string, description: string, schema: z.ZodTypeAny, fn: (args: any, service: DesktopService) => unknown | Promise<unknown>, requireEnabled = true, sweepBefore = false) =>
         strictTool(name, description, schema, args => runDesktop(async () => { const service = await getDesktopService(requireEnabled); if (sweepBefore) await beforeDesktopOperation(service); return fn(args, service); }));
      const desktopImageTool = (name: string, description: string, schema: z.ZodTypeAny, fn: (args: any, service: DesktopService) => unknown | Promise<unknown>) =>
         mcp.registerTool(name, { description, inputSchema: schema }, invokeTool(args => runDesktop(async () => { const service = await getDesktopService(true); await beforeDesktopOperation(service); return fn(args, service); }), false, true));
      const rollbackArtifacts = async (service: DesktopService, original: unknown, references: string[]): Promise<never> => {
        const failures: unknown[] = [];
        for (const ref of [...new Set(references.filter(Boolean))]) try { await service.removeArtifact(ref); } catch (error) { failures.push(error); }
        if (failures.length) {
          const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
          throw new AggregateError([original, ...failures], `Desktop operation failed (${describe(original)}); artifact rollback failed (${failures.map(describe).join('; ')}).`);
        }
        throw original;
      };
       const captureDesktop = async (service: DesktopService, kind: CaptureKind, reviewBundle?: Record<string, unknown>): Promise<Record<string, any>> => {
         if (!config.desktop?.enabled) throw Error('Desktop testing is disabled. Set desktop.enabled: true explicitly in umb.config.yaml before capturing.');
         const artifactDirectory = await prepareDesktopArtifacts();
         const capture = await service.capture(kind);
         try {
           const desktopRoot = await safePath(options.projectRoot ?? process.cwd(), config.desktop.root, true);
           const captureRelative = path.relative(desktopRoot, path.resolve(capture.path));
           if (!captureRelative || captureRelative === '..' || captureRelative.startsWith(`..${path.sep}`) || path.isAbsolute(captureRelative)) throw Error('Desktop capture artifact is outside the configured desktop project root.');
           const canonicalArtifactRef = captureRelative.split(path.sep).join('/');
           if (!canonicalArtifactRef.startsWith(`${artifactDirectory.replace(/\/$/, '')}/`)) throw Error('Desktop capture artifact is outside the managed artifact directory.');
           if (capture.artifactRef !== canonicalArtifactRef) throw Error('Desktop service artifactRef does not match its canonical project-root-relative capture path.');
           const sessionStatus = await service.status();
           const width = capture.bytes.length >= 24 ? capture.bytes.readUInt32BE(16) : undefined;
           const height = capture.bytes.length >= 24 ? capture.bytes.readUInt32BE(20) : undefined;
           return {
             capture_type: capture.kind,
             source: capture.kind === 'window' ? 'verified X11 window capture via wmctrl + ImageMagick import' : 'WebDriver WebView screenshot',
             method: capture.kind === 'window' ? 'os_window_targeted' : 'webdriver_webview',
             window_title: capture.kind === 'window' ? config.desktop.window.title ?? null : null,
             application_id: config.project.id,
             application_session_id: sessionStatus.id,
             dimensions: { width, height }, scale_factor: null,
             captured_at: new Date().toISOString(),
             artifact_ref: capture.artifactRef,
             artifact_directory: artifactDirectory,
             sha256: capture.sha256 ?? createHash('sha256').update(capture.bytes).digest('hex'),
             byte_length: capture.byteLength ?? capture.bytes.length,
              redaction: config.desktop?.visual.mask_selectors ? { applied: true, method: 'configured_dom_overlay', scope: 'Matched visible in-viewport top-level WebView DOM regions only; this is not general pixel or PII redaction.', warning: 'Native chrome/dialogs, other windows, unselected pixels, iframes, shadow DOM, and DOM-derived text/UI-tree tool responses are outside the screenshot-mask guarantee.' } : { applied: false, warning: 'Desktop pixels are stored as captured; screen-level masking is not guaranteed. Review sensitive content before sharing.' },
             ...(reviewBundle ? { review_bundle: reviewBundle } : {}),
             bytes: capture.bytes,
           };
           } catch (error) {
             await rollbackArtifacts(service, error, [capture.artifactRef]);
             throw error;
          }
       };
      const noArgs = z.object({}).strict();
        const desktopSelector = z.union([
         z.string().min(1).max(2000),
           z.object({ by: z.literal('label'), value: z.string().min(1).max(1000) }).strict(),
           z.object({ by: z.literal('text'), value: z.string().min(1).max(1000) }).strict(),
           z.object({ by: z.literal('role'), role: z.string().min(1).max(100), name: z.string().min(0).max(300).optional() }).strict(),
          z.object({ by: z.literal('test_id'), value: z.string().min(1).max(1000) }).strict(),
          z.object({ by: z.literal('placeholder'), value: z.string().min(1).max(1000) }).strict(),
        ]);
      desktopTool('desktop_capabilities', 'Report OS, display server, driver, binary, WebView, and real-window capture availability. Does not launch processes.', noArgs, (_a, service) => service.capabilities(), false);
      desktopTool('desktop_project_inspect', 'Read-only detection of Tauri/Angular project files and configured build/binary paths. Never executes project commands.', noArgs, (_a, service) => service.inspectProject(), false);
      desktopTool('desktop_session_start', 'Launch a real configured Tauri binary through a managed local tauri-driver WebDriver session. Requires desktop.enabled, an absolute driver path, and a prebuilt binary; does not attach to arbitrary apps.', noArgs, (_a, service) => service.start());
      desktopTool('desktop_session_status', 'Report the managed Tauri WebDriver session started by this MCP session.', noArgs, (_a, service) => service.status());
      desktopTool('desktop_session_stop', 'Stop only this MCP session’s managed Tauri WebDriver session and its owned app process tree.', noArgs, (_a, service) => service.stop());
      desktopTool('desktop_session_restart', 'Stop and relaunch the configured Tauri binary in a fresh managed WebDriver session; an explicitly configured build_command runs on start.', noArgs, async (_a, service) => { await service.stop(); return service.start(); });
      desktopTool('desktop_get_ui_tree', 'Return a bounded semantic summary of visible WebView elements; does not expose raw HTML or form values.', z.object({ max_nodes: z.number().int().min(1).max(300).optional() }).strict(), (a, service) => service.tree(a.max_nodes));
         desktopTool('desktop_find_element', 'Find bounded CSS, exact text, label, role/name-approximation, test_id, or placeholder candidates and return approximate name, text, visibility, enabled state, and geometry.', z.object({ selector: desktopSelector, limit: z.number().int().min(1).max(50).optional() }).strict(), (a, service) => service.find(a.selector, a.limit));
         desktopTool('desktop_click', 'Click a unique element in the managed Tauri WebView using a CSS, exact text, label, or other semantic locator.', z.object({ selector: desktopSelector }).strict(), (a, service) => service.click(a.selector));
         desktopTool('desktop_type', 'Type bounded text into a unique WebView element selected by CSS, exact text, label, or other semantic locator.', z.object({ selector: desktopSelector, text: z.string().max(10000) }).strict(), (a, service) => service.type(a.selector, a.text));
      desktopTool('desktop_keypress', 'Send bounded WebDriver keyboard actions to the managed WebView.', z.object({ keys: z.array(z.string().min(1).max(100)).min(1).max(100) }).strict(), (a, service) => service.keypress(a.keys));
         desktopTool('desktop_upload', 'Upload one project-relative regular file (at most 20 MiB) to a unique enabled input[type=file] selected by CSS, exact text, label, or other semantic locator in this already-running managed Tauri WebView. Uses WebDriver file-input send keys; it does not open a chooser or start a session.', z.object({ selector: desktopSelector, project_relative_path: z.string().min(1).max(1024) }).strict(), (a, service) => {
           if (config.security?.high_risk?.some(rule => rule.action === 'upload' || rule.action === 'any')) throw Error('approval_denied: configured high-risk upload/any rule blocks desktop upload because no desktop approval prompt is available.');
          return service.upload(a.selector, a.project_relative_path);
        });
        desktopTool('desktop_scroll', 'Scroll the WebView or bring a CSS, exact-text, label, or semantically selected element into view.', z.object({ selector: desktopSelector.optional(), x: z.number().int().min(-100000).max(100000).optional(), y: z.number().int().min(-100000).max(100000).optional() }).strict(), (a, service) => service.scroll(a.selector, a.x, a.y));
          desktopTool('desktop_wait_for', 'Wait up to ten seconds for a CSS, exact-text, label, or other semantic locator to become present, visible, hidden, or enabled.', z.object({ selector: desktopSelector, state: z.enum(['present','visible','hidden','enabled']).optional(), timeout_ms: z.number().int().min(0).max(10000).optional() }).strict(), (a, service) => service.waitFor(a.selector, a.state, a.timeout_ms));
       const desktopAssertionSchema = z.union([
         z.object({ selector: desktopSelector, assertion: z.enum(['present','visible','hidden','enabled']) }).strict(),
         z.object({ selector: desktopSelector, assertion: z.literal('text'), match: z.enum(['exact','contains']), expected: z.string().max(1000) }).strict(),
       ]);
         desktopImageTool('desktop_assert', 'Assert bounded WebView semantic state using CSS, exact text, label, or other semantic locators. Returns PASS/FAIL; on FAIL, optionally captures a WebView PNG when desktop.visual.capture_on_failure is enabled.', desktopAssertionSchema, async (a, service) => {
         let passed: boolean;
         if (a.assertion === 'text') {
           const actual = await service.text(a.selector);
           passed = a.match === 'exact' ? actual === a.expected : actual.includes(a.expected);
         } else {
            const candidates = await service.find(a.selector, 2);
            if (a.assertion !== 'present' && candidates.length > 1) throw Error('Desktop state assertion requires a selector matching at most one element.');
           const candidate = candidates[0];
           passed = a.assertion === 'present' ? candidates.length > 0
             : a.assertion === 'visible' ? Boolean(candidate?.visible)
               : a.assertion === 'hidden' ? !candidate || !candidate.visible
                 : Boolean(candidate?.enabled);
         }
         const assertion = { status: passed ? 'PASS' : 'FAIL', assertion: a.assertion, selector: a.selector };
         if (passed) return { assertion, capture: { status: 'not_needed' } };
         if (config.desktop?.visual.capture_on_failure !== true) return { assertion, capture: { status: 'disabled' } };
         try {
           const capture = await captureDesktop(service, 'webview');
           const { bytes, ...metadata } = capture;
           return { assertion, capture: { status: 'captured', ...metadata }, bytes };
          } catch (error) {
            const rollbackFailed = hasArtifactCleanupFailure(error);
            return { assertion, capture: { status: 'failed', code: rollbackFailed ? 'artifact_rollback_failed' : 'capture_failed' } };
          }
       });
       desktopTool('desktop_resize_window', 'Request a native Tauri window size through WebDriver; returns a capability error when the backend/compositor refuses it.', z.object({ width: z.number().int().min(1).max(10000), height: z.number().int().min(1).max(10000) }).strict(), (a, service) => service.resizeWindow(a.width, a.height));
          desktopTool('desktop_get_element_details', 'Inspect bounded text, geometry, safe attributes, and computed CSS for one CSS, exact-text, label, or semantic-locator-selected element.', z.object({ selector: desktopSelector }).strict(), (a, service) => service.details(a.selector));
       desktopImageTool('desktop_screenshot', 'Capture a PNG of the configured actual X11 app window (kind=window) or the WebDriver WebView (kind=webview). The default is window and never silently falls back. Returns MCP image content when enabled and bounded, plus metadata/artifact reference; Wayland window capture currently fails explicitly.', z.object({ kind: z.enum(['window','webview']).optional() }).strict(), async (a, service) => captureDesktop(service, a.kind ?? config.desktop!.window.screenshot_mode));
       const baselineKeySchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/).refine(value => !value.includes('..') && !value.endsWith('.'));
         const profileSchema = z.record(z.unknown()).default({}).superRefine((profile, context) => {
           if (Object.hasOwn(profile, '__umb_mask_policy_v1')) context.addIssue({ code: z.ZodIssueCode.custom, message: 'profile.__umb_mask_policy_v1 is reserved and cannot be supplied by callers.' });
          if (!Object.hasOwn(profile, 'window_size')) return;
          const size = profile.window_size;
          if (!size || typeof size !== 'object' || Array.isArray(size)) { context.addIssue({ code: z.ZodIssueCode.custom, message: 'profile.window_size must contain integer width and height dimensions.' }); return; }
          const rect = size as Record<string, unknown>;
          for (const key of Object.keys(rect)) if (!['width', 'height'].includes(key)) context.addIssue({ code: z.ZodIssueCode.custom, message: `profile.window_size.${key} is not supported.` });
          for (const dimension of ['width', 'height']) if (!Number.isInteger(rect[dimension]) || (rect[dimension] as number) < 1 || (rect[dimension] as number) > 10_000) context.addIssue({ code: z.ZodIssueCode.custom, message: `profile.window_size.${dimension} must be an integer between 1 and 10000.` });
        });
        const captureWithProfile = async (service: DesktopService, kind: CaptureKind, profile: Record<string, unknown>): Promise<Record<string, any>> => {
          const size = profile.window_size as { width: number; height: number } | undefined;
          if (!size) return captureDesktop(service, kind);
          let capture: Record<string, any> | undefined;
          try { return await service.withWindowSize(size.width, size.height, async () => { capture = await captureDesktop(service, kind); return capture; }); }
          catch (error) { if (capture?.artifact_ref) await rollbackArtifacts(service, error, [String(capture.artifact_ref)]); throw error; }
        };
       const artifactRecord = (ref: string, sha256: string, bytes: number) => ({ ref, sha256, bytes });
        const visualProfileJson = (value: unknown): string => {
         const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort((item as Record<string, unknown>)[key])])) : item;
         return JSON.stringify(sort(value ?? {}));
        };
        const effectiveVisualProfile = (profile: Record<string, unknown>) => config.desktop?.visual.mask_selectors
          ? { ...profile, __umb_mask_policy_v1: `sha256-v1:${createHash('sha256').update(JSON.stringify(config.desktop.visual.mask_selectors)).digest('hex')}` }
          : profile;
       const verifyImage = (service: DesktopService, ref: string, sha256: string, bytes: number) => service.readArtifact(ref, sha256, bytes);
       const captureDimensions = (capture: Record<string, any>) => ({ width: capture.dimensions.width as number, height: capture.dimensions.height as number });
        desktopImageTool('desktop_baseline_save', 'Capture and save an immutable desktop visual baseline. Requires an affirmative server-side approver callback; approval_attestation is caller-reported intent, not proof of human approval or image inspection.', z.object({ baseline_key: baselineKeySchema, kind: z.enum(['window','webview']).optional(), profile: profileSchema, approval_attestation: z.literal('approved'), replace: z.boolean().optional(), expected_revision: z.number().int().positive().optional() }).strict(), async (a, service) => {
          if (!options.approver) throw Error('approval_denied: affirmative server-side approval is unavailable; caller attestation alone is not proof of human approval.');
         const latest = store.getDesktopBaseline(a.baseline_key) as Record<string, any> | null;
         if (latest && (a.replace !== true || a.expected_revision !== latest.revision)) throw Error('revision_conflict: replacing a baseline requires replace=true and its current expected_revision.');
         if (!latest && (a.replace === true || a.expected_revision !== undefined)) throw Error('revision_conflict: a new baseline cannot specify replacement confirmation or expected_revision.');
         const prompt = `Approve capturing and saving desktop baseline ${a.baseline_key}${latest ? ` as replacement revision ${Number(latest.revision) + 1} (current revision ${latest.revision})` : ''}? approval_attestation="approved" is caller-reported intent, not proof of human approval. [y/N] `;
          if (!await options.approver(prompt)) throw Error('approval_denied: server-side approval was declined.');
         const kind: CaptureKind = a.kind ?? config.desktop!.window.screenshot_mode;
          const capture = await captureWithProfile(service, kind, a.profile);
         const ref = capture.artifact_ref as string, sha256 = capture.sha256 as string, bytes = capture.byte_length as number;
         try {
           await verifyImage(service, ref, sha256, bytes);
           const dimensions = captureDimensions(capture);
            const saved = store.saveDesktopBaseline({ baselineKey: a.baseline_key, captureKind: kind, profile: effectiveVisualProfile(a.profile), artifact: artifactRecord(ref, sha256, bytes), ...dimensions, approval_attestation: 'approved', ...(a.replace !== undefined ? { replace: a.replace } : {}), ...(a.expected_revision !== undefined ? { expectedRevision: a.expected_revision } : {}) });
           return { ...saved, bytes: capture.bytes };
          } catch (error) { await rollbackArtifacts(service, error, [ref]); }
       });
       desktopTool('desktop_baseline_read', 'Read a saved desktop baseline and verify that its PNG evidence still matches its recorded hash and length.', z.object({ baseline_key: baselineKeySchema, revision: z.number().int().positive().optional() }).strict(), async (a, service) => {
         const baseline = store.getDesktopBaseline(a.baseline_key, a.revision) as Record<string, any> | null;
         if (!baseline) throw Error('Desktop baseline not found.');
         await verifyImage(service, String(baseline.artifact_ref), String(baseline.artifact_sha256), Number(baseline.artifact_bytes));
         return baseline;
       });
       desktopImageTool('desktop_compare_screenshots', 'Capture a same-kind/profile screenshot, compare it with the latest baseline, and persist before/after/diff evidence. Pixel metrics describe change only and do not prove quality or finding resolution.', z.object({ baseline_key: baselineKeySchema, kind: z.enum(['window','webview']).optional(), profile: profileSchema, threshold: z.number().int().min(0).max(255).optional(), finding_ids: z.array(z.string().min(1).max(100)).max(50).optional() }).strict(), async (a, service) => {
         const baseline = store.getDesktopBaseline(a.baseline_key) as Record<string, any> | null;
         if (!baseline) throw Error('Desktop baseline not found.');
         const kind: CaptureKind = a.kind ?? config.desktop!.window.screenshot_mode;
          const profile = effectiveVisualProfile(a.profile);
         if (baseline.capture_kind !== kind || String(baseline.profile_json) !== visualProfileJson(profile)) throw Error('Comparison capture kind and profile must exactly match the latest baseline.');
         const beforeBytes = await verifyImage(service, String(baseline.artifact_ref), String(baseline.artifact_sha256), Number(baseline.artifact_bytes));
         let afterRef: string | undefined, diffRef: string | undefined;
         try {
            const after = await captureWithProfile(service, kind, profile);
           afterRef = String(after.artifact_ref);
           const afterBytes = await verifyImage(service, afterRef, String(after.sha256), Number(after.byte_length));
           const compared = comparePngs(beforeBytes, afterBytes, { threshold: a.threshold ?? 0 });
           const generated = await service.saveGeneratedArtifact(compared.diff);
           diffRef = generated.artifactRef;
           await verifyImage(service, diffRef, generated.sha256, generated.byteLength);
             const comparison = store.createDesktopVisualComparison({ baselineKey: a.baseline_key, baselineRevision: Number(baseline.revision), captureKind: kind, profile, after: artifactRecord(afterRef, String(after.sha256), Number(after.byte_length)), diff: artifactRecord(diffRef, generated.sha256, generated.byteLength), metrics: { ...compared.metrics }, findingIds: a.finding_ids });
           return { comparison, baseline_ref: baseline.artifact_ref, after_ref: afterRef, diff_ref: diffRef, metrics: compared.metrics, imageBundle: [{ name: 'baseline', bytes: beforeBytes }, { name: 'after', bytes: afterBytes }, { name: 'diff', bytes: compared.diff }] };
          } catch (error) {
            await rollbackArtifacts(service, error, [afterRef ?? '', diffRef ?? '']);
         }
       });
        desktopTool('desktop_finding_report', 'Record a bounded caller-reported visual finding linked to a verified managed screenshot; UMB does not inspect or author the finding.', z.object({ screen: z.string().min(1).max(200), severity: z.enum(['low','medium','high','critical']), confidence: z.number().min(0).max(1), category: z.string().min(1).max(64), observed_issue: z.string().min(1).max(4000), screenshot_ref: z.string().min(1).max(1024), screenshot_sha256: z.string().regex(/^[a-f0-9]{64}$/i), screenshot_bytes: z.number().int().positive(), region: z.record(z.unknown()).optional(), selector: z.string().max(500).optional(), remediation: z.string().max(2000).optional(), verification_method: z.string().max(2000).optional() }).strict(), async (a, service) => {
          await verifyImage(service, a.screenshot_ref, a.screenshot_sha256, a.screenshot_bytes);
          return store.createDesktopVisualFinding({ screen: a.screen, severity: a.severity, confidence: a.confidence, category: a.category, observedIssue: a.observed_issue, screenshot: artifactRecord(a.screenshot_ref, a.screenshot_sha256, a.screenshot_bytes), ...(a.region !== undefined ? { region: a.region } : {}), ...(a.selector !== undefined ? { selector: a.selector } : {}), ...(a.remediation !== undefined ? { remediation: a.remediation } : {}), ...(a.verification_method !== undefined ? { verificationMethod: a.verification_method } : {}) });
        }, true, false);
       desktopTool('desktop_finding_list', 'List project-scoped visual findings by optional status and bounded limit.', z.object({ status: z.enum(['open','in_progress','resolved','reopened']).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), a => store.listDesktopVisualFindings(a));
       desktopTool('desktop_finding_update', 'Record a caller-reported finding transition using expected-version compare-and-swap. Resolution requires linked, hash-verified comparison evidence and an explicit caller assessment; pixel differences do not prove resolution.', z.object({ id: z.string().min(1).max(100), expected_version: z.number().int().positive(), status: z.enum(['in_progress','resolved','reopened']), note: z.string().max(2000).optional(), assessment: z.string().max(2000).optional(), comparison_id: z.string().min(1).max(100).optional() }).strict(), async (a, service) => {
         if (a.status === 'resolved') {
           if (!a.comparison_id || !a.assessment) throw Error('Resolution requires a linked comparison and caller-reported assessment.');
           const comparison = store.getDesktopComparison(a.comparison_id) as Record<string, any> | null;
           if (!comparison || !Array.isArray(comparison.finding_ids) || !comparison.finding_ids.includes(a.id)) throw Error('The supplied comparison is not linked to this finding.');
           const baseline = store.getDesktopBaseline(String(comparison.baseline_key), Number(comparison.baseline_revision)) as Record<string, any> | null;
           if (!baseline) throw Error('Comparison baseline evidence record is missing.');
           await verifyImage(service, String(baseline.artifact_ref), String(baseline.artifact_sha256), Number(baseline.artifact_bytes));
           await verifyImage(service, String(comparison.after_ref), String(comparison.after_sha256), Number(comparison.after_bytes));
           await verifyImage(service, String(comparison.diff_ref), String(comparison.diff_sha256), Number(comparison.diff_bytes));
         }
         return store.updateDesktopVisualFinding({ id: a.id, expectedVersion: a.expected_version, status: a.status, ...(a.note !== undefined ? { note: a.note } : {}), ...(a.assessment !== undefined ? { assessment: a.assessment } : {}), ...(a.comparison_id !== undefined ? { comparisonId: a.comparison_id } : {}) });
       });
         desktopImageTool('desktop_review_ui', 'Capture a screenshot and bounded UI evidence for an image-capable agent to review. This tool does not generate subjective visual findings or claim the image was viewed.', z.object({ kind: z.enum(['window','webview']).optional(), screen: z.string().max(200).optional(), design_guidance: z.string().max(4000).optional(), max_nodes: z.number().int().min(1).max(300).optional() }).strict(), async (a, service) => {
         const kind: CaptureKind = a.kind ?? config.desktop!.window.screenshot_mode;
         let uiTree: unknown[] = [], structureWarning: string | undefined;
         try { uiTree = await service.tree(a.max_nodes); } catch { structureWarning = 'WebView structure was unavailable; review the attached image without attributing findings to DOM evidence.'; }
         return captureDesktop(service, kind, {
           run_id: randomUUID(), screen: a.screen ?? 'current', design_guidance: a.design_guidance ?? null,
           ui_tree: uiTree, ...(structureWarning ? { structure_warning: structureWarning } : {}),
           findings: [], visual_assessment_performed: false,
             notice: 'UMB collects evidence only. An image-capable agent or human must inspect the attached image and produce any visual findings.',
            });
          });
       strictTool('jira_publish_screenshot_table','Publish a screenshot table to one exact issue_key and HTTPS Jira Cloud site origin. Provide headers (2–6 strings) and rows (1–25 arrays of plain-text cells); every row must match header width. Supply either legacy image_path + image_cell or images (1–25 objects with image_path and zero-based image_cell row/column); do not mix forms. Images may share a cell. Paths are relative to configured artifacts.directory and must resolve within .umb-managed. Cells are NFC-normalized, max 500 characters, and allow only Unicode letters/numbers/marks, spaces, and . , : ; ASCII apostrophe and quotation mark, and parentheses; markup punctuation, URLs, controls, and line breaks are rejected. Writes to any Jira project require exact task-specific user authorization naming the exact issue, site, and operation. Dry-run is default; network writes require BOTH write=true and experimental_inline_wiki=true. Inline table rendering is experimental and must be verified.',z.object({issue_key:z.string().min(1).max(25),site:z.string().min(1).max(300),image_path:z.string().min(1).max(1024).optional(),image_cell:z.object({row:z.number().int().min(0).max(24),column:z.number().int().min(0).max(5)}).strict().optional(),images:z.array(z.object({image_path:z.string().min(1).max(1024),image_cell:z.object({row:z.number().int().min(0).max(24),column:z.number().int().min(0).max(5)}).strict()}).strict()).min(1).max(25).optional(),headers:z.array(z.string().max(500)).min(2).max(6),rows:z.array(z.array(z.string().max(500)).max(6)).min(1).max(25),write:z.boolean().default(false),experimental_inline_wiki:z.boolean().default(false)}).strict().refine(a=>Boolean(a.images) !== Boolean(a.image_path && a.image_cell) && (a.images ? !a.image_path && !a.image_cell : Boolean(a.image_path) && Boolean(a.image_cell)),'Provide either images or image_path with image_cell, but not both.'),async a=>publishJiraScreenshotComment(config,options.projectRoot??process.cwd(),{issueKey:a.issue_key,site:a.site,image:a.images?.[0]?.image_path??a.image_path!,images:a.images?.map((image: { image_path: string; image_cell: { row: number; column: number } })=>({image:image.image_path,imageCell:image.image_cell})),tableData:{headers:a.headers,rows:a.rows,imageCell:a.images?.[0]?.image_cell??a.image_cell},write:a.write,experimentalInlineWiki:a.experimental_inline_wiki,structuredResult:true},options.jiraFetch));
     const browserTool = (name: string, description: string, schema: any, fn: (args: any) => unknown | Promise<unknown>) =>
       tool(name, description, schema, args => runBrowser(() => { assertApplicationReady(); return Promise.resolve(fn(args)); }));
     const target = z.object({ by: z.enum(['ref', 'role', 'label', 'placeholder', 'test_id', 'text', 'css']), value: z.string().max(1000).optional(), role: z.string().max(100).optional(), name: z.string().max(500).optional() }).strict();
    browserTool('memory_recall','Bounded trusted workflow recommendations; YAML-only workflows are labeled authored_unverified guidance',{goal:z.string().max(200),role:z.string().max(120).optional(),environment:z.string().max(100).optional()},async a=>{const result:any=await store.recallWorkflowCandidates({goal:a.goal,currentUrl:browser.page.url(),...(a.role!==undefined?{role:a.role}:{}),...(a.environment!==undefined?{environment:a.environment}:{}),limit:3,trustYamlSeeds:config.memory.trust_yaml_seeds});const candidates=Array.isArray(result)?result:Array.isArray(result?.candidates)?result.candidates:[];const reasons=new Set(['current_screen_is_start','directed_path_to_start','safe_goal_match','role_match','role_context_missing','environment_match','environment_context_missing']);const safeCandidates=candidates.slice(0,3).flatMap((candidate:any)=>{if(!candidate||typeof candidate.workflow_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(candidate.workflow_id))return[];const citations=Array.isArray(candidate.citations)?candidate.citations.slice(0,5).flatMap((c:any)=>c&&typeof c.run_id==='string'&&typeof c.evidence_id==='string'&&['passed','failed','other'].includes(c.status)?[{run_id:c.run_id.slice(0,100),evidence_id:c.evidence_id.slice(0,100),status:c.status}]:[]):[];const counts=candidate.outcome_counts&&typeof candidate.outcome_counts==='object'?{passed:Number.isInteger(candidate.outcome_counts.passed)?Math.max(0,Math.min(100000,candidate.outcome_counts.passed)):0,failed:Number.isInteger(candidate.outcome_counts.failed)?Math.max(0,Math.min(100000,candidate.outcome_counts.failed)):0,other:Number.isInteger(candidate.outcome_counts.other)?Math.max(0,Math.min(100000,candidate.outcome_counts.other)):0}:undefined;const trust=['verified_fact','trusted_seed','authored_unverified'].includes(candidate.trust_basis)?candidate.trust_basis:'authored_unverified';return[{workflow_id:candidate.workflow_id,trust_basis:trust,trust_status:trust,...(trust==='authored_unverified'?{guidance_warning:'Authored YAML workflow is unverified; revalidate routes and steps against the current application before acting.'}:{}),...(typeof candidate.score==='number'&&Number.isFinite(candidate.score)?{score:candidate.score}:{}),...(typeof candidate.confidence==='number'&&Number.isFinite(candidate.confidence)?{confidence:Math.max(0,Math.min(1,candidate.confidence))}:{}),...(Number.isInteger(candidate.step_count)?{step_count:Math.max(0,Math.min(100,candidate.step_count))}:{}),...(Array.isArray(candidate.reason_codes)?{reason_codes:candidate.reason_codes.filter((reason:unknown)=>typeof reason==='string'&&reasons.has(reason)).slice(0,10)}:{}),...(counts?{outcome_counts:counts}:{}),citations,...(candidate.uncertainty!==undefined&&typeof candidate.uncertainty==='string'?{uncertainty:candidate.uncertainty.slice(0,200)}:{})}];});return{candidates:safeCandidates,...(result&&!Array.isArray(result)&&typeof result.uncertainty==='string'?{uncertainty:result.uncertainty.slice(0,200)}:{})};});
      tool('browser_status', 'Current browser state and application readiness', {}, () => browserStatus());
      tool('browser_refresh', 'Retry navigation to the configured application URL', {}, () => runBrowser(async () => {
        try { await browser.navigate(config.project.base_url, 'domcontentloaded', 10000); applicationReady = true; return await browserStatus(); }
        catch { applicationReady = false; throw Error('Application is not reachable at the configured base URL. Start the application and retry browser_refresh.'); }
      }));
     browserTool('browser_errors','Read bounded safe browser diagnostics',{after:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional()},a=>browser.browserErrors(a.after??0,a.limit??100));
     browserTool('browser_navigate', 'Navigate to an allowed origin', { url: z.string().max(4096), wait_until: z.enum(['load','domcontentloaded','networkidle','commit']).optional(), timeout_ms:z.number().int().min(1).max(60000).optional(), expected_revision:z.number().int().nonnegative().optional() }, a => {if(a.expected_revision!==undefined&&a.expected_revision!==browser.revision)throw Error('State revision conflict');return browser.navigate(a.url,a.wait_until,a.timeout_ms);});
     browserTool('browser_set_viewport','Set the active page viewport dimensions',{width:z.number().int().min(1).max(10000),height:z.number().int().min(1).max(10000)},a=>browser.setViewport(a.width,a.height));
    browserTool('browser_screenshot','Capture a screenshot',{full_page:z.boolean().optional(),file_name:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).optional()},a=>browser.takeScreenshot(a.full_page,a.file_name));
    browserTool('browser_snapshot', 'Visible page controls', { mode: z.enum(['interactive','compact','full']).optional(), depth: z.number().int().min(1).max(8).optional(), scope: z.object({role:z.string().max(100),name:z.string().max(500).optional()}).optional() }, a => browser.snapshot(a));
    browserTool('browser_find', 'Check semantic locator', { by: z.enum(['role', 'label', 'placeholder', 'test_id', 'text', 'css']), value: z.string().max(1000).optional(), role: z.string().max(100).optional(), name: z.string().max(500).optional() }, a => browser.find(a));
    const authorize=async(action:string,t:any,revision:number|undefined,session:Session)=>{const rules=config.security?.high_risk??[];if((action==='keyboard'||rules.some(r=>r.action==='any'))&&!t&&rules.some(r=>r.action==='any'||r.action==='keyboard'))throw Error('approval_denied: explicit target required');if(!t)return undefined;const requested=await browser.captureVisibleTarget(t);if(!requested)return undefined;let retained=false;try{const origin=new URL(browser.page.url()).origin;const matched=[] as typeof rules;for(const r of rules){if((r.action!=='any'&&r.action!==action)||r.origin&&r.origin!==origin)continue;if(await browser.sameElement(requested,r.target))matched.push(r);}if(!matched.length)return undefined;if(revision===undefined||revision!==browser.revision)throw Error('revision_conflict: current expected_revision required');const rule=matched[0]!;if(!options.approver)throw Error('approval_denied: local TTY approval unavailable');const yes=await options.approver(`Approve ${action} on configured target (${rule.description}) at ${origin}, revision ${revision}, session ${session.id}? [y/N] `);if(!yes)throw Error('approval_denied: request declined');if(session.closed||!sessions.has(session.id)||revision!==browser.revision||origin!==new URL(browser.page.url()).origin||!await browser.capturedTargetUsable(requested)||!await browser.sameElement(requested,t)||!await browser.sameElement(requested,rule.target))throw Error('approval_denied: browser state or target changed');retained=true;return{handle:requested,release:()=>requested.dispose()};}finally{if(!retained)await requested.dispose();}};
    for (const action of ['click', 'fill', 'press', 'select','type']) browserTool(`browser_${action}`, `Perform unique visible ${action}`, { target, value: z.string().max(10000).optional(), delay:z.number().int().min(0).max(1000).optional(), expected_revision: z.number().int().nonnegative().optional() }, async a => {
      if (a.expected_revision !== undefined && a.expected_revision !== browser.revision) throw Error('State revision conflict');const approval=await authorize(action,a.target,a.expected_revision,session);try{return approval?await browser.performCaptured(action,approval.handle,a.value,a.delay):action==='type'?browser.type(a.target,a.value??'',a.delay):browser.act(action, a.target, a.value);}finally{await approval?.release();}
    });
    browserTool('browser_keyboard','Press a keyboard key',{key:z.string().min(1).max(100),target:target.optional(),expected_revision:z.number().int().nonnegative().optional()},async a=>{if(a.expected_revision!==undefined&&a.expected_revision!==browser.revision)throw Error('State revision conflict');const approval=await authorize('keyboard',a.target,a.expected_revision,session);try{return approval?await browser.performCaptured('keyboard',approval.handle,a.key):browser.keyboard(a.key,a.target);}finally{await approval?.release();}});
    browserTool('browser_upload','Upload a project file to a target',{target,project_relative_path:z.string().min(1).max(1024),expected_revision:z.number().int().nonnegative().optional()},async a=>{if(a.expected_revision!==undefined&&a.expected_revision!==browser.revision)throw Error('State revision conflict');const approval=await authorize('upload',a.target,a.expected_revision,session);try{return approval?await browser.uploadCaptured(approval.handle,a.project_relative_path):browser.upload(a.target,a.project_relative_path);}finally{await approval?.release();}});
      const configuredAuthId=config.application_auth?.mode==='workflow'?config.application_auth.workflow_id:undefined;
      strictTool('desktop_run_workflow','Run a supported CSS-only YAML workflow against this MCP session’s already-running managed Tauri session. Requires the exact desktop session ID and never starts a service.',z.object({workflow_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/),role:z.string().max(125).optional(),environment:z.string().max(100).optional(),expected_session_id:z.string().min(1).max(200)}).strict(),a=>runDesktop(async()=>{
        if(config.desktop?.enabled!==true)throw Error('Desktop testing is disabled.');
        const service=desktopService;
        if(!service)throw Error('No managed desktop session is running.');
        let status;
        try{status=await service.status();}catch{throw Error('No managed desktop session is running.');}
        if(status.state!=='running'||status.id!==a.expected_session_id)throw Error('Desktop session identity mismatch.');
        const auth=a.workflow_id===configuredAuthId;
        const driver=createDesktopWorkflowDriver({service,role:a.role,environment:a.environment,highRiskRules:config.security?.high_risk});
        return runWorkflowWithDriver({store,session,workflowId:a.workflow_id,backend:'tauri',role:a.role,environment:a.environment,knowledgeRoot,...(auth?{safeOutcome:true,disableFailureCapture:true}:{}),captureDesktopFailure:async()=>{
          if(config.desktop?.enabled!==true||config.desktop.visual.capture_on_failure!==true)return{status:'disabled' as const};
          try{
            await beforeDesktopOperation(service);
            const capture=await captureDesktop(service,'webview');
            if(typeof capture.artifact_ref!=='string')return{status:'capture_failed' as const};
            const redaction=capture.redaction??{};
            return{status:'captured' as const,artifactRef:capture.artifact_ref,redaction:{applied:redaction.applied===true,method:typeof redaction.method==='string'?redaction.method.slice(0,80):'unknown',scope:typeof redaction.scope==='string'?redaction.scope.slice(0,240):'unknown',warning:typeof redaction.warning==='string'?redaction.warning.slice(0,400):'No general PII-redaction guarantee.'}};
          }catch(error){return{status:hasArtifactCleanupFailure(error)?'cleanup_failed' as const:'capture_failed' as const};}
        },removeDesktopFailureArtifact:async ref=>{try{await service.removeArtifact(ref);return'removed';}catch{return'failed';}}},driver);
      }),true);
       const safeAuthWorkflow=(workflowId:string,expectedRevision:number|undefined)=>{if(expectedRevision===undefined)return Promise.resolve({status:'failed',errorCode:'revision_conflict'});const current=store.currentYamlWorkflow(workflowId),snapshot=store.workflowSnapshotHash(workflowId);if(!current||!snapshot)return Promise.resolve({status:'failed',errorCode:'precondition_failed'});return runBrowser(()=>{assertApplicationReady();return runWorkflow({store,browser,session,workflowId,expectedRevision,knowledgeRoot,disableFailureCapture:true,safeOutcome:true,authorize:(action,target,revision)=>authorize(action,target,revision,session)});});};
       const applicationAuth=config.application_auth;if(applicationAuth){strictTool('application_sign_in','Sign in manually or run the configured YAML sign-in workflow',z.object({expected_revision:z.number().int().nonnegative().optional()}).strict(),a=>{assertApplicationReady();if(applicationAuth.mode==='interactive')return{status:'manual_required'};return safeAuthWorkflow(applicationAuth.workflow_id,a.expected_revision);});}
       tool('test_run_workflow','Run a YAML-authored deterministic workflow',{workflow_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/),role:z.string().max(125).optional(),environment:z.string().max(100).optional(),expected_revision:z.number().int().nonnegative()},a=>{const auth=a.workflow_id===configuredAuthId;return runBrowser(()=>{assertApplicationReady();return runWorkflow({store,browser,session,workflowId:a.workflow_id,role:a.role,environment:a.environment,expectedRevision:a.expected_revision,knowledgeRoot,...(auth?{disableFailureCapture:true,safeOutcome:true}:{}),captureDesktopFailure:async()=>{if(config.desktop?.enabled!==true||config.desktop.visual.capture_on_failure!==true)return{status:'disabled' as const};if(!desktopService)return{status:'unavailable' as const};try{return await runDesktop(async()=>{await beforeDesktopOperation(desktopService!);const result=await captureDesktop(desktopService!,'webview');if(typeof result.artifact_ref!=='string')return{status:'capture_failed' as const};const redaction=result.redaction??{};return{status:'captured' as const,artifactRef:result.artifact_ref,redaction:{applied:redaction.applied===true,method:typeof redaction.method==='string'?redaction.method.slice(0,80):'unknown',scope:typeof redaction.scope==='string'?redaction.scope.slice(0,240):'unknown',warning:typeof redaction.warning==='string'?redaction.warning.slice(0,400):'No general PII-redaction guarantee.'}};});}catch(error){return{status:hasArtifactCleanupFailure(error)?'cleanup_failed' as const:'capture_failed' as const};}},removeDesktopFailureArtifact:async(ref)=>{if(!desktopService)return'unavailable';try{await runDesktop(()=>desktopService!.removeArtifact(ref));return'removed';}catch{return'failed';}},authorize:(action,target,revision)=>authorize(action,target,revision,session)});});});
    browserTool('browser_scroll', 'Scroll page', { direction: z.enum(['up', 'down']), amount: z.number().int().min(1).max(3000).optional() }, a => browser.scroll(a.direction, a.amount));
    browserTool('browser_wait_for','Wait for a bounded browser condition',{condition:z.enum(['visible','hidden','attached','detached','enabled','url']),target:z.union([target,z.string().max(2048)]).optional(),timeout_ms:z.number().int().min(1).max(10000).optional()},a=>browser.waitFor(a.condition,a.target,a.timeout_ms));
    browserTool('browser_tabs','List open tabs',{},()=>browser.listTabs());browserTool('browser_tab_select','Select a tab',{id:z.string().max(100)},a=>browser.selectTab(a.id));browserTool('browser_tab_create','Create a tab',{url:z.string().max(4096).optional()},a=>browser.createTab(a.url));browserTool('browser_tab_close','Close a tab',{id:z.string().max(100).optional()},a=>browser.closeTab(a.id));browserTool('browser_back','Go back',{},()=>browser.back());browserTool('browser_forward','Go forward',{},()=>browser.forward());
      tool('memory_context', 'Project knowledge context, including saved MCP learnings; authored YAML is separately labeled guidance by default', {}, () => store.context({trustYamlSeeds:config.memory.trust_yaml_seeds})); tool('memory_search', 'Bounded ranked search of project knowledge, including automatically reusable MCP learnings. Query-only calls return the first page; use pagination.next_cursor to continue.', { query: z.string(), mode:z.enum(['auto','exact','prose']).optional(),page_size:z.number().int().min(1).max(50).optional(),cursor:z.string().max(2048).optional() }, a => store.searchPage(a.query,{trustYamlSeeds:config.memory.trust_yaml_seeds,mode:a.mode,page_size:a.page_size,cursor:a.cursor}));
       tool('memory_get_node', 'Read a trusted knowledge node, including saved MCP learnings', { id: z.string().max(100) }, a => store.getTrustedNode(a.id,{trustYamlSeeds:config.memory.trust_yaml_seeds}));
        tool('memory_save','Save an agent learning to this project and environment. A successful save is immediately persistent and available through normal memory retrieval.',{content:z.string().min(1).max(20000),title:z.string().min(1).max(500).optional()},a=>{if(!config.memory.persistent_learning_writes)throw Error('Persistent learning writes are disabled for this project; set memory.persistent_learning_writes: true in umb.config.yaml and restart UMB.');if(!options.learningWriter)throw Error('NLP sidecar request failed');return options.learningWriter.save(a.content,a.title);});
      tool('test_assert','Evaluate and record a safe browser assertion; on PASS returns the evidence identity (evidence_id, run_id, subject_node_id); failed assertions omit evidence_ref.',{condition:z.enum(['visible','hidden','enabled','text','url_matches','count','value','present']),target:target.optional(),expected:z.union([z.string().max(1000),z.number()]).optional(),match:z.enum(['contains','exact']).optional(),timeout_ms:z.number().int().min(1).max(30000).optional(),subject_node_id:z.string().min(1).max(64).optional()},a=>runBrowser(async()=>{assertApplicationReady();const subject=a.subject_node_id??store.applicationSubject()?.id;if(!subject||!store.get(subject))throw Error('Assertion subject must belong to this project');const result=await (browser as any).assertCondition(a.condition,a.target,a.expected,a.timeout_ms??5000,a.match??'contains');let artifact:string|undefined,capture:{status:'captured'|'failed';code?:'quota_exceeded'|'capture_failed'}|undefined;let safeSummary:Record<string,number>={};let actions:unknown[]=[];if(!result.passed){try{artifact=(await browser.takeScreenshot(false)).artifactPath;capture={status:'captured'};}catch(error){capture={status:'failed',code:/quota|limit/i.test(String(error))?'quota_exceeded':'capture_failed'};}try{const snapshot=await browser.snapshot({mode:'interactive'}) as any;for(const element of snapshot.elements??[])safeSummary[element.role??'unknown']=(safeSummary[element.role??'unknown']??0)+1;}catch{}actions=(browser as any).actionSequence(30).map((x:any)=>({action:x.action,at:x.at,target_by:x.target_by,revision:x.revision}));}const record=store.recordAssertion({session_id:session.id,subject_node_id:subject,passed:result.passed,observed_count:result.observedCount,artifact_ref:artifact,actions});const evidence=record.evidence as any;if(!result.passed)store.addAssertionDiagnostics({runId:record.id,evidenceId:evidence.id,roleCounts:safeSummary,capture:capture!});return{status:result.passed?'PASS':'FAIL',run_id:record.id,passed:result.passed,observed_count:result.observedCount,capture,artifact_ref:artifact??null,evidence_refs:result.passed?[{evidence_id:evidence.id,run_id:record.id,subject_node_id:subject}]:[]};}));
     tool('test_report','Read a project-scoped safe test report',{run_id:z.string().min(1).max(100)},a=>store.getRunReport(a.run_id));
      tool('memory_neighbors','List neighbors connected by live project knowledge, including saved MCP learnings',{id:z.string().min(1).max(100),limit:z.number().int().min(1).max(200).optional()},a=>store.neighbors(a.id,a.limit,{trustYamlSeeds:config.memory.trust_yaml_seeds}));
      tool('memory_path','Find a bounded directed path over live NAVIGATES_TO memory edges, including saved MCP learnings',{from_id:z.string().min(1).max(100),to_id:z.string().min(1).max(100),max_depth:z.number().int().min(0).max(10).optional()},a=>store.path(a.from_id,a.to_id,a.max_depth,{trustYamlSeeds:config.memory.trust_yaml_seeds}));
     tool('memory_record_outcome','Record a bounded run outcome for a node',{subject_node_id:z.string().min(1).max(100),outcome:z.enum(['passed','failed','observed','skipped']),metadata:z.object({environment:z.enum(['local','staging','production']).optional(),browser:z.enum(['chromium','firefox','webkit']).optional(),duration_ms:z.number().int().min(0).max(10000000).optional(),attempt:z.number().int().min(1).max(100).optional()}).strict().optional(),artifact_ref:z.string().max(1000).optional()},a=>{const metadata=a.metadata??{};const runId=store.createRun();try{const evidence=store.addEvidence({run_id:runId,subject_node_id:a.subject_node_id,kind:'outcome',outcome:a.outcome,metadata,artifact_ref:a.artifact_ref});store.finishRun(runId);return{run_id:runId,evidence};}catch(error){store.finishRun(runId,'failed');throw error;}});
    tool('memory_stats','Project memory statistics',{},()=>store.stats());
     tool('memory_conflicts','Read-only unverified/conflict review. Entity keys are omitted; conflicts are not verified facts.',{limit:z.number().int().min(1).max(200).optional()},()=>({label:'unverified_conflict_review',items:store.listConflicts().slice(0,200).map((item:any)=>({kind:item.kind,id:item.id,conflict_status:item.conflict_status}))}));
    tool('memory_export', 'Export trusted graph records only', {}, () => store.export({trustYamlSeeds:config.memory.trust_yaml_seeds}));
    const jsonResource=(uri:string,data:unknown)=>({contents:[{uri,mimeType:'application/json',text:JSON.stringify(data).slice(0,64000)}]});
    mcp.registerResource('project-current','umb://project/current',{mimeType:'application/json'},uri=>jsonResource(uri.href,{project_id:config.project.id,name:config.project.name,base_url:config.project.base_url}));
     mcp.registerResource('browser-current','umb://browser/current',{mimeType:'application/json'},async uri=>jsonResource(uri.href,await browserStatus()));
    for(const kind of ['screen','workflow']){const template=new ResourceTemplate(`umb://memory/${kind}/{id}`,{list:undefined});mcp.registerResource(`memory-${kind}`,template,{mimeType:'application/json'},(uri,vars)=>{const record=store.getByTypeKey(kind,String(vars.id)),trusted=record?store.getTrustedNode((record as any).id,{trustYamlSeeds:config.memory.trust_yaml_seeds}):null;if(!trusted)throw Error('Unknown trusted memory resource');return jsonResource(uri.href,trusted);});}
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: id => { session.id = id; sessions.set(id, session); armIdle(session); },
       onsessionclosed: async id => {
         session.closed = true;
         if (session.timer) clearTimeout(session.timer);
         session.timer = undefined;
         sessions.delete(id);
         try { await session.cleanup?.(); } finally { await (session.serverClosePromise ??= mcp.close()); }
       }
    });
    return session;
  }

  if (options.stdio) {
    const session = createSession();
    session.id = randomUUID();
    sessions.set(session.id, session);
    const transport = new StdioServerTransport();
    session.transport = transport;
    await session.server.connect(transport);
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      closing = true;
      session.closed = true;
      if (session.timer) clearTimeout(session.timer);
      session.timer = undefined;
      await transport.close();
      if (activeToolCalls > 0) await new Promise<void>(resolve => { toolDrain = resolve; });
      for (;;) { const queued = browserQueue; await queued; if (queued === browserQueue) break; }
      for (;;) { const queued = desktopQueue; await queued; if (queued === desktopQueue) break; }
      sessions.delete(session.id);
      try { await session.cleanup?.(); } finally { await session.server.close(); }
    };
  }

  const http = createServer(async (req, res) => {
    if(req.method==='POST')activePosts++;
    try {
      if (closing) { reply(res, 503, 'Server is shutting down'); return; }
      const expectedHost = `${config.server.host === '::1' ? '[::1]' : config.server.host}:${config.server.port}`;
      if ((req.headers.host ?? '').toLowerCase() !== expectedHost.toLowerCase()) { reply(res, 403, 'Forbidden Host'); return; }
      if (!originAllowed(req.headers.origin, Boolean(token), config.server.port)) { reply(res, 403, 'Forbidden Origin'); return; }
      if (token) {
        const auth = req.headers.authorization ?? '', provided = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : ''), expected = Buffer.from(token);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { reply(res, 401, 'Unauthorized'); return; }
      }
      if (req.url?.split('?')[0] !== '/mcp') { reply(res, 404, 'Not found'); return; }
      if (req.method === 'POST') {
        const accepted = (req.headersDistinct.accept ?? []).join(',').toLowerCase();
        if (!accepted.includes('application/json') || !accepted.includes('text/event-stream')) { reply(res, 406, 'MCP clients must accept application/json and text/event-stream'); return; }
        const sessionId = req.headers['mcp-session-id'];
        if (typeof sessionId !== 'string') {
          pendingInitializers++;
          try {
            let body: any;
            try { body = await readJsonBody(req); } catch (e) { reply(res, (e as Error).message === 'Request body too large' ? 413 : 400, (e as Error).message); return; }
            const messages = Array.isArray(body) ? body : [body];
            if (messages.length !== 1 || messages[0]?.method !== 'initialize') { reply(res, 400, 'A valid MCP session is required'); return; }
            if (closing) { reply(res, 503, 'Server is shutting down'); return; }
            const session = createSession(); await session.server.connect(session.transport);
            try { await session.transport.handleRequest(req, res, body); }
            finally { if (!session.id) { await session.transport.close(); await session.server.close(); } }
          } finally {
            pendingInitializers--;
            if (pendingInitializers === 0) { initializationDrain?.(); initializationDrain = undefined; }
          }
          return;
        }
        let body: any;
        try { body = await readJsonBody(req); } catch (e) { reply(res, (e as Error).message === 'Request body too large' ? 413 : 400, (e as Error).message); return; }
        const session = sessions.get(sessionId); if (!session || session.closed) { reply(res, 404, 'Unknown MCP session'); return; }
        armIdle(session); await session.transport.handleRequest(req, res, body);
        return;
      }
      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId !== 'string') { reply(res, 400, 'Mcp-Session-Id is required'); return; }
      const session = sessions.get(sessionId); if (!session) { reply(res, 404, 'Unknown MCP session'); return; }
      if (req.method !== 'GET' && req.method !== 'DELETE') { reply(res, 405, 'Method not allowed'); return; }
      armIdle(session);
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error('MCP request failed');
      reply(res, 500, 'MCP request failed');
    } finally {
      if(req.method==='POST'){activePosts--;if(activePosts===0){postDrain?.();postDrain=undefined;}}
    }
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(config.server.port, config.server.host, resolve); });
  let knowledgeWatcher:ReturnType<typeof startKnowledgeWatcher>|undefined;
  if(options.watchKnowledge){try{const watcherRoot=await safePath(options.projectRoot??process.cwd(),knowledgeRoot);knowledgeWatcher=startKnowledgeWatcher(watcherRoot,async()=>{if(closing)return;await runBrowser(async()=>{try{if(!options.learningWriter)throw new Error('NLP sidecar request failed');await reconcile(watcherRoot,store,options.learningWriter);}catch{console.error('Knowledge reload failed; the last valid graph remains active.');}});},{factory:options.watcherFactory,debounceMs:options.watchDebounceMs,onError:message=>console.error(message)});}catch{closing=true;await new Promise<void>(resolve=>http.close(()=>resolve()));throw Error('Knowledge watcher could not start safely');}}
  return async () => {
    closing = true;
    const listenerClosed = new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve()));
    await knowledgeWatcher?.close();
    if (pendingInitializers > 0) await new Promise<void>(resolve => { initializationDrain = resolve; });
     if(activePosts>0)await new Promise<void>(resolve=>{postDrain=resolve;});
     for (;;) { const queued=browserQueue; await queued; if(queued===browserQueue)break; }
     for (;;) { const queued=desktopQueue; await queued; if(queued===desktopQueue)break; }
    const active = [...sessions.values()];
    await Promise.all(active.map(async s => { try { await closeSession(s); } catch (e) { console.error('MCP session shutdown failed', e); } }));
    await listenerClosed;
  };
}
