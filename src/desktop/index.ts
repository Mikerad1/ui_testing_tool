import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { safePath } from '../config/config.js';
import { inspectPng, MAX_SUPPORTED_PNG_BYTES } from './png-diff.js';
import { isStableMaskSelector, MASK_SELECTOR_SUBSET_ERROR } from './mask-selector.js';

/** Configuration is intentionally explicit: this service never discovers and attaches to a running app. */
export interface DesktopConfig {
  projectRoot: string;
  /** Absolute path or path relative to projectRoot. */
  tauriBinary?: string;
  /** Absolute path to the native tauri-driver executable; no shell or PATH command string is evaluated. */
  driverExecutable?: string;
  /** Ignored for safety: service and driver are kept on 127.0.0.1. */
  driverHost?: string;
  driverPort?: number;
  driverArgs?: string[];
  /** Required exact X11 window title for OS-window screenshots. */
  windowTitle?: string;
  /** Exact command + argv, executed only by explicit start(); never run by inspection/capabilities. */
  buildCommand?: DesktopBuildCommand;
  /** Working directory relative to projectRoot or absolute within it. */
  buildCwd?: string;
  buildTimeoutMs?: number;
  readinessTimeoutMs?: number;
  /** Existing parent-managed project artifact root; captures go in a private `desktop` subdirectory. */
  artifactDirectory?: string;
  /** Per-capture file size limit; maxArtifactBytes is the aggregate quota. */
  maxArtifactFileBytes?: number;
  maxArtifactBytes?: number;
  maxArtifactCount?: number;
  maxArtifactAgeDays?: number;
  maskSelectors?: string[];
}
export interface DesktopBuildCommand { command: string; args: string[]; cwd?: string }
export type CaptureKind = 'webview' | 'window';
export interface DesktopCapability { available: boolean; reason?: string }
export interface DesktopCapabilities {
  platform: NodeJS.Platform; driver: DesktopCapability; tauriBinary: DesktopCapability;
  webviewCapture: DesktopCapability; windowCapture: DesktopCapability;
}
export interface ProjectInspection {
  projectRoot: string; tauri: boolean; angular: boolean; tauriConfigFiles: string[];
  packageManagerFiles: string[]; tauriBinary?: string; buildCommandConfigured: boolean;
}
export interface DesktopSession { id: string; state: 'running' | 'stopped'; endpoint: string; startedAt: string }
export interface DesktopRect { x: number; y: number; width: number; height: number }
type WebDriverElementReference = { 'element-6066-11e4-a52e-4f735466cecf': string } | { ELEMENT: string };
export class ArtifactCleanupError extends AggregateError {
  readonly code = 'ARTIFACT_CLEANUP_FAILED' as const;
  constructor(errors: Iterable<unknown>, message: string) {
    super(errors, message);
    this.name = 'ArtifactCleanupError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
export interface DesktopCandidateSummary { index: number; role: string; accessibleName: string; text: string; enabled: boolean; visible: boolean; rect: DesktopRect }
export interface DesktopTreeNode { role: string; accessibleName: string; text: string; enabled: boolean; visible: boolean; rect: DesktopRect }
export interface DesktopElementDetails { text: string; rect: DesktopRect; attributes: Record<string, string | null>; styles: Record<string, string>; overflow: { horizontal: boolean; vertical: boolean; clippedHorizontal: boolean; clippedVertical: boolean; scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number } }
export interface DesktopCapture { kind: CaptureKind; path: string; artifactRef: string; sha256?: string; byteLength?: number; mimeType: 'image/png'; bytes: Buffer; width?: number; height?: number }
export interface GeneratedDesktopArtifact { path: string; artifactRef: string; sha256: string; byteLength: number; mimeType: 'image/png'; width?: number; height?: number }
export interface DesktopUploadResult { basename: string; byteLength: number }
export type DesktopLocator = string | { by: 'role'; role: string; name?: string } | { by: 'test_id'; value: string } | { by: 'placeholder'; value: string } | { by: 'label'; value: string } | { by: 'text'; value: string };
export interface DesktopCommandResult { code: number | null; stdout: string; stderr: string }
export interface DesktopAdapters {
  spawn: typeof spawn;
  /** Timed commands must terminate and reap the child before rejecting. */
  command: (executable: string, args: string[], timeoutMs?: number) => Promise<DesktopCommandResult>;
  fetch: typeof fetch;
  processTree: (pid: number) => Promise<Set<number>>;
  reservePort: () => Promise<number>;
  killProcess: (pid: number, signal: NodeJS.Signals) => void;
  isProcessAlive: (pid: number) => boolean;
  /** Linux managed drivers are launched detached; signal/check their isolated process group. */
  killProcessGroup: (pgid: number, signal: NodeJS.Signals) => void;
  isProcessGroupAlive: (pgid: number) => boolean;
}

const SNAPSHOT_SCRIPT = `const max=arguments[0],out=[],nodes=document.querySelectorAll('body *'),roles={A:'link',BUTTON:'button',INPUT:'textbox',TEXTAREA:'textbox',SELECT:'combobox',IMG:'img'};for(let i=0;i<nodes.length&&out.length<max&&i<max*20;i++){const e=nodes[i],s=getComputedStyle(e),r=e.getBoundingClientRect();if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||r.width<=0||r.height<=0)continue;const role=e.getAttribute('role')||roles[e.tagName]||'',name=(e.getAttribute('aria-label')||e.getAttribute('alt')||e.innerText||'').trim().replace(/\\s+/g,' ').slice(0,200),text=(e.innerText||'').trim().replace(/\\s+/g,' ').slice(0,300);if(!role&&!name&&!text)continue;out.push({role:role||e.tagName.toLowerCase(),accessibleName:name,text,enabled:!e.disabled,visible:true,rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})}return out;`;
const MASK_INSTALL_SCRIPT = `const selectors=arguments[0],id=arguments[1],secret=arguments[2];let dlg,host,stage='top-layer preflight';try{
if(typeof HTMLDialogElement==='undefined'||!HTMLDialogElement.prototype.showModal)throw new Error('protected top layer unavailable');
stage='dialog creation';dlg=document.createElement('dialog');dlg.dataset.umbCaptureMask=id;for(const [k,v] of [['all','initial'],['display','block'],['position','fixed'],['inset','0'],['width','100vw'],['height','100vh'],['max-width','none'],['max-height','none'],['margin','0'],['padding','0'],['border','0'],['background','transparent'],['pointer-events','none'],['visibility','visible'],['opacity','1'],['z-index','2147483647'],['transform','none'],['clip-path','none'],['filter','none'],['animation','none'],['transition','none'],['contain','none'],['content-visibility','visible'],['overflow','visible'],['box-sizing','border-box']])dlg.style.setProperty(k,v,'important');
stage='closed shadow overlay setup';host=document.createElement('div');for(const [k,v] of [['all','initial'],['display','block'],['position','fixed'],['inset','0'],['width','100vw'],['height','100vh'],['margin','0'],['padding','0'],['border','0'],['background','transparent'],['pointer-events','none'],['visibility','visible'],['opacity','1'],['z-index','2147483647'],['transform','none'],['clip-path','none'],['filter','none'],['animation','none'],['transition','none'],['contain','none'],['content-visibility','visible'],['overflow','visible'],['box-sizing','border-box']])host.style.setProperty(k,v,'important');dlg.appendChild(host);const root=host.attachShadow({mode:'closed'});const list=document.createElement('div');for(const [k,v] of [['all','initial'],['display','block'],['position','fixed'],['inset','0'],['width','100vw'],['height','100vh'],['margin','0'],['padding','0'],['border','0'],['background','transparent'],['pointer-events','none'],['visibility','visible'],['opacity','1'],['z-index','2147483647'],['transform','none'],['clip-path','none'],['filter','none'],['animation','none'],['transition','none'],['contain','none'],['content-visibility','visible'],['overflow','visible'],['box-sizing','border-box']])list.style.setProperty(k,v,'important');root.appendChild(list);const initial=selectors.map(selector=>{let nodes;try{nodes=[...document.querySelectorAll(selector)]}catch(e){throw new Error('invalid selector')}if(!nodes.some(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight}))throw new Error('no visible in-viewport match');return nodes});
const rectFor=el=>{const r=el.getBoundingClientRect();return{x:Math.max(0,r.left),y:Math.max(0,r.top),right:Math.min(innerWidth,r.right),bottom:Math.min(innerHeight,r.bottom)}};
stage='modal top-layer activation';document.documentElement.appendChild(dlg);dlg.showModal();
let invalidReason;const invalidate=reason=>{invalidReason=invalidReason||reason};
const fail=reason=>{invalidate(reason);if(dlg.isConnected&&dlg.open){list.replaceChildren();const cover=document.createElement('div');cover.className='mask';for(const [key,value] of [['all','initial'],['display','block'],['position','fixed'],['background','#000'],['opacity','1'],['visibility','visible'],['z-index','2147483647'],['transform','none'],['clip-path','none'],['filter','none'],['animation','none'],['transition','none'],['margin','0'],['padding','0'],['border','0'],['box-sizing','border-box'],['pointer-events','none'],['left','0px'],['top','0px'],['width','100vw'],['height','100vh']])cover.style.setProperty(key,value,'important');list.appendChild(cover)}throw new Error(reason)};
const verify=()=>{const d=getComputedStyle(dlg),h=getComputedStyle(host),dr=dlg.getBoundingClientRect(),hr=host.getBoundingClientRect();const valid=s=>s.display==='block'&&s.visibility==='visible'&&s.opacity==='1'&&s.position==='fixed'&&s.transform==='none'&&s.clipPath==='none'&&s.filter==='none'&&s.animationName==='none'&&s.transitionDuration==='0s'&&Number(s.zIndex)>=2147483647;if(!valid(d)||!valid(h)||dr.left>0||dr.top>0||dr.right<innerWidth||dr.bottom<innerHeight||hr.left>0||hr.top>0||hr.right<innerWidth||hr.bottom<innerHeight)throw new Error('overlay computed style or rendered geometry is not protected');for(const cover of list.children){const s=getComputedStyle(cover),r=cover.getBoundingClientRect(),color=s.backgroundColor;if(!valid(s)||!(color==='rgb(0, 0, 0)'||color==='rgb(0,0,0)'||color==='rgba(0, 0, 0, 1)'||color==='rgba(0,0,0,1)')||r.width<=0||r.height<=0)throw new Error('mask element is not opaque and rendered: '+JSON.stringify({display:s.display,visibility:s.visibility,opacity:s.opacity,position:s.position,background:color,width:r.width,height:r.height,zIndex:s.zIndex,transform:s.transform,clipPath:s.clipPath,filter:s.filter,animationName:s.animationName,transitionDuration:s.transitionDuration}))}};
let updateHook;const update=(schedule=true)=>{if(!dlg.isConnected||!dlg.open||dlg.__umbMaskCheck!==updateHook)fail('mask dialog or updater was lost');if(invalidReason)fail(invalidReason);if(document.fullscreenElement||document.webkitFullscreenElement)fail('fullscreen state cannot be masked');let topLayer;try{topLayer=[...document.querySelectorAll('dialog:modal')];if(typeof CSS.supports==='function'&&CSS.supports('selector(:popover-open)'))topLayer.push(...document.querySelectorAll('[popover]:popover-open'))}catch(e){fail('top-layer state cannot be verified')}if(topLayer.some(el=>el!==dlg))fail('another top-layer element may cover the mask');const current=selectors.map(selector=>{try{return [...document.querySelectorAll(selector)]}catch(e){return null}});if(current.some((nodes,index)=>!nodes||nodes.length!==initial[index].length||initial[index].some(el=>!nodes.includes(el))))fail('mask selector match set changed');const boxes=[];for(const nodes of current){const visible=nodes.filter(el=>{const s=getComputedStyle(el),r=rectFor(el);return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.right>r.x&&r.bottom>r.y});if(!visible.length)fail('mask target is no longer visible in viewport');for(const el of visible)boxes.push(rectFor(el))}list.replaceChildren();for(const {x,y,right,bottom} of boxes){const cover=document.createElement('div');cover.className='mask';for(const [key,value] of [['all','initial'],['display','block'],['position','fixed'],['left',x+'px'],['top',y+'px'],['width',(right-x)+'px'],['height',(bottom-y)+'px'],['background','#000'],['opacity','1'],['visibility','visible'],['z-index','2147483647'],['transform','none'],['clip-path','none'],['filter','none'],['animation','none'],['transition','none'],['contain','none'],['content-visibility','visible'],['margin','0'],['padding','0'],['border','0'],['box-sizing','border-box'],['pointer-events','none']])cover.style.setProperty(key,value,'important');list.appendChild(cover)}try{verify()}catch(e){fail(String(e?.message||e))}if(schedule)rafId=requestAnimationFrame(()=>{if(stopped)return;try{update(true)}catch{/* fail-closed state remains latched */}})};
stage='initial overlay paint';updateHook=key=>{if(key!==secret)fail('mask identity mismatch');if(invalidReason)fail(invalidReason);update(false);return true};
Object.defineProperty(dlg,'__umbMaskCheck',{value:updateHook,configurable:false,writable:false});Object.defineProperty(dlg,'__umbMaskState',{value:Object.freeze({get invalidReason(){return invalidReason}}),configurable:false,writable:false});
let stopped=false,rafId=0;const controller=new AbortController(),observer=new MutationObserver(()=>invalidate('external page DOM changed during capture'));const cleanupHook=key=>{if(key!==secret)throw new Error('mask cleanup identity mismatch');stopped=true;if(rafId)cancelAnimationFrame(rafId);observer.disconnect();controller.abort();return true};Object.defineProperty(dlg,'__umbMaskCleanup',{value:cleanupHook,configurable:false,writable:false});
observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true,attributeOldValue:true});
const onFullscreen=()=>invalidate('fullscreen state changed during capture');document.addEventListener('fullscreenchange',onFullscreen,{signal:controller.signal});document.addEventListener('webkitfullscreenchange',onFullscreen,{signal:controller.signal});
const onTopLayerToggle=event=>{const element=event.target;if(element&&element!==dlg&&(element instanceof HTMLDialogElement||element.hasAttribute?.('popover')))invalidate('dialog or popover state changed during capture')};document.addEventListener('beforetoggle',onTopLayerToggle,{capture:true,signal:controller.signal});document.addEventListener('toggle',onTopLayerToggle,{capture:true,signal:controller.signal});
update();return dlg
}catch(e){dlg?.__umbMaskCleanup?.(secret);if(dlg?.open)dlg.close();dlg?.remove();throw new Error('mask install failed at '+stage+': '+String(e?.message||e))}`;
const MASK_CHECK_SCRIPT = `const dlg=arguments[0],id=arguments[1],secret=arguments[2];if(!(dlg instanceof HTMLDialogElement)||!dlg.isConnected||!dlg.open||dlg.dataset.umbCaptureMask!==id||typeof dlg.__umbMaskCheck!=='function'||dlg.__umbMaskState?.invalidReason)throw new Error('trusted mask element was lost or invalidated');if(document.fullscreenElement||document.webkitFullscreenElement)throw new Error('fullscreen state cannot be masked');if(dlg.__umbMaskCheck(secret)!==true||dlg.__umbMaskState?.invalidReason)throw new Error('mask updater or state integrity failed');return true;`;
const MASK_REMOVE_SCRIPT = `const node=arguments[0],secret=arguments[1],id=arguments[2];if(!(node instanceof HTMLDialogElement)||node.dataset.umbCaptureMask!==id||!node.isConnected||!node.open||typeof node.__umbMaskCleanup!=='function'||node.__umbMaskCleanup(secret)!==true)throw new Error('trusted mask cleanup context was lost');if(node.open)node.close();node.remove();return true;`;

const defaults: DesktopAdapters = {
  spawn,
  fetch,
  async command(executable, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', timer: NodeJS.Timeout | undefined, escalation: NodeJS.Timeout | undefined, timedOut = false, settled = false, spawnError: Error | undefined;
      child.stdout?.setEncoding('utf8').on('data', (s: string) => { stdout += s; });
      child.stderr?.setEncoding('utf8').on('data', (s: string) => { stderr += s; });
      const finish = (error?: Error, code?: number | null) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); if (escalation) clearTimeout(escalation); if (timedOut) reject(Error(`Command ${executable} timed out after ${timeoutMs}ms.`)); else if (error) reject(error); else resolve({ code: code ?? null, stdout, stderr }); };
      child.once('error', error => { spawnError = error; if (!timedOut) finish(error); });
      child.once('close', code => finish(spawnError, code));
      if (timeoutMs !== undefined) timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* child may be closing */ }
        escalation = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* child may be closing */ } }, 500);
        escalation.unref();
      }, timeoutMs);
    });
  },
  async processTree(pid) {
    const descendants = new Set([pid]);
    if (process.platform !== 'linux') return descendants;
    let changed = true;
    while (changed) {
      changed = false;
      for (const name of await fs.readdir('/proc').catch(() => [])) {
        if (!/^\d+$/.test(name)) continue;
        const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8').catch(() => '');
        const match = /^\d+ \(.+\)\s+\S+\s+(\d+)/.exec(stat);
        if (match && descendants.has(Number(match[1])) && !descendants.has(Number(name))) { descendants.add(Number(name)); changed = true; }
      }
    }
    return descendants;
  },
  async reservePort() {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw Error('Could not reserve a loopback port for tauri-driver.'); }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return address.port;
  },
  killProcess(pid, signal) { process.kill(pid, signal); },
  isProcessAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } },
  killProcessGroup(pgid, signal) { process.kill(-pgid, signal); },
  isProcessGroupAlive(pgid) { try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } },
};

const WEBDRIVER_REQUEST_TIMEOUT_MS = 5_000;
const WEBDRIVER_CAPTURE_TIMEOUT_MS = 3_000;
const WEBDRIVER_DELETE_TIMEOUT_MS = 1_000;
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const MAX_READINESS_TIMEOUT_MS = 600_000;

class WebDriverTimeoutError extends Error {
  readonly code = 'WEBDRIVER_REQUEST_TIMEOUT' as const;
  constructor(timeoutMs: number) {
    super(`WebDriver request timed out after ${timeoutMs}ms.`);
    this.name = 'WebDriverTimeoutError';
  }
}

/**
 * Managed native Tauri/WebDriver P0 service. `tauri-driver` and a real Tauri binary are required;
 * the WebdriverIO tauri-service is not used/wired here. No command is run during inspection.
 */
export class DesktopService {
  private driver?: ChildProcess;
  private buildProcess?: ChildProcess;
  private buildCompletion?: Promise<void>;
  private cancelBuild?: () => void;
  private sessionId?: string;
  private startedAt?: string;
  private managedDriverPid?: number;
  private readonly ownedPids = new Set<number>();
  private readonly root: string;
  private readonly host: string;
  private port: number;
  private readonly adapters: DesktopAdapters;
  private actionRequestTimeoutMs?: number;

  constructor(private readonly config: DesktopConfig, adapters: Partial<DesktopAdapters> = {}) {
    this.root = path.resolve(config.projectRoot);
    this.host = '127.0.0.1';
    this.port = config.driverPort ?? 0;
    this.adapters = { ...defaults, ...adapters };
  }

  /** Set the bound for ordinary WebDriver requests made by the current workflow action. */
  setActionRequestTimeout(timeoutMs: number | undefined): void {
    if (timeoutMs === undefined) { this.actionRequestTimeoutMs = undefined; return; }
    bounded(timeoutMs, 1, WEBDRIVER_REQUEST_TIMEOUT_MS, 'action request timeout');
    this.actionRequestTimeoutMs = timeoutMs;
  }

  async capabilities(): Promise<DesktopCapabilities> {
    const binary = await this.resolveBinary().catch(error => ({ error: message(error) }));
    const driver = this.config.driverExecutable && path.isAbsolute(this.config.driverExecutable)
      ? await fs.access(this.config.driverExecutable, fsConstants.X_OK).then(() => ({ available: true as const }), () => ({ available: false as const, reason: 'Configured tauri-driver executable is missing, non-executable, or inaccessible.' }))
      : { available: false, reason: 'Configure an absolute path to the tauri-driver executable.' };
    let display = process.env.WAYLAND_DISPLAY ? 'Wayland window capture is unsupported: no explicit consented portal backend is configured.'
      : process.platform !== 'linux' ? `Native window capture is unsupported on ${process.platform}.`
        : !process.env.DISPLAY ? 'X11 display unavailable (DISPLAY is not set).' : this.config.windowTitle ? undefined : 'Configure an exact windowTitle for safe window capture.';
    if (!display) {
      const [wmctrl, imageMagick] = await Promise.all([this.commandAvailable('wmctrl', ['-lp']), this.commandAvailable('import', ['-version'])]);
      if (!wmctrl || !imageMagick) display = `X11 window capture requires usable ${[!wmctrl && 'wmctrl (with display access)', !imageMagick && 'ImageMagick import'].filter(Boolean).join(' and ')}.`;
    }
    return {
      platform: process.platform,
      driver: driver.available ? driver : { available: false, reason: driver.reason },
      tauriBinary: typeof binary === 'string' ? { available: true } : { available: false, reason: binary.error },
      webviewCapture: this.sessionId ? { available: true } : { available: false, reason: 'Start a managed WebDriver session first.' },
      windowCapture: display ? { available: false, reason: display } : { available: true },
    };
  }

  /** Read-only filesystem inspection. Never invokes an app command, build, or package manager. */
  async inspectProject(): Promise<ProjectInspection> {
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const names = new Set(entries.map(e => e.name));
    const configs = ['tauri.conf.json', 'tauri.conf.json5', 'Tauri.toml', 'tauri.conf.toml'];
    const tauriConfigFiles: string[] = [];
    for (const dir of ['src-tauri', '.']) for (const file of configs) {
      const rel = dir === '.' ? file : `${dir}/${file}`;
      if (await fs.stat(path.join(this.root, rel)).then(s => s.isFile(), () => false)) tauriConfigFiles.push(rel);
    }
    const angular = names.has('angular.json');
    const binary = await this.resolveBinary().catch(() => undefined);
    return {
      projectRoot: this.root, tauri: tauriConfigFiles.length > 0 || names.has('src-tauri'), angular,
      tauriConfigFiles, packageManagerFiles: ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].filter(n => names.has(n)),
      ...(binary ? { tauriBinary: binary } : {}), buildCommandConfigured: Boolean(this.config.buildCommand?.command),
    };
  }

  async start(): Promise<DesktopSession> {
    if (this.sessionId) return this.status();
    if (!this.config.driverExecutable || !path.isAbsolute(this.config.driverExecutable)) throw Error('Setup required: configure the absolute Linux tauri-driver executable and a built Tauri binary. This native service launches its own W3C session; it does not attach to an existing app. WebdriverIO @wdio/tauri-service is a separate recommended alternative and is not wired here.');
    await this.runBuildIfConfigured();
    const binary = await this.resolveBinary();
    if (!(await fs.stat(binary).then(s => s.isFile(), () => false))) throw Error(`Configured Tauri binary does not exist: ${binary}. Configure a buildCommand or build it separately, then retry.`);
    this.port = this.config.driverPort === undefined ? await this.adapters.reservePort() : this.config.driverPort;
    bounded(this.port, 1, 65_535, 'driverPort');
    const args: string[] = [];
    const configuredArgs = this.config.driverArgs ?? [];
    for (let i = 0; i < configuredArgs.length; i++) {
      const arg = configuredArgs[i]!;
      if (['--port', '-p', '--host', '-H', '--address', '--bind-address'].includes(arg)) { i++; continue; }
      if (/^(--port|--host|--address|--bind-address)=/.test(arg)) continue;
      args.push(arg);
    }
    args.push('--port', String(this.port));
    const driver = this.adapters.spawn(this.config.driverExecutable, args, { shell: false, stdio: 'ignore', ...(process.platform === 'linux' ? { detached: true } : {}) });
    this.driver = driver;
    this.ownedPids.clear(); this.managedDriverPid = driver.pid;
    if (driver.pid) this.ownedPids.add(driver.pid);
    let driverError: Error | undefined;
    driver.once('error', error => { driverError = error; });
    driver.once('exit', () => { if (this.driver === driver) { this.sessionId = undefined; void this.killDriver().catch(() => undefined); } });
    const readinessTimeoutMs = this.config.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    bounded(readinessTimeoutMs, 1, MAX_READINESS_TIMEOUT_MS, 'readinessTimeoutMs');
    const deadline = Date.now() + readinessTimeoutMs;
    try {
      let ready = false;
      while (Date.now() < deadline) {
        if (driverError) throw Error(`Could not spawn configured tauri-driver: ${message(driverError)}. Verify the executable path and Linux dependencies.`);
        if (driver.exitCode !== null) throw Error('tauri-driver exited before becoming ready. Install/configure native tauri-driver and its Linux WebKitGTK/WebDriver dependencies; this direct adapter is limited versus the separate @wdio/tauri-service and does not attach to existing processes.');
        try {
          const remaining = deadline - Date.now();
          const r = await this.fetchBounded(`${this.endpoint()}/status`, { method: 'GET' }, Math.min(500, remaining));
          if (r.ok) { ready = true; break; }
        } catch { /* poll */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!ready) throw Error(`tauri-driver did not become ready at ${this.endpoint()}; verify its executable, Linux dependencies, and port binding. This service uses native tauri-driver, not the separate @wdio/tauri-service; it will not attach to an existing driver.`);
      const response = await this.request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: binary } } } }, readinessTimeoutMs);
      const id = response.value?.sessionId ?? response.sessionId;
      if (typeof id !== 'string' || !id) throw Error(`WebDriver did not create a W3C session: ${JSON.stringify(response).slice(0, 500)}`);
      this.sessionId = id;
      this.startedAt = new Date().toISOString();
      await this.rememberOwnedTree();
      return this.status();
    } catch (error) { await this.killDriver(); throw error; }
  }

  async status(): Promise<DesktopSession> {
    if (!this.sessionId || !this.driver) throw Error('No managed desktop session is running.');
    return { id: this.sessionId, state: 'running', endpoint: this.endpoint(), startedAt: this.startedAt! };
  }

  async stop(): Promise<{ stopped: boolean }> {
    const wasActive = Boolean(this.driver || this.buildProcess || this.ownedPids.size);
    if (this.cancelBuild) this.cancelBuild();
    if (this.buildCompletion) await this.buildCompletion.catch(() => undefined);
    if (!this.driver) { if (this.ownedPids.size) await this.killDriver(); return { stopped: wasActive }; }
    try {
      if (this.sessionId) {
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            this.request('DELETE', `/session/${encodeURIComponent(this.sessionId)}`, undefined, WEBDRIVER_DELETE_TIMEOUT_MS),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(Error('Timed out waiting for WebDriver session deletion.')), WEBDRIVER_DELETE_TIMEOUT_MS);
            }),
          ]);
        } catch (error) {
          if (error instanceof WebDriverTimeoutError) throw Error('Timed out waiting for WebDriver session deletion.');
          throw error;
        } finally { if (timeout) clearTimeout(timeout); }
      }
    }
    finally { this.sessionId = undefined; await this.killDriver(); }
    return { stopped: true };
  }

  async click(selector: DesktopLocator): Promise<void> { await this.elementAction(selector, 'click', {}); }
  async type(selector: DesktopLocator, text: string): Promise<void> { if (text.length > 10_000) throw Error('Text input exceeds 10000 characters.'); await this.elementAction(selector, 'value', { text, value: [...text] }); }
  async upload(selector: DesktopLocator, projectRelativePath: string): Promise<DesktopUploadResult> {
    this.requireSession();
    if (typeof projectRelativePath !== 'string' || !projectRelativePath || path.isAbsolute(projectRelativePath)
      || projectRelativePath.includes('\\') || projectRelativePath.split('/').some(part => !part || part === '.' || part === '..')) {
      throw Error('Upload path must be a project-relative file path without traversal.');
    }
    const candidate = await safePath(this.root, projectRelativePath, false);
    const [realRoot, resolved] = await Promise.all([fs.realpath(this.root), fs.realpath(candidate)]);
    if (!this.within(realRoot, resolved)) throw Error('Upload path escapes project root.');
    const info = await fs.stat(resolved);
    if (!info.isFile()) throw Error('Upload must be a regular file no larger than 20 MiB.');
    if (info.size > 20 * 1024 * 1024) throw Error('Upload must be a regular file no larger than 20 MiB.');
    if (/[\r\n]/.test(resolved)) throw Error('Upload path cannot contain CR or LF characters.');
    const element = await this.findElement(selector, true);
    const tagName = (await this.request('GET', `/element/${encodeURIComponent(element)}/name`)).value;
    if (typeof tagName !== 'string' || tagName.toLowerCase() !== 'input') throw Error('Upload target must be an input[type=file].');
    const type = (await this.request('GET', `/element/${encodeURIComponent(element)}/attribute/type`)).value;
    if (typeof type !== 'string' || type.toLowerCase() !== 'file') throw Error('Upload target must be an input[type=file].');
    const enabled = (await this.request('GET', `/element/${encodeURIComponent(element)}/enabled`)).value;
    if (enabled !== true) throw Error('Upload target must be enabled.');
    await this.request('POST', `/element/${encodeURIComponent(element)}/value`, { text: resolved, value: [...resolved] });
    return { basename: path.basename(resolved), byteLength: info.size };
  }
  async text(selector: DesktopLocator): Promise<string> { const e = await this.findElement(selector); return String((await this.request('GET', `/element/${e}/text`)).value ?? ''); }
  async tree(maxNodes = 200): Promise<DesktopTreeNode[]> {
    bounded(maxNodes, 1, 300, 'maxNodes');
    const value = await this.request('POST', '/execute/sync', { script: SNAPSHOT_SCRIPT, args: [maxNodes] });
    return (Array.isArray(value.value) ? value.value : []) as DesktopTreeNode[];
  }
  async details(selector: DesktopLocator): Promise<DesktopElementDetails> {
    const e = await this.findElement(selector);
    const result = await this.request('POST', '/execute/sync', { script: `const e=arguments[0],s=getComputedStyle(e),r=e.getBoundingClientRect(),keys=['display','position','visibility','color','backgroundColor','fontSize','fontWeight','lineHeight','overflow','overflowX','overflowY','width','height','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','gap','alignItems','justifyContent','flexDirection','gridTemplateColumns','gridTemplateRows'];const allow=new Set(['id','class','role','aria-label','title','type','placeholder','name']);const overflow={horizontal:e.scrollWidth>e.clientWidth,vertical:e.scrollHeight>e.clientHeight,clippedHorizontal:(s.overflowX==='hidden'||s.overflowX==='clip')&&e.scrollWidth>e.clientWidth,clippedVertical:(s.overflowY==='hidden'||s.overflowY==='clip')&&e.scrollHeight>e.clientHeight,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight,clientWidth:e.clientWidth,clientHeight:e.clientHeight};return {text:(e.innerText||e.textContent||'').slice(0,1000),rect:{x:r.x,y:r.y,width:r.width,height:r.height},attributes:Object.fromEntries([...e.attributes].filter(a=>allow.has(a.name)).slice(0,20).map(a=>[a.name,a.value.slice(0,500)])),styles:Object.fromEntries(keys.map(k=>[k,String(s[k]).slice(0,200)])),overflow};`, args: [{ 'element-6066-11e4-a52e-4f735466cecf': e }] });
    return result.value as DesktopElementDetails;
  }
  async find(selector: DesktopLocator, limit = 50): Promise<DesktopCandidateSummary[]> {
    this.requireSession(); bounded(limit, 1, 50, 'limit'); if (typeof selector === 'string') this.validateSelector(selector); else this.validateLocator(selector);
     const summary = await this.request('POST', '/execute/sync', { script: `const locator=arguments[0],limit=arguments[1],roles={A:'link',BUTTON:'button',INPUT:'textbox',TEXTAREA:'textbox',SELECT:'combobox'},nodes=typeof locator==='string'?document.querySelectorAll(locator):document.querySelectorAll('body *'),out=[],norm=s=>(s||'').replace(/\\s+/g,' ').trim(),visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0},enabled=e=>{for(let n=e;n&&n.nodeType===1;n=n.parentElement)if(n.disabled||n.getAttribute('aria-disabled')==='true')return false;return true};if(typeof locator!=='string'&&locator.by==='text'){const query=norm(locator.value),contains=new WeakSet(),leaf=new WeakSet();for(let i=nodes.length-1;i>=0;i--){const e=nodes[i];let childMatch=false;for(const child of e.children)if(contains.has(child)){childMatch=true;break}const match=query.length>0&&visible(e)&&norm(e.innerText)===query;if(match&&!childMatch)leaf.add(e);if(match||childMatch)contains.add(e)}for(let index=0;index<nodes.length&&out.length<limit;index++){const e=nodes[index];if(!leaf.has(e))continue;const r=e.getBoundingClientRect(),role=e.getAttribute('role')||roles[e.tagName]||e.tagName.toLowerCase(),name=(e.getAttribute('aria-label')||e.innerText||e.getAttribute('alt')||'').trim().slice(0,300);out.push({index,role,accessibleName:name,text:(e.innerText||'').trim().slice(0,500),enabled:enabled(e),visible:true,rect:{x:r.x,y:r.y,width:r.width,height:r.height}})}return out}for(let index=0;index<nodes.length&&out.length<limit;index++){const e=nodes[index],r=e.getBoundingClientRect(),s=getComputedStyle(e),isVisible=visible(e),role=e.getAttribute('role')||roles[e.tagName]||e.tagName.toLowerCase(),name=(e.getAttribute('aria-label')||e.innerText||e.getAttribute('alt')||'').trim().slice(0,300),placeholderMatch=(e.tagName==='TEXTAREA'||e.tagName==='INPUT'&&['text','search','url','tel','email','password'].includes(e.type))&&e.getAttribute('placeholder')===locator.value,labelMatch=typeof locator!=='string'&&locator.by==='label'&&(e.tagName==='TEXTAREA'||e.tagName==='SELECT'||e.tagName==='INPUT'&&e.type!=='hidden')&&[...(e.labels||[])].some(label=>visible(label)&&norm(label.innerText)===norm(locator.value));if(typeof locator!=='string'&&!(locator.by==='role'?role===locator.role&&(locator.name===undefined||name===locator.name):locator.by==='test_id'?e.getAttribute('data-testid')===locator.value:locator.by==='placeholder'?placeholderMatch:locator.by==='label'&&labelMatch))continue;out.push({index,role,accessibleName:name,text:(e.innerText||'').trim().slice(0,500),enabled:!e.disabled,visible:isVisible,rect:{x:r.x,y:r.y,width:r.width,height:r.height}})}return out;`, args: [selector, limit] });
    return Array.isArray(summary.value) ? summary.value as DesktopCandidateSummary[] : [];
  }
  async keypress(keys: string[]): Promise<void> {
    this.requireSession(); if (!Array.isArray(keys) || keys.length < 1 || keys.length > 100 || keys.some(k => typeof k !== 'string' || k.length > 100)) throw Error('keypress accepts 1–100 key strings, each at most 100 characters.');
    const actions = keys.flatMap(key => [...key].map(value => [{ type: 'keyDown', value }, { type: 'keyUp', value }])).flat();
    await this.request('POST', '/actions', { actions: [{ type: 'key', id: 'desktop-keyboard', actions }] });
  }
  async scroll(selector?: DesktopLocator, x = 0, y = 500): Promise<void> {
    this.requireSession(); bounded(Math.abs(x), 0, 100_000, 'scroll x'); bounded(Math.abs(y), 0, 100_000, 'scroll y');
    if (selector !== undefined) { if (typeof selector === 'string') this.validateSelector(selector); else this.validateLocator(selector); }
    if (selector && typeof selector !== 'string') {
      const element = await this.findElement(selector, true);
      await this.request('POST', '/execute/sync', { script: 'arguments[0].scrollIntoView({block:"center",inline:"center"});', args: [{ 'element-6066-11e4-a52e-4f735466cecf': element }] });
      return;
    }
    await this.request('POST', '/execute/sync', { script: selector ? `const e=document.querySelector(arguments[0]);if(!e)throw new Error('Selector not found');e.scrollIntoView({block:'center',inline:'center'});` : 'window.scrollBy(arguments[0],arguments[1]);', args: selector ? [selector] : [x, y] });
  }
  async waitFor(selector: DesktopLocator, state: 'present' | 'visible' | 'hidden' | 'enabled' = 'visible', timeoutMs = 5000): Promise<boolean> {
    this.requireSession(); if (typeof selector === 'string') this.validateSelector(selector); else this.validateLocator(selector); bounded(timeoutMs, 0, 10_000, 'timeoutMs');
    const deadline = Date.now() + timeoutMs;
    do {
      const found = await this.find(selector, 1);
      const matches = state === 'present' ? found.length > 0 : state === 'hidden' ? found.length === 0 || !found[0]!.visible : state === 'visible' ? Boolean(found[0]?.visible) : Boolean(found[0]?.enabled);
      if (matches) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return false;
  }
  async resizeWindow(width: number, height: number): Promise<DesktopRect> {
    this.requireSession(); bounded(width, 1, 10_000, 'width'); bounded(height, 1, 10_000, 'height');
    try { return (await this.request('POST', '/window/rect', { width, height })).value as DesktopRect; }
    catch (error) { throw Error(`Window resize is unsupported by this tauri-driver/session: ${message(error)}`); }
  }
  /** Temporarily resize the managed window around one operation, restoring its complete original rect. */
  async withWindowSize<T>(width: number, height: number, callback: () => Promise<T>): Promise<T> {
    this.requireSession(); bounded(width, 1, 10_000, 'width'); bounded(height, 1, 10_000, 'height');
    const original = (await this.request('GET', '/window/rect')).value as DesktopRect;
    const positionIsValid = (value: unknown) => Number.isSafeInteger(value) && Math.abs(value as number) <= 1_000_000;
    if (!original || !positionIsValid(original.x) || !positionIsValid(original.y)
      || !Number.isInteger(original.width) || original.width < 1 || original.width > 10_000
      || !Number.isInteger(original.height) || original.height < 1 || original.height > 10_000) {
      throw Error('WebDriver returned an invalid original window rect.');
    }
    let value!: T, callbackError: unknown, callbackFailed = false;
    try {
      await this.request('POST', '/window/rect', { width, height });
      value = await callback();
    } catch (error) { callbackError = error; callbackFailed = true; }
    let restoreError: unknown, restoreFailed = false;
    try { await this.request('POST', '/window/rect', original); } catch (error) { restoreError = error; restoreFailed = true; }
    if (callbackFailed && restoreFailed) throw new AggregateError([callbackError, restoreError], 'Window operation and original window rect restoration both failed.');
    if (restoreFailed) throw new Error(`Could not restore original WebDriver window rect: ${message(restoreError)}`, { cause: restoreError });
    if (callbackFailed) throw callbackError;
    return value;
  }
  async capture(kind: CaptureKind): Promise<DesktopCapture> {
    if (kind !== 'webview' && kind !== 'window') throw Error('Capture kind must be webview or window.');
    const dir = await this.artifactDirectory();
    const selectors = this.config.maskSelectors;
    let maskId: string | undefined, maskSecret: string | undefined, maskElement: WebDriverElementReference | undefined, capture: DesktopCapture | undefined;
    try {
      if (selectors !== undefined) {
        if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > 20 || selectors.some(s => typeof s !== 'string' || !s.length || s.length > 500)) throw Error('Configured desktop mask selector policy is invalid.');
        if (selectors.some(selector => !isStableMaskSelector(selector))) throw Error(MASK_SELECTOR_SUBSET_ERROR);
        this.requireSession();
        maskId = `umb-mask-${randomUUID()}`;
        maskSecret = randomUUID();
        const installed = await this.captureRequest('POST', '/execute/sync', { script: MASK_INSTALL_SCRIPT, args: [selectors, maskId, maskSecret] });
        maskElement = parseElementReference(installed.value);
        if (!maskElement) throw Error('WebDriver did not return a trusted mask element reference; the managed session must be stopped.');
        const painted = await this.captureRequest('POST', '/execute/async', { script: `const dlg=arguments[0],id=arguments[1],secret=arguments[2],done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>{try{if(!(dlg instanceof HTMLDialogElement)||!dlg.isConnected||!dlg.open||dlg.dataset.umbCaptureMask!==id||dlg.__umbMaskState?.invalidReason)throw new Error('mask missing');if(dlg.__umbMaskCheck(secret)!==true)throw new Error('mask update failed');done(true)}catch(e){done({error:'mask geometry unavailable'})}}));`, args: [maskElement, maskId, maskSecret] });
        if (painted.value !== true) throw Error('Desktop mask geometry changed or could not be painted.');
      }
      capture = await this.captureUnmasked(kind, dir, maskId, maskSecret, maskElement);
    } catch (error) {
      if (maskId && maskSecret && maskElement) await this.cleanupMask(maskId, maskSecret, maskElement, undefined, error);
      else if (maskId) {
        try { await this.killDriver(); } catch (stopError) { throw new AggregateError([error, stopError], `Could not establish a trusted mask element and managed session stop failed: ${message(stopError)}`); }
      }
      throw error;
    }
    if (maskId && maskSecret && maskElement) await this.cleanupMask(maskId, maskSecret, maskElement, capture);
    if (!capture) throw Error('Desktop capture produced no image.');
    return capture;
  }

  private async cleanupMask(maskId: string, secret: string, element: WebDriverElementReference, capture?: DesktopCapture, cause?: unknown): Promise<void> {
    try { await this.captureRequest('POST', '/execute/sync', { script: MASK_REMOVE_SCRIPT, args: [element, secret, maskId] }); }
    catch (error) {
      let stopError: unknown; try { await this.killDriver(); } catch (stopFailure) { stopError = stopFailure; }
      let deletionError: unknown;
      if (capture) try { await this.removeArtifact(capture.artifactRef); } catch (removeError) { deletionError = removeError; }
      const failures = [error, ...(cause === undefined ? [] : [cause]), ...(deletionError === undefined ? [] : [deletionError]), ...(stopError === undefined ? [] : [stopError])];
      const priorStopFailure = /stop failed|remained alive after SIGKILL/i.test(message(error));
      const stopFailure = stopError ?? (priorStopFailure ? error : undefined);
      const stopMessage = stopFailure === undefined ? 'managed session was stopped' : `managed session stop failed: ${message(stopFailure)}`;
      if (deletionError !== undefined) throw new ArtifactCleanupError(failures, `Could not restore desktop mask; ${stopMessage} and artifact deletion failed.`);
      if (failures.length > 1) throw new AggregateError(failures, `Could not restore desktop mask; ${stopMessage}.`);
      throw Error(`Could not restore desktop mask; ${stopMessage}: ${message(error)}`, { cause: error });
    }
  }

  private async captureUnmasked(kind: CaptureKind, dir: string, maskId?: string, maskSecret?: string, maskElement?: WebDriverElementReference): Promise<DesktopCapture> {
    if (kind === 'webview') {
      this.requireSession();
        if (maskId && maskSecret && maskElement) await this.assertMaskIntact(maskId, maskSecret, maskElement);
      // WebDriver checks and screenshot retrieval are separate requests, not an atomic capture.
      // Recheck the live mask after bytes arrive and before decoding or publishing them.
      const result = await this.captureRequest('GET', '/screenshot');
      if (maskId && maskSecret && maskElement) await this.assertMaskIntact(maskId, maskSecret, maskElement);
      const encoded = result.value;
      if (typeof encoded !== 'string') throw Error('WebDriver returned no screenshot data.');
      if (encoded.length > Math.ceil(MAX_SUPPORTED_PNG_BYTES / 3) * 4) throw Error('WebDriver screenshot exceeds the 8 MiB PNG input limit.');
      const bytes = Buffer.from(encoded, 'base64'); validatePng(bytes);
      this.checkFileSize(bytes.length);
      await this.checkQuota(dir, bytes.length);
      const file = await this.savePng(dir, bytes);
      try { return this.captureMetadata(kind, file, bytes); } catch (error) {
        try { await fs.rm(file, { force: true }); } catch (removeError) { throw new ArtifactCleanupError([error, removeError], 'Could not delete the captured PNG after metadata failure.'); }
        throw error;
      }
    }
    this.requireSession();
    await this.rememberOwnedTree();
    if (maskId && maskSecret && maskElement) await this.assertMaskIntact(maskId, maskSecret, maskElement);
    if (process.platform !== 'linux' || process.env.WAYLAND_DISPLAY || !process.env.DISPLAY) throw Error(process.env.WAYLAND_DISPLAY ? 'Window capture denied: Wayland has no configured consented portal backend; no desktop fallback is permitted.' : 'Window capture unavailable: Linux X11 DISPLAY is required.');
    if (!this.config.windowTitle) throw Error('Window capture requires an exact configured windowTitle.');
    if (!this.driver?.pid) throw Error('Cannot verify managed app process ownership.');
    const ownedPids = await this.adapters.processTree(this.driver.pid);
    for (const pid of ownedPids) this.ownedPids.add(pid);
    const windows = await this.boundedCommand('wmctrl', ['-lp']);
    if (windows.code !== 0) throw Error(`Cannot enumerate X11 windows with wmctrl: ${windows.stderr || windows.stdout}`);
    const candidates = windows.stdout.split(/\r?\n/).map(line => {
      const m = /^\s*(0x[\da-f]+)\s+\S+\s+(\d+)\s+\S+\s+(.*)$/.exec(line);
      return m ? { id: m[1]!, pid: Number(m[2]), title: m[3]! } : undefined;
    }).filter((x): x is { id: string; pid: number; title: string } => Boolean(x));
    const target = candidates.find(w => w.title === this.config.windowTitle && ownedPids.has(w.pid));
    if (!target) throw Error(`No X11 window with exact title ${JSON.stringify(this.config.windowTitle)} belongs to managed driver process tree; refusing unrelated-window capture.`);
    await this.checkQuota(dir, 0);
    const file = await this.reservePath(dir);
    try {
      if (maskId && maskSecret && maskElement) await this.assertMaskIntact(maskId, maskSecret, maskElement);
      const captured = await this.boundedCommand('import', ['-window', target.id, file]);
      if (captured.code !== 0) throw Error(`Window-targeted X11 capture failed (permission/backend): ${captured.stderr || captured.stdout}`);
      // X11 import is likewise non-atomic with WebDriver integrity checks; fail closed before reading/publishing.
      if (maskId && maskSecret && maskElement) await this.assertMaskIntact(maskId, maskSecret, maskElement);
      await this.assertNoSymlinks(file, false);
      const capturedInfo = await fs.lstat(file);
      if (capturedInfo.isSymbolicLink() || !capturedInfo.isFile()) throw Error('Window capture did not produce a regular PNG file.');
      await fs.chmod(file, 0o600);
      this.checkFileSize(capturedInfo.size);
      const bytes = await fs.readFile(file);
      validatePng(bytes); this.checkFileSize(bytes.length);
      await this.checkQuota(dir, bytes.length, file);
      return this.captureMetadata(kind, file, bytes);
    } catch (error) {
      try { await fs.rm(file, { force: true }); } catch (removeError) { throw new ArtifactCleanupError([error, removeError], 'Could not delete the reserved X11 PNG after capture failure.'); }
      throw error;
    }
  }

  private async captureRequest(method: string, resource: string, body?: unknown): Promise<any> {
    try { return await this.request(method, resource, body, WEBDRIVER_CAPTURE_TIMEOUT_MS); }
    catch (error) {
      if (error instanceof WebDriverTimeoutError) {
        try { await this.killDriver(); } catch (stopError) { throw new AggregateError([error, stopError], `WebDriver capture failed and managed session stop failed: ${message(stopError)}`); }
      }
      throw error;
    }
  }
  private async assertMaskIntact(maskId: string, secret: string, element: WebDriverElementReference): Promise<void> {
    const result = await this.captureRequest('POST', '/execute/sync', { script: MASK_CHECK_SCRIPT, args: [element, maskId, secret] });
    if (result.value !== true) throw Error('Desktop mask integrity could not be verified.');
  }
  private async boundedCommand(executable: string, args: string[]): Promise<DesktopCommandResult> {
    return this.adapters.command(executable, args, 5000);
  }
  private async fetchBounded(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.adapters.fetch(url, { ...init, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new WebDriverTimeoutError(timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Read a canonical project-root-relative desktop artifact ref after bounded integrity verification. */
  async readArtifact(reference: string, expectedSha256: string, expectedByteLength: number): Promise<Buffer> {
    const dir = await this.artifactDirectory();
    if (typeof reference !== 'string' || reference.includes('\\') || path.posix.isAbsolute(reference) || reference.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Invalid desktop artifact reference.');
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw Error('Invalid desktop artifact SHA-256.');
    const configuredMaxBytes = this.config.maxArtifactFileBytes ?? 20 * 1024 * 1024;
    bounded(configuredMaxBytes, 1, 500 * 1024 * 1024, 'maxArtifactFileBytes');
    const maxBytes = Math.min(configuredMaxBytes, MAX_SUPPORTED_PNG_BYTES);
    bounded(expectedByteLength, 1, maxBytes, 'artifact byte length');
    const target = this.resolveArtifactReference(dir, reference);
    try { await this.assertNoSymlinks(target, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Error('Desktop artifact is missing.'); throw error; }
    const info = await fs.lstat(target).catch(() => { throw Error('Desktop artifact is missing or inaccessible.'); });
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedByteLength || info.size > maxBytes) throw Error('Desktop artifact is missing, not a regular PNG file, or has an invalid size.');
    const bytes = await fs.readFile(target);
    validatePng(bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== expectedSha256) throw Error('Desktop artifact integrity verification failed.');
    return bytes;
  }

  /** Persist generated PNG bytes under the same bounded, private artifact policy as captures. */
  async saveGeneratedArtifact(bytes: Buffer): Promise<GeneratedDesktopArtifact> {
    if (!Buffer.isBuffer(bytes)) throw Error('Generated desktop artifact must be PNG bytes.');
    validatePng(bytes);
    this.checkFileSize(bytes.length);
    const dir = await this.artifactDirectory();
    await this.checkQuota(dir, bytes.length);
    const file = await this.savePng(dir, bytes);
    const dimensions = pngDimensions(bytes);
    return {
      path: file, artifactRef: this.projectReference(file),
      sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
      mimeType: 'image/png', ...dimensions,
    };
  }

  /** Delete only old canonical managed PNGs not present in the caller's complete reference set. */
  async pruneUnreferencedArtifacts(references: readonly string[], maxAgeDays: number, now = Date.now()): Promise<string[]> {
    bounded(maxAgeDays, 1, 3650, 'maxArtifactAgeDays');
    const dir = await this.artifactDirectory();
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    const retained = new Set(references);
    const removed: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}\.png$/.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      const ref = this.projectReference(file);
      if (retained.has(ref)) continue;
      const info = await fs.lstat(file);
      if (info.isSymbolicLink() || !info.isFile() || info.mtimeMs > cutoff) continue;
      await fs.unlink(file);
      removed.push(ref);
    }
    return removed;
  }

  /** Remove a managed artifact by canonical ref (intended for rollback after failed persistence). */
  async removeArtifact(reference: string): Promise<void> {
    const dir = await this.artifactDirectory();
    const file = this.resolveArtifactReference(dir, reference);
    await this.assertNoSymlinks(file, true);
    try { await fs.rm(file, { force: true }); } catch (error) { throw new ArtifactCleanupError([error], 'Could not delete the managed desktop artifact.'); }
  }

  private captureMetadata(kind: CaptureKind, file: string, bytes: Buffer): DesktopCapture {
    return { kind, path: file, artifactRef: this.projectReference(file), sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, mimeType: 'image/png', ...pngDimensions(bytes), bytes };
  }
  private projectReference(file: string): string { return path.relative(this.root, file).split(path.sep).join('/'); }
  private resolveArtifactReference(dir: string, reference: string): string {
    if (typeof reference !== 'string' || reference.includes('\\') || path.posix.isAbsolute(reference) || reference.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Invalid canonical desktop artifact reference.');
    const filename = path.posix.basename(reference);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(filename)) throw Error('Invalid canonical desktop artifact reference.');
    const target = path.join(dir, filename);
    if (!this.within(dir, path.resolve(this.root, ...reference.split('/'))) || path.resolve(this.root, ...reference.split('/')) !== target || this.projectReference(target) !== reference) throw Error('Desktop artifact reference is outside the managed desktop artifact directory.');
    return target;
  }

  private endpoint(): string { return `http://${this.host}:${this.port}`; }
  private async runBuildIfConfigured(): Promise<void> {
    const build = this.config.buildCommand;
    if (!build) return;
    if (!build.command || build.command.includes('\0') || !Array.isArray(build.args) || build.args.length > 256 || build.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 16_384)) {
      throw Error('Configured buildCommand must contain a non-empty exact command and at most 256 string arguments (each at most 16384 characters).');
    }
    const cwdInput = build.cwd ?? this.config.buildCwd ?? '.';
    const cwd = path.resolve(this.root, cwdInput);
    const [realRoot, realCwd] = await Promise.all([fs.realpath(this.root), fs.realpath(cwd).catch(() => { throw Error(`Configured build cwd does not exist: ${cwd}`); })]);
    const cwdStat = await fs.stat(realCwd);
    if (!cwdStat.isDirectory() || (realCwd !== realRoot && !realCwd.startsWith(realRoot + path.sep))) throw Error('Configured build cwd must be a directory within projectRoot.');
    const timeoutMs = this.config.buildTimeoutMs ?? this.config.readinessTimeoutMs ?? 5000;
    bounded(timeoutMs, 1, 600_000, 'buildTimeoutMs');

    const completion = new Promise<void>((resolve, reject) => {
      let stdout = '', stderr = '', spawnError: Error | undefined;
      let stopReason: 'timeout' | 'stopped' | undefined;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let killEscalation: NodeJS.Timeout | undefined;
      let child: ChildProcess;
      try { child = this.adapters.spawn(build.command, build.args, { cwd: realCwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { reject(Error(`Could not start configured build command ${JSON.stringify(build.command)} (exit status unavailable): ${message(error)}\nstdout: (empty)\nstderr: (empty)`)); return; }
      this.buildProcess = child;
      const capture = (current: string, chunk: unknown): string => (current + String(chunk)).slice(0, 2000);
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout = capture(stdout, chunk); });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = capture(stderr, chunk); });
      const terminate = (signal: NodeJS.Signals) => {
        try { child.kill(signal); } catch { /* child may have exited */ }
      };
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (killEscalation) clearTimeout(killEscalation);
        if (this.buildProcess === child) this.buildProcess = undefined;
        if (this.cancelBuild) this.cancelBuild = undefined;
        if (this.buildCompletion === completion) this.buildCompletion = undefined;
        const status = `exit status ${code === null ? 'unknown' : code}${signal ? ` (signal ${signal})` : ''}`;
        const excerpts = `stdout: ${stdout || '(empty)'}\nstderr: ${stderr || '(empty)'}`;
        if (spawnError) reject(Error(`Could not start configured build command ${JSON.stringify(build.command)} (exit status unavailable): ${message(spawnError)}\n${excerpts}`));
        else if (stopReason === 'timeout') reject(Error(`Configured build command timed out after ${timeoutMs}ms (${status}).\n${excerpts}`));
        else if (stopReason === 'stopped') reject(Error(`Configured build command was stopped (${status}).\n${excerpts}`));
        else if (code !== 0) reject(Error(`Configured build command failed (${status}).\n${excerpts}`));
        else resolve();
      };
      const cancel = (reason: 'timeout' | 'stopped') => {
        if (settled) return;
        stopReason = reason;
        terminate('SIGTERM');
        killEscalation = setTimeout(() => terminate('SIGKILL'), 500);
        killEscalation.unref();
      };
      this.cancelBuild = () => cancel('stopped');
      timeout = setTimeout(() => cancel('timeout'), timeoutMs);
      timeout.unref();
      child.once('error', error => { spawnError = error; finish(null, null); });
      child.once('close', (code, signal) => finish(code, signal));
    });
    this.buildCompletion = completion;
    await completion;
  }
  private requireSession(): void { if (!this.sessionId) throw Error('No managed WebDriver session. Start one before interacting or capturing.'); }
  private async resolveBinary(): Promise<string> {
    if (!this.config.tauriBinary) throw Error('Configure tauriBinary as an absolute or project-relative Tauri executable path.');
    return path.resolve(this.root, this.config.tauriBinary);
  }
  private async request(method: string, resource: string, body?: unknown, timeoutMs = this.actionRequestTimeoutMs ?? WEBDRIVER_REQUEST_TIMEOUT_MS): Promise<any> {
    const sessionResource = resource === '/session' || resource.startsWith('/session/')
      ? resource
      : this.sessionId ? `/session/${encodeURIComponent(this.sessionId)}${resource.startsWith('/') ? resource : `/${resource}`}` : resource;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new WebDriverTimeoutError(timeoutMs)); }, timeoutMs);
    });
    try {
      const result = await Promise.race([
        this.adapters.fetch(`${this.endpoint()}${sessionResource.startsWith('/') ? sessionResource : `/${sessionResource}`}`, {
          method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
        }).then(async response => ({ response, json: await response.json().catch(() => ({})) as any })),
        timedOut,
      ]);
      const { response, json } = result;
      if (!response.ok || json.value?.error) throw Error(`WebDriver ${method} ${resource} failed: ${json.value?.message ?? json.message ?? response.statusText}`);
      return json;
    } finally { if (timer) clearTimeout(timer); }
  }
  private validateSelector(selector: string): void { if (!selector || selector.length > 2000) throw Error('Selector must contain 1–2000 characters.'); }
  private validateLocator(locator: Exclude<DesktopLocator, string>): void {
    if (!locator || typeof locator !== 'object' || Array.isArray(locator) || (Object.getPrototypeOf(locator) !== Object.prototype && Object.getPrototypeOf(locator) !== null)) throw Error('Invalid desktop locator.');
    const keys = Object.keys(locator);
    if (locator.by === 'role') {
      if (keys.some(key => !['by', 'role', 'name'].includes(key)) || !keys.includes('role') || typeof locator.role !== 'string' || !locator.role || locator.role.length > 100
        || (Object.hasOwn(locator, 'name') && (typeof locator.name !== 'string' || locator.name.length > 300))) throw Error('Invalid desktop locator.');
    } else if (locator.by === 'test_id') {
      if (keys.length !== 2 || keys.some(key => !['by', 'value'].includes(key)) || typeof locator.value !== 'string' || !locator.value || locator.value.length > 1000) throw Error('Invalid desktop locator.');
    } else if (locator.by === 'placeholder' || locator.by === 'label' || locator.by === 'text') {
      if (keys.length !== 2 || keys.some(key => !['by', 'value'].includes(key)) || typeof locator.value !== 'string' || locator.value.length < 1 || locator.value.length > 1000) throw Error('Invalid desktop locator.');
    } else throw Error('Invalid desktop locator.');
  }
  private async findElement(selector: DesktopLocator, requireAction = false): Promise<string> {
    this.requireSession(); if (typeof selector === 'string') this.validateSelector(selector); else this.validateLocator(selector);
    if (typeof selector !== 'string') {
       const result = await this.request('POST', '/execute/sync', { script: `const l=arguments[0],roles={A:'link',BUTTON:'button',INPUT:'textbox',TEXTAREA:'textbox',SELECT:'combobox'},nodes=document.querySelectorAll('body *'),out=[];const norm=s=>(s||'').replace(/\\s+/g,' ').trim();if(l.by==='text'){const query=norm(l.value),visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0},contains=new WeakSet(),leaf=new WeakSet();for(let i=nodes.length-1;i>=0;i--){const e=nodes[i];let childMatch=false;for(const child of e.children)if(contains.has(child)){childMatch=true;break}const match=query.length>0&&visible(e)&&norm(e.innerText)===query;if(match&&!childMatch)leaf.add(e);if(match||childMatch)contains.add(e)}const refs=[];for(let i=0;i<nodes.length&&refs.length<2;i++)if(leaf.has(nodes[i]))refs.push(nodes[i]);return refs}for(let i=0;i<nodes.length&&out.length<2;i++){const e=nodes[i],role=e.getAttribute('role')||roles[e.tagName]||e.tagName.toLowerCase(),name=(e.getAttribute('aria-label')||e.innerText||e.getAttribute('alt')||'').trim().slice(0,300),placeholderMatch=(e.tagName==='TEXTAREA'||e.tagName==='INPUT'&&['text','search','url','tel','email','password'].includes(e.type))&&e.getAttribute('placeholder')===l.value,labelMatch=l.by==='label'&&(e.tagName==='TEXTAREA'||e.tagName==='SELECT'||e.tagName==='INPUT'&&e.type!=='hidden')&&[...(e.labels||[])].some(label=>{const s=getComputedStyle(label),r=label.getBoundingClientRect(),visible=s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0;return visible&&(label.innerText||'').replace(/\\s+/g,' ').trim()===l.value.replace(/\\s+/g,' ').trim()}),matches=l.by==='role'?role===l.role&&(l.name===undefined||name===l.name):l.by==='test_id'?e.getAttribute('data-testid')===l.value:l.by==='placeholder'?placeholderMatch:l.by==='label'&&labelMatch;if(matches)out.push(e)}return out;`, args: [selector] });
      const matches = Array.isArray(result.value) ? result.value : [];
      const candidates = await this.find(selector, 5).catch(() => []);
       if (matches.length !== 1) throw Error(`Locator must match exactly one element (matches: ${matches.length === 0 ? '0' : '2 or more'}); candidates: ${JSON.stringify(candidates.map(({ index, role, accessibleName, enabled, visible }) => selector.by === 'text' ? ({ index, role, enabled, visible }) : ({ index, role, accessibleName, enabled, visible })))}`);
      const element = matches[0]?.['element-6066-11e4-a52e-4f735466cecf'] ?? matches[0]?.ELEMENT;
      if (typeof element !== 'string') throw Error('WebDriver did not return an element reference.');
      if (requireAction) {
        const state = await this.request('POST', '/execute/sync', { script: `const e=arguments[0],s=getComputedStyle(e),r=e.getBoundingClientRect();let enabled=true;for(let n=e;n&&n.nodeType===1;n=n.parentElement)if(n.disabled||n.getAttribute('aria-disabled')==='true')enabled=false;return {visible:s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0,enabled};`, args: [{ 'element-6066-11e4-a52e-4f735466cecf': element }] });
        if (state.value?.visible !== true || state.value?.enabled !== true) throw Error(`Locator target must be visible and enabled; visible: ${state.value?.visible === true}, enabled: ${state.value?.enabled === true}.`);
      }
      return element;
    }
    const result = await this.request('POST', '/elements', { using: 'css selector', value: selector });
    const matches = Array.isArray(result.value) ? result.value : [];
    if (matches.length !== 1) {
      const candidates = await this.find(selector, 5).catch(() => []);
      throw Error(`Selector must match exactly one element (matches: ${matches.length}); candidates: ${JSON.stringify(candidates.map(({ index, role, accessibleName }) => ({ index, role, accessibleName })))}`);
    }
    const element = matches[0]?.['element-6066-11e4-a52e-4f735466cecf'] ?? matches[0]?.ELEMENT;
    if (typeof element !== 'string') throw Error('WebDriver did not return an element reference.'); return element;
  }
  private async elementAction(selector: DesktopLocator, action: string, body?: unknown): Promise<void> {
    const e = await this.findElement(selector, true); await this.request('POST', `/element/${encodeURIComponent(e)}/${action}`, body);
  }
  private async killDriver(): Promise<void> {
    const driver = this.driver; this.driver = undefined; this.sessionId = undefined;
    const driverPid = driver?.pid ?? this.managedDriverPid;
    if (!driverPid && !this.ownedPids.size) return;
    if (driverPid) for (const pid of await this.adapters.processTree(driverPid).catch(() => new Set<number>())) this.ownedPids.add(pid);
    const descendants = [...this.ownedPids].filter(pid => pid !== driverPid).reverse();
    const isAlive = (pid: number) => { try { return this.adapters.isProcessAlive(pid); } catch { return true; } };
    const groupAlive = (pid: number) => { try { return this.adapters.isProcessGroupAlive(pid); } catch { return true; } };
    if (process.platform === 'linux' && driverPid) {
      // Linux launch uses detached=true, making pid an isolated process-group id that survives leader exit.
      let termError: unknown;
      try { this.adapters.killProcessGroup(driverPid, 'SIGTERM'); } catch (error) { termError = error; }
      const termWasEsrch = (termError as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
      const groupPresentAfterTerm = groupAlive(driverPid);
      if (termError !== undefined && (groupPresentAfterTerm || termWasEsrch)) {
        // A failed group signal is not evidence of termination. Try tracked PIDs, then verify/retry by group.
        for (const pid of descendants) try { this.adapters.killProcess(pid, 'SIGTERM'); } catch { /* process may have exited */ }
        if (driver && driver.exitCode === null) try { driver.kill('SIGTERM'); } catch { /* driver may have exited */ }
        const fallbackDeadline = Date.now() + 250;
        while (groupAlive(driverPid) && Date.now() < fallbackDeadline) await new Promise(resolve => setTimeout(resolve, 25));
        for (const pid of descendants) if (isAlive(pid)) try { this.adapters.killProcess(pid, 'SIGKILL'); } catch { /* process may have exited */ }
        if (driver && driver.exitCode === null) try { driver.kill('SIGKILL'); } catch { /* driver may have exited */ }
      }
      if (groupAlive(driverPid)) {
        // Also retry group SIGKILL after successful TERM if graceful shutdown did not finish.
        if (termError === undefined) {
          const deadline = Date.now() + 1500;
          while (groupAlive(driverPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      if (groupAlive(driverPid)) {
        let killError: unknown;
        try { this.adapters.killProcessGroup(driverPid, 'SIGKILL'); } catch (error) { killError = error; }
        const killDeadline = Date.now() + 3000;
        while (groupAlive(driverPid) && Date.now() < killDeadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (groupAlive(driverPid)) {
          const signalFailures = [termError, killError].filter((error): error is Error => error instanceof Error).map(error => error.message);
          throw Error(`Managed Linux driver process group ${driverPid} remained alive after SIGKILL${signalFailures.length ? ` (signal errors: ${signalFailures.join('; ')})` : ''}.`);
        }
      }
    } else {
      for (const pid of descendants) try { this.adapters.killProcess(pid, 'SIGTERM'); } catch { /* process may have exited */ }
      if (driver && driver.exitCode === null) {
        const exited = new Promise<void>(resolve => driver.once('exit', () => resolve()));
        try { driver.kill('SIGTERM'); } catch { /* spawn may have failed */ }
        await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 1500))]);
      }
      // Non-Linux platforms retain the prior owned-PID fallback.
      for (const pid of descendants) if (isAlive(pid)) try { this.adapters.killProcess(pid, 'SIGKILL'); } catch { /* process may have exited */ }
      if (driver && driver.exitCode === null) try { driver.kill('SIGKILL'); } catch { /* already exited */ }
    }
    if (driverPid) try { for (const pid of await this.adapters.processTree(driverPid)) if (pid !== driverPid && !this.ownedPids.has(pid)) { this.ownedPids.add(pid); try { this.adapters.killProcess(pid, 'SIGKILL'); } catch { /* process may have exited */ } } } catch { /* driver exit may hide process-tree details; Linux group already handled */ }
    for (const pid of [...this.ownedPids]) if (!isAlive(pid)) this.ownedPids.delete(pid);
    if (!this.ownedPids.size) this.managedDriverPid = undefined;
  }

  private async rememberOwnedTree(): Promise<void> {
    const pid = this.driver?.pid ?? this.managedDriverPid;
    if (!pid) return;
    for (const owned of await this.adapters.processTree(pid).catch(() => new Set<number>([pid]))) this.ownedPids.add(owned);
  }
  private async artifactDirectory(): Promise<string> {
    if (!this.config.artifactDirectory) throw Error('Configure the parent-managed project artifactDirectory before capturing. No artifact directory is created implicitly.');
    const root = path.resolve(this.root, this.config.artifactDirectory);
    if (!this.within(this.root, root)) throw Error('Configured artifactDirectory must stay within the desktop project root.');
    await this.ensureDirectoryPath(this.root);
    await this.ensureDirectoryPath(root);
    const dir = path.join(root, '.umb-managed', 'desktop');
    await this.ensureDirectoryPath(dir);
    return dir;
  }
  private within(root: string, target: string): boolean { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
  private async assertNoSymlinks(target: string, allowMissing: boolean): Promise<void> {
    const absolute = path.resolve(target), parsed = path.parse(absolute);
    let current = parsed.root;
    for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const info = await fs.lstat(current).catch(error => { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (info?.isSymbolicLink()) throw Error(`Symlinks are not permitted in desktop artifact paths: ${current}`);
      if (!info && allowMissing) return;
    }
  }
  private async ensureDirectoryPath(target: string): Promise<void> {
    const absolute = path.resolve(target);
    if (!this.within(this.root, absolute)) throw Error('Desktop artifact paths must stay within the desktop project root.');
    const relative = path.relative(this.root, absolute);
    await this.assertNoSymlinks(this.root, false);
    let current = this.root;
    for (const component of relative ? relative.split(path.sep) : []) {
      current = path.join(current, component);
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) throw Error(`Symlinks are not permitted in desktop artifact paths: ${current}`);
      if (!info.isDirectory()) throw Error(`Desktop artifact path component must be a regular directory: ${current}`);
      await fs.chmod(current, 0o700);
    }
  }
  private async checkQuota(dir: string, incomingBytes: number, exclude?: string): Promise<void> {
    const maxCount = this.config.maxArtifactCount ?? 100, maxBytes = this.config.maxArtifactBytes ?? 20 * 1024 * 1024;
    bounded(maxCount, 1, 10_000, 'maxArtifactCount'); bounded(maxBytes, 1, 500 * 1024 * 1024, 'maxArtifactBytes');
    let count = 0, bytes = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.name.endsWith('.png')) continue;
      const file = path.join(dir, entry.name); if (file === exclude) continue;
      const info = await fs.lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) throw Error('Desktop artifact directory contains a non-regular PNG file.');
      count++; bytes += info.size;
    }
    if (count >= maxCount || bytes + incomingBytes > maxBytes) throw Error(`Desktop artifact quota exceeded (maximum ${maxCount} PNGs and ${maxBytes} bytes).`);
  }
  private checkFileSize(bytes: number): void {
    const configuredMaxFileBytes = this.config.maxArtifactFileBytes ?? 20 * 1024 * 1024;
    bounded(configuredMaxFileBytes, 1, 500 * 1024 * 1024, 'maxArtifactFileBytes');
    const maxFileBytes = Math.min(configuredMaxFileBytes, MAX_SUPPORTED_PNG_BYTES);
    if (bytes > maxFileBytes) throw Error(`Screenshot exceeds the per-file desktop artifact limit of ${maxFileBytes} bytes.`);
  }
  private async commandAvailable(executable: string, args: string[]): Promise<boolean> {
    try { return (await this.adapters.command(executable, args)).code === 0; } catch { return false; }
  }
  private async uniquePath(dir: string): Promise<string> {
    for (let i = 0; i < 5; i++) { const file = path.join(dir, `desktop-${Date.now()}-${randomUUID()}.png`); if (!(await fs.lstat(file).then(() => true, () => false))) return file; }
    throw Error('Could not allocate a collision-safe screenshot filename.');
  }
  private async reservePath(dir: string): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const file = await this.uniquePath(dir);
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined, created = false;
      try { handle = await fs.open(file, 'wx', 0o600); created = true; await handle.close(); handle = undefined; await fs.chmod(file, 0o600); return file; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        if (created) try { await fs.rm(file, { force: true }); } catch (removeError) { throw new ArtifactCleanupError([error, removeError], 'Could not clean a partial reserved artifact.'); }
        throw error;
      }
      finally { if (handle) await handle.close().catch(() => undefined); }
    }
    throw Error('Could not reserve a collision-safe screenshot filename.');
  }
  private async savePng(dir: string, bytes: Buffer): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const file = await this.uniquePath(dir);
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined, created = false;
      try { handle = await fs.open(file, 'wx', 0o600); created = true; await handle.writeFile(bytes); await handle.close(); handle = undefined; await fs.chmod(file, 0o600); return file; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        if (created) try { await fs.rm(file, { force: true }); } catch (removeError) { throw new ArtifactCleanupError([error, removeError], 'Could not clean a partial PNG artifact.'); }
        throw error;
      }
      finally { if (handle) await handle.close().catch(() => undefined); }
    }
    throw Error('Could not write a collision-safe screenshot filename.');
  }
}

function bounded(value: number, min: number, max: number, name: string): void { if (!Number.isInteger(value) || value < min || value > max) throw Error(`${name} must be between ${min} and ${max}.`); }
function validatePng(bytes: Buffer): void {
  try { inspectPng(bytes); }
  catch (error) { throw Error(`Capture backend did not produce a supported bounded PNG image: ${message(error)}`); }
}
function pngDimensions(bytes: Buffer): { width?: number; height?: number } {
  if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') return {};
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function parseElementReference(value: unknown): WebDriverElementReference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  const key = keys[0];
  const reference = (value as Record<string, unknown>)[key!];
  if (typeof reference !== 'string' || reference.length === 0) return undefined;
  if (key === 'element-6066-11e4-a52e-4f735466cecf' || key === 'ELEMENT') return value as WebDriverElementReference;
  return undefined;
}
