/** Provider-neutral browser operations required by MCP and browser workflows. */
export type BrowserTarget = {
  by: 'ref' | 'role' | 'label' | 'placeholder' | 'test_id' | 'text' | 'css';
  value?: string;
  role?: string;
  name?: string;
};

export type BrowserAction = 'click' | 'fill' | 'press' | 'select' | 'type' | 'keyboard';
export type BrowserWaitCondition = 'visible' | 'hidden' | 'attached' | 'detached' | 'enabled' | 'url';
export type BrowserAssertionCondition = 'visible' | 'hidden' | 'enabled' | 'text' | 'url_matches' | 'count' | 'value' | 'present';
export type BrowserSnapshotOptions = {
  mode?: 'interactive' | 'compact' | 'full';
  depth?: number;
  scope?: { role: string; name?: string };
};
export type BrowserStatus = {
  tabId: string;
  url: string;
  title: string;
  loading: boolean;
  pendingDialog: unknown;
  lastPageError: string | null;
  revision: number;
  viewport: { width: number; height: number } | null;
};
export type BrowserDiagnostic = {
  cursor: number;
  kind: 'console_error' | 'page_error' | 'request_failed' | 'http_error';
  at: number;
  tabId: string;
  revision: number;
  origin?: string;
  method?: string;
  status?: number;
  reason: string;
};
export type BrowserActionRecord = {
  action: string;
  at: number;
  target_by?: BrowserTarget['by'];
  revision: number;
};
export type BrowserAssertionResult = { passed: boolean; observedCount: number };
export type BrowserFindResult = {
  count: number;
  visible: boolean;
  error?: string;
  candidates?: Array<{ ref: string; role: string; name: string }>;
};
export type BrowserScreenshot = { artifactPath: string };

export type ScreenshotRequest={fullPage?:boolean;fileName?:string;kind?:'webview'|'window';profile?:Record<string,unknown>};
export type ScreenshotResult={artifactPath:string;artifactRef:string;sha256:string;bytes:number;width:number;height:number;captureKind:'webview'|'window';image?:Buffer};
export type RawScreenshotCapture={image:Buffer;width:number;height:number;captureKind:'webview'|'window'};
export type BaselineRequest={baselineKey:string;captureKind:'webview'|'window';profile?:Record<string,unknown>;approval_attestation:'approved';replace?:boolean;expectedRevision?:number};
export type BaselineReadRequest={baselineKey:string;revision?:number};
export type ComparisonRequest={baselineKey:string;captureKind:'webview'|'window';profile?:Record<string,unknown>;threshold?:number;findingIds?:string[]};
export type FindingsQuery={status?:'open'|'in_progress'|'resolved'|'reopened';limit?:number};
export type FindingInput={screen:string;severity:'low'|'medium'|'high'|'critical';confidence:number;category:string;observedIssue:string;screenshotRef:string;screenshotSha256:string;screenshotBytes:number;region?:Record<string,unknown>;selector?:string;remediation?:string;verificationMethod?:string};
export type FindingUpdate={id:string;status:'in_progress'|'resolved'|'reopened';note?:string;assessment?:string;comparisonId?:string};
export type VisualCapabilities={screenshotKinds:readonly ('webview'|'window')[];baselines:boolean;comparison:boolean;findings:boolean};
/** Optional, conservative workflow allow-list for adapters with a restricted execution surface. */
export type WorkflowCapabilities={actions:readonly string[];waits:readonly string[];assertions:readonly string[];locatorStrategies:readonly BrowserTarget['by'][];failureCapture:readonly ('screenshot'|'snapshot'|'console_errors')[];routeChecks:boolean;minimumStepTimeoutMs?:number;supportsPressKey?:(key:string)=>boolean};
export type BaselineResult=Record<string,unknown>&{image?:Buffer};
export type ComparisonResult=Record<string,unknown>&{imageBundle?:Array<{name:string;bytes:Buffer}>};
export type FindingsResult=Record<string,unknown>[];
export type FindingResult=Record<string,unknown>;
export interface VisualAdapter { readonly capabilities:VisualCapabilities; takeScreenshot(request:ScreenshotRequest):Promise<ScreenshotResult>; createBaseline(request:BaselineRequest):Promise<BaselineResult>; readBaseline(request:BaselineReadRequest):Promise<BaselineResult>; compareWithBaseline(request:ComparisonRequest):Promise<ComparisonResult>; listFindings(request:FindingsQuery):Promise<FindingsResult>; createFinding(request:FindingInput):Promise<FindingResult>; updateFinding(request:FindingUpdate&{expectedVersion:number}):Promise<FindingResult>; }

declare const capturedBrowserTargetBrand: unique symbol;
/** Opaque provider-owned reference to the exact visible DOM target captured for approval. */
export interface CapturedBrowserTarget {
  readonly [capturedBrowserTargetBrand]: true;
}

/** Rechecked by the provider at the final mutation boundary, not just when approval is granted. */
export type CapturedActionGuard = {
  expectedRevision: number;
  expectedOrigin: string;
  isSessionCurrent: () => boolean;
  targets: readonly BrowserTarget[];
};

export type CapturedBrowserApproval = {
  handle: CapturedBrowserTarget;
  guard: CapturedActionGuard;
  release: () => Promise<void>;
};

/** The MCP/browser-workflow browser contract. No provider object or provider-specific type crosses it. */
export interface BrowserAdapter extends VisualAdapter {
  readonly workflowCapabilities?:WorkflowCapabilities;
  readonly revision: number;
  start(): Promise<void>;
  close(): Promise<void>;
  currentUrl(): string;
  status(): Promise<BrowserStatus>;
  browserErrors(after?: number, limit?: number): { events: BrowserDiagnostic[]; next_cursor: number; oldest_cursor: number };
  navigate(url: string, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit', timeoutMs?: number): Promise<BrowserStatus>;
  createTab(url?: string): Promise<{ id: string } & BrowserStatus>;
  listTabs(): Promise<Array<{ id: string; url: string; active: boolean }>>;
  selectTab(id: string): Promise<BrowserStatus>;
  closeTab(id?: string): Promise<BrowserStatus>;
  back(): Promise<BrowserStatus>;
  forward(): Promise<BrowserStatus>;
  actionSequence(limit?: number): BrowserActionRecord[];
  assertCondition(condition: BrowserAssertionCondition, target?: BrowserTarget, expected?: string | number, timeoutMs?: number, match?: 'contains' | 'exact'): Promise<BrowserAssertionResult>;
  upload(target: BrowserTarget, projectRelativePath: string): Promise<BrowserStatus>;
  takeScreenshot(request:ScreenshotRequest):Promise<ScreenshotResult>;
  takeScreenshot(request:ScreenshotRequest|boolean,fileName?:string):Promise<ScreenshotResult|BrowserScreenshot>;
  takeScreenshot(fullPage?:boolean,fileName?:string):Promise<BrowserScreenshot>;
  captureScreenshotBytes(request:ScreenshotRequest):Promise<RawScreenshotCapture>;
  setViewport(width: number, height: number): Promise<BrowserStatus>;
  setActionTimeout(timeoutMs: number): void;
  consoleErrorCount(): number;
  snapshot(options?: BrowserSnapshotOptions): Promise<Record<string, unknown>>;
  find(target: BrowserTarget): Promise<BrowserFindResult>;
  captureVisibleTarget(target: BrowserTarget): Promise<CapturedBrowserTarget | undefined>;
  sameElement(handle: CapturedBrowserTarget, target: BrowserTarget): Promise<boolean>;
  capturedTargetUsable(handle: CapturedBrowserTarget): Promise<boolean>;
  releaseCapturedTarget(handle: CapturedBrowserTarget): Promise<void>;
  performCaptured(action: BrowserAction, handle: CapturedBrowserTarget, value: string | undefined, delay: number, guard: CapturedActionGuard): Promise<BrowserStatus>;
  uploadCaptured(handle: CapturedBrowserTarget, projectRelativePath: string, guard: CapturedActionGuard): Promise<BrowserStatus>;
  act(action: 'click' | 'fill' | 'press' | 'select', target: BrowserTarget, value?: string): Promise<BrowserStatus>;
  type(target: BrowserTarget, text: string, delay?: number): Promise<BrowserStatus>;
  keyboard(key: string, target?: BrowserTarget): Promise<BrowserStatus>;
  waitFor(condition: BrowserWaitCondition, target?: BrowserTarget | string, timeoutMs?: number): Promise<BrowserStatus>;
  scroll(direction: string, amount?: number): Promise<BrowserStatus>;
}
