import type { Config } from '../config/config.js';
import { inspectPng } from '../desktop/png-diff.js';
import type { BrowserAdapter, BrowserAction, BrowserActionRecord, BrowserAssertionCondition, BrowserDiagnostic, BrowserFindResult, BrowserScreenshot, BrowserSnapshotOptions, BrowserStatus, BrowserTarget, BrowserWaitCondition, CapturedActionGuard, CapturedBrowserTarget, BaselineReadRequest,BaselineRequest,BaselineResult,ComparisonRequest,ComparisonResult,FindingInput,FindingResult,FindingUpdate,FindingsQuery,FindingsResult,RawScreenshotCapture,ScreenshotRequest,ScreenshotResult,VisualCapabilities } from './adapter.js';
import type { VisualWorkflow } from './visual-workflow.js';

export type DesktopAdapterErrorCode = 'INVALID_ADAPTER_CONFIG'|'ATTACHMENT_UNAVAILABLE'|'SESSION_NOT_FOUND'|'CAPABILITY_UNAVAILABLE'|'REMOTE_COMMAND_FAILED'|'REVISION_CONFLICT'|'PERSISTENCE_ERROR';
export class DesktopAdapterError extends Error {
  constructor(readonly code:DesktopAdapterErrorCode,message:string){super(`${code}: ${message}`);this.name='DesktopAdapterError';}
}

/** Read-only attached WebDriver session. It never owns or changes remote session lifecycle. */
export class DesktopAdapter implements BrowserAdapter {
  readonly capabilities:VisualCapabilities=Object.freeze({screenshotKinds:['webview'] as const,baselines:true,comparison:true,findings:true});
  revision=0;
  private visualWorkflow?:VisualWorkflow;
  private endpoint:string;
  private sessionId:string;
  constructor(private config:Config,private projectRoot=process.cwd()) {
    const endpoint=config.desktop?.automation.endpoint,sessionId=config.desktop?.automation.session_id;
    if(!endpoint||!sessionId)throw new DesktopAdapterError('INVALID_ADAPTER_CONFIG','desktop provider requires desktop.automation.endpoint and session_id');
    let url:URL;
    try{url=new URL(endpoint);}catch{throw new DesktopAdapterError('INVALID_ADAPTER_CONFIG','desktop automation endpoint is invalid');}
    if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||!['','/'].includes(url.pathname)||url.search||url.hash)
      throw new DesktopAdapterError('INVALID_ADAPTER_CONFIG','desktop automation endpoint must be a literal loopback origin');
    if(!/^[A-Za-z0-9._~-]{1,256}$/.test(sessionId))throw new DesktopAdapterError('INVALID_ADAPTER_CONFIG','desktop automation session_id has invalid characters');
    this.endpoint=url.origin;this.sessionId=sessionId;
  }
  async start(){/* Attach is deliberately lazy: no network request during startup. */}
  async close(){this.sessionId='';}
  setVisualWorkflow(workflow:VisualWorkflow){this.visualWorkflow=workflow;}
  private unavailable(capability:string):never{throw new DesktopAdapterError('CAPABILITY_UNAVAILABLE',`${capability} is not verified for attached desktop sessions`);}
  takeScreenshot(request:ScreenshotRequest):Promise<ScreenshotResult>;
  takeScreenshot(fullPage?:boolean,fileName?:string):Promise<BrowserScreenshot>;
  async takeScreenshot(requestOrFullPage:ScreenshotRequest|boolean=false,fileName?:string):Promise<ScreenshotResult|BrowserScreenshot>{
    const visualRequest=typeof requestOrFullPage==='object'?requestOrFullPage:undefined;
    if(visualRequest){if(visualRequest.kind==='window')this.unavailable('window screenshot');if(!this.visualWorkflow)throw new DesktopAdapterError('PERSISTENCE_ERROR','visual repository is not configured');return this.visualWorkflow.takeScreenshot(visualRequest);}
    throw new DesktopAdapterError('CAPABILITY_UNAVAILABLE','path-based legacy screenshots are unavailable for attached desktop sessions; use captureScreenshotBytes');
  }
  async captureScreenshotBytes(request:ScreenshotRequest):Promise<RawScreenshotCapture>{
    if(request.kind==='window')this.unavailable('window screenshot');
    if(!this.sessionId)throw new DesktopAdapterError('ATTACHMENT_UNAVAILABLE','desktop adapter is detached');
    let response:Response;
    try{response=await fetch(`${this.endpoint}/session/${encodeURIComponent(this.sessionId)}/screenshot`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(5000)});}catch{throw new DesktopAdapterError('ATTACHMENT_UNAVAILABLE','could not reach the configured loopback WebDriver endpoint');}
    let body:any;try{const reader=response.body?.getReader();if(!reader)throw Error();const chunks:Uint8Array[]=[];let size=0;while(true){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>32_000_000){await reader.cancel();throw Error();}chunks.push(result.value);}body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new DesktopAdapterError('REMOTE_COMMAND_FAILED','WebDriver returned malformed or oversized screenshot data');}
    if(body?.value?.error==='invalid session id')throw new DesktopAdapterError('SESSION_NOT_FOUND','the configured desktop session is unavailable');
    if(body?.value?.error==='unsupported operation')throw new DesktopAdapterError('CAPABILITY_UNAVAILABLE','WebDriver does not support screenshots');
    if(!response.ok)throw new DesktopAdapterError('REMOTE_COMMAND_FAILED',`WebDriver screenshot failed with HTTP ${response.status}`);
    const encoded=body?.value;
    if(typeof encoded!=='string'||encoded.length>11_184_812||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new DesktopAdapterError('REMOTE_COMMAND_FAILED','WebDriver returned invalid screenshot data');
    const bytes=Buffer.from(encoded,'base64');let dimensions:{width:number;height:number};try{dimensions=inspectPng(bytes);}catch{throw new DesktopAdapterError('REMOTE_COMMAND_FAILED','WebDriver screenshot was not a valid bounded PNG');}
    return{image:bytes,width:dimensions.width,height:dimensions.height,captureKind:'webview'};
  }
  createBaseline(request:BaselineRequest):Promise<BaselineResult>{return this.visualWorkflow?.createBaseline(request)??Promise.reject(new DesktopAdapterError('PERSISTENCE_ERROR','visual repository is not configured'));}
  readBaseline(request:BaselineReadRequest):Promise<BaselineResult>{return this.visualWorkflow?.readBaseline(request)??Promise.reject(new DesktopAdapterError('PERSISTENCE_ERROR','visual repository is not configured'));}
  compareWithBaseline(request:ComparisonRequest):Promise<ComparisonResult>{return this.visualWorkflow?.compareWithBaseline(request)??Promise.reject(new DesktopAdapterError('PERSISTENCE_ERROR','visual repository is not configured'));}
  listFindings(request:FindingsQuery):Promise<FindingsResult>{return this.visualWorkflow?.listFindings(request)??Promise.reject(new DesktopAdapterError('PERSISTENCE_ERROR','visual repository is not configured'));}
  createFinding(request:FindingInput):Promise<FindingResult>{return this.visualWorkflow?.createFinding(request)??Promise.reject(new DesktopAdapterError('PERSISTENCE_ERROR','visual repository is not configured'));}
  updateFinding(request:FindingUpdate&{expectedVersion:number}):Promise<FindingResult>{return this.visualWorkflow?.updateFinding(request)??Promise.reject(new DesktopAdapterError('PERSISTENCE_ERROR','visual repository is not configured'));}
  currentUrl():string{this.unavailable('currentUrl');}
  status():Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','status is not verified for attached desktop sessions'));}
  browserErrors(_after?:number,_limit?:number):{events:BrowserDiagnostic[];next_cursor:number;oldest_cursor:number}{this.unavailable('browser diagnostics');}
  navigate(_url:string,_waitUntil?:'load'|'domcontentloaded'|'networkidle'|'commit',_timeoutMs?:number):Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','navigation is unavailable for attached desktop sessions'));}
  createTab(_url?:string):Promise<{id:string}&BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','tabs are unavailable for attached desktop sessions'));}
  listTabs():Promise<Array<{id:string;url:string;active:boolean}>>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','tabs are unavailable for attached desktop sessions'));}
  selectTab(_id:string):Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','tabs are unavailable for attached desktop sessions'));}
  closeTab(_id?:string):Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','tabs are unavailable for attached desktop sessions'));}
  back():Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','navigation history is unavailable for attached desktop sessions'));}
  forward():Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','navigation history is unavailable for attached desktop sessions'));}
  actionSequence(_limit?:number):BrowserActionRecord[]{this.unavailable('action sequence');}
  assertCondition(_condition:BrowserAssertionCondition,_target?:BrowserTarget,_expected?:string|number,_timeoutMs?:number,_match?:'contains'|'exact'):Promise<{passed:boolean;observedCount:number}>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','assertions are unavailable for attached desktop sessions'));}
  upload(_target:BrowserTarget,_path:string):Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','upload is unavailable for attached desktop sessions'));}
  setViewport(_width:number,_height:number):Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','viewport control is unavailable for attached desktop sessions'));}
  setActionTimeout(_timeoutMs:number):void{this.unavailable('action timeout');}
  consoleErrorCount():number{this.unavailable('console error count');}
  snapshot(_options?:BrowserSnapshotOptions):Promise<Record<string,unknown>>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','DOM snapshots are unavailable for attached desktop sessions'));}
  find(_target:BrowserTarget):Promise<BrowserFindResult>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','element lookup is unavailable for attached desktop sessions'));}
  captureVisibleTarget(_target:BrowserTarget):Promise<CapturedBrowserTarget|undefined>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','captured actions are unavailable for attached desktop sessions'));}
  sameElement(_handle:CapturedBrowserTarget,_target:BrowserTarget):Promise<boolean>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','captured actions are unavailable for attached desktop sessions'));}
  capturedTargetUsable(_handle:CapturedBrowserTarget):Promise<boolean>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','captured actions are unavailable for attached desktop sessions'));}
  releaseCapturedTarget(_handle:CapturedBrowserTarget):Promise<void>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','captured actions are unavailable for attached desktop sessions'));}
  performCaptured(_action:BrowserAction,_handle:CapturedBrowserTarget,_value:string|undefined,_delay:number,_guard:CapturedActionGuard):Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','captured actions are unavailable for attached desktop sessions'));}
  uploadCaptured(_handle:CapturedBrowserTarget,_path:string,_guard:CapturedActionGuard):Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','captured upload is unavailable for attached desktop sessions'));}
  act(_action:'click'|'fill'|'press'|'select',_target:BrowserTarget,_value?:string):Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','actions are unavailable for attached desktop sessions'));}
  type(_target:BrowserTarget,_text:string,_delay?:number):Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','typing is unavailable for attached desktop sessions'));}
  keyboard(_key:string,_target?:BrowserTarget):Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','keyboard input is unavailable for attached desktop sessions'));}
  waitFor(_condition:BrowserWaitCondition,_target?:BrowserTarget|string,_timeoutMs?:number):Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','waits are unavailable for attached desktop sessions'));}
  scroll(_direction:string,_amount?:number):Promise<BrowserStatus>{return Promise.reject(new DesktopAdapterError('CAPABILITY_UNAVAILABLE','scrolling is unavailable for attached desktop sessions'));}
}
