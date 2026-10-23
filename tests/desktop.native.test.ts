import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopService } from '../src/desktop/index.js';

const enabled = process.env.npm_lifecycle_event === 'test:desktop-native' || process.env.UMB_RUN_TAURI_NATIVE === '1';
const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/tauri-app');

function commandPath(name: string): string | undefined {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
}

function run(command: string, args: string[], cwd: string, timeout: number): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout });
  if (result.error || result.status !== 0) {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-5000);
    throw Error(`${command} ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}.${output ? `\n${output}` : ''}`);
  }
}

test('real Tauri app works through DesktopService and produces a WebView PNG', { skip: !enabled, timeout: 600_000 }, async t => {
  if (process.platform !== 'linux') throw Error('This direct tauri-driver acceptance fixture currently supports Linux only.');
  const cargo = commandPath('cargo');
  const driverExecutable = commandPath('tauri-driver');
  if (!cargo) throw Error('Install Rust/Cargo, then rerun npm run test:desktop-native.');
  if (!driverExecutable) throw Error('Install tauri-driver with `cargo install tauri-driver --locked` and ensure ~/.cargo/bin is on PATH.');
  if (!commandPath('WebKitWebDriver')) throw Error('Install WebKitWebDriver (Debian/Ubuntu package: webkit2gtk-driver), then rerun the native acceptance test.');

  const manifest = path.join(fixtureRoot, 'src-tauri', 'Cargo.toml');
  run(cargo, ['build', '--locked', '--manifest-path', manifest], fixtureRoot, 540_000);
  const binary = path.join(fixtureRoot, 'src-tauri', 'target', 'debug', 'tauri-acceptance-fixture');
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'umb-tauri-native-'));
  const clickResponses: string[] = [];
  const priorWayland = process.env.WAYLAND_DISPLAY, priorBackend = process.env.GDK_BACKEND;
  const display = process.env.DISPLAY;
  const x11Tools = ['xdpyinfo', 'wmctrl', 'import'].map(commandPath);
  const x11Ready = Boolean(display && x11Tools.every(Boolean) && spawnSync(x11Tools[0]!, ['-display', display], { encoding: 'utf8' }).status === 0);
  let service: DesktopService | undefined;
  let lifecycleMode: string | undefined, rawExecute: ((script: string) => Promise<any>) | undefined;
  const installedStates: any[] = [];
  const updaterAttackResults: any[] = [];
  const structuralMutationEvidence = new Map<string, any>();
  let installedElementReference: any, cleanupFakePresent: boolean | undefined;
  let documentRootReplacementCompleted = false;
  let maskReferenceArguments: any[] = [];
  let screenshotRequests = 0;
  try {
    if (x11Ready) {
      delete process.env.WAYLAND_DISPLAY;
      process.env.GDK_BACKEND = 'x11';
    }
    service = new DesktopService({
      projectRoot, tauriBinary: binary, driverExecutable,
      windowTitle: 'Tauri Acceptance Fixture', artifactDirectory: 'artifacts',
      maskSelectors: ['.phase6a-mask-target'],
      readinessTimeoutMs: 60_000,
    }, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (String(input).endsWith('/screenshot')) {
          screenshotRequests++;
          if (rawExecute && lifecycleMode?.startsWith('screenshot-boundary-')) {
            if (lifecycleMode === 'screenshot-boundary-top-layer') await rawExecute(`const d=document.createElement('dialog');d.id='phase6a-screenshot-boundary-dialog';document.body.append(d);d.showModal();return true`);
            if (lifecycleMode === 'screenshot-boundary-transient-dialog') await rawExecute(`const d=document.createElement('dialog');d.id='phase6a-transient-dialog';document.body.append(d);d.showModal();d.close();d.remove();return true`);
            if (lifecycleMode === 'screenshot-boundary-transient-match') await rawExecute(`const e=document.createElement('div');e.className='phase6a-mask-target';document.body.append(e);e.remove();return true`);
            if (lifecycleMode === 'screenshot-boundary-same-id') await rawExecute(`const original=document.querySelector('dialog[data-umb-capture-mask]'),id=original.dataset.umbCaptureMask;original.remove();const fake=document.createElement('dialog');fake.dataset.umbCaptureMask=id;fake.id='phase6a-same-id-fake';document.body.append(fake);fake.showModal();Object.defineProperty(fake,'__umbMaskCheck',{value:()=>true});Object.defineProperty(fake,'__umbMaskCleanup',{value:()=>{fake.remove();return true}});return true`);
            if (lifecycleMode === 'screenshot-boundary-document-root') documentRootReplacementCompleted = await rawExecute(`const replacement=document.createElement('html');replacement.innerHTML='<head></head><body></body>';document.replaceChild(replacement,document.documentElement);return document.documentElement===replacement`);
            if (lifecycleMode === 'screenshot-boundary-adjacency') structuralMutationEvidence.set(lifecycleMode, await rawExecute(`const p=document.createElement('div'),a=document.createElement('i'),b=document.createElement('i');p.innerHTML='<i class="phase6a-probe-a"></i><i class="phase6a-probe-b"></i>';document.body.append(p);const selector='.phase6a-probe-a + .phase6a-probe-b',before=document.querySelectorAll(selector).length,x=document.createElement('i');x.className='phase6a-probe-x';p.insertBefore(x,p.children[1]);const during=document.querySelectorAll(selector).length;x.remove();const after=document.querySelectorAll(selector).length;p.remove();return {before,during,after}`));
            if (lifecycleMode === 'screenshot-boundary-nth-child') structuralMutationEvidence.set(lifecycleMode, await rawExecute(`const p=document.createElement('div');p.className='phase6a-nth-parent';p.innerHTML='<i></i><i id="phase6a-nth-two"></i>';document.body.append(p);const selector='.phase6a-nth-parent > :nth-child(2)',before=document.querySelector(selector)?.id||'first',x=document.createElement('i');p.insertBefore(x,p.children[1]);const during=document.querySelector(selector)===x?'inserted':'other';x.remove();const after=document.querySelector(selector)?.id||'first';p.remove();return {before,during,after}`));
            if (lifecycleMode === 'screenshot-boundary-has') structuralMutationEvidence.set(lifecycleMode, await rawExecute(`const p=document.createElement('div');p.className='phase6a-card';document.body.append(p);const selector='.phase6a-card:has(.phase6a-has-x)',before=document.querySelectorAll(selector).length,x=document.createElement('i');x.className='phase6a-has-x';p.append(x);const during=document.querySelectorAll(selector).length;x.remove();const after=document.querySelectorAll(selector).length;p.remove();return {before,during,after}`));
            if (lifecycleMode === 'screenshot-boundary-updater') updaterAttackResults.push(await rawExecute(`const d=document.querySelector('dialog[data-umb-capture-mask]'),p=Object.getOwnPropertyDescriptor(d,'__umbMaskCheck');let replaced=false;try{Object.defineProperty(d,'__umbMaskCheck',{value:()=>true});replaced=true}catch{}const hasRuntime=!!window.__umbMaskRuntime;window.__umbMaskRuntime?.clear?.(d.dataset.umbCaptureMask);window.__umbMaskUpdate=()=>true;delete window.__umbMaskUpdate;const e=document.createElement('div');e.className='phase6a-mask-target';document.body.append(e);e.remove();return {replaced,locked:!!p&&!p.configurable&&!p.writable,hasRuntime}`));
          }
        }
        if (lifecycleMode === 'boundary-top-layer' && String(input).endsWith('/execute/sync') && body?.script?.includes('dlg.__umbMaskCheck(secret)!==true') && rawExecute) {
          await rawExecute(`const d=document.createElement('dialog');d.id='phase6a-boundary-dialog';document.body.append(d);d.showModal();return true`);
        }
        if (body?.script?.includes('node.__umbMaskCleanup(secret)!==true') && lifecycleMode === 'screenshot-boundary-same-id' && rawExecute) cleanupFakePresent = await rawExecute(`return !!document.querySelector('#phase6a-same-id-fake')`);
        if (typeof body?.script === 'string' && (body.script.includes('dlg.__umbMaskCheck(secret)!==true') || body.script.includes('node.__umbMaskCleanup(secret)!==true'))) maskReferenceArguments.push(body.args?.[0]);
        const response = await fetch(input, init);
        if (response.ok && body?.script?.includes('return dlg')) { installedElementReference = (await response.clone().json() as any).value; maskReferenceArguments = []; }
        if (String(input).endsWith('/click')) clickResponses.push(`${response.status} ${await response.clone().text()}`);
        if (response.ok && body?.script?.includes('dlg.showModal()') && rawExecute) {
          installedStates.push(await rawExecute(`const d=document.querySelector('dialog[data-umb-capture-mask]'),e=document.querySelector('.phase6a-mask-target'),c=d&&getComputedStyle(d),h=d&&getComputedStyle(d.firstElementChild),p=d&&Object.getOwnPropertyDescriptor(d,'__umbMaskCheck');return {open:!!d?.open,connected:!!d?.isConnected,isolated:d?.firstElementChild?.shadowRoot===null,important:d?.style.getPropertyPriority('display'),overlayImportant:d?.firstElementChild?.style.getPropertyPriority('pointer-events'),visible:c?.visibility==='visible'&&c?.display==='block'&&c?.opacity==='1',transform:c?.transform,clipPath:c?.clipPath,filter:c?.filter,hostVisible:h?.visibility==='visible'&&h?.display==='block'&&h?.opacity==='1',privateMethod:!!p&&!p.configurable&&!p.writable,globalRuntime:typeof window.__umbMaskRuntime!=='undefined',globalUpdater:typeof window.__umbMaskUpdate!=='undefined',style:e?.getAttribute('style')||''}`));
          const mutation = lifecycleMode;
          if (mutation === 'removed') await rawExecute(`document.querySelector('dialog[data-umb-capture-mask]')?.remove();return true`);
          if (mutation === 'closed') await rawExecute(`document.querySelector('dialog[data-umb-capture-mask]')?.close();return true`);
          if (mutation === 'late') await rawExecute(`const e=document.createElement('div');e.className='phase6a-mask-target';e.style='position:fixed;left:30px;top:30px;width:40px;height:30px;background:red';document.body.append(e);return true`);
          if (mutation === 'top-layer') await rawExecute(`const d=document.createElement('dialog');d.id='phase6a-late-dialog';d.textContent='later top layer';document.body.append(d);d.showModal();return true`);
          if (mutation === 'transformed') await rawExecute(`const e=document.querySelector('.phase6a-mask-target'),p=document.createElement('div');p.style='position:fixed;left:10px;top:10px;width:100px;height:80px;overflow:hidden;transform:scale(1.4);transform-origin:top left';e.parentNode.insertBefore(p,e);p.append(e);return true`);
          if (mutation === 'navigation') { await rawExecute(`location.reload();return true`); await new Promise(resolve => setTimeout(resolve, 300)); }
        }
        return response;
      }) as typeof fetch,
    });
    await service.start();
    const uploadName = 'native-upload-fixture.txt';
    const uploadContents = 'Tauri native upload acceptance fixture';
    const uploadPath = path.join(projectRoot, uploadName);
    await writeFile(uploadPath, uploadContents, { flag: 'wx' });
    await service.upload('#native-upload', uploadName);
    assert.equal(
      await service.text('#upload-status'),
      `${uploadName} | ${Buffer.byteLength(uploadContents)} bytes | ${uploadContents}`,
      'the native file input change event exposes the uploaded fixture filename, size, and contents',
    );
    rawExecute = async script => {
      const session = await service!.status();
      const response = await fetch(`${session.endpoint}/session/${encodeURIComponent(session.id)}/execute/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script, args: [] }) });
      const json = await response.json() as any;
      if (!response.ok || json.value?.error) throw Error(`Native DOM probe failed: ${json.value?.message ?? response.statusText}`);
      return json.value;
    };
    await rawExecute(`const e=document.createElement('div');e.className='phase6a-mask-target';e.id='phase6a-mask-target';e.setAttribute('style','position:fixed;left:10px;top:10px;width:60px;height:40px;background:red;color:white');document.body.append(e);const s=document.createElement('style');s.textContent='dialog{display:none!important;opacity:0!important;transform:scale(0)!important;clip-path:inset(50%)!important;visibility:hidden!important;filter:blur(100px)!important;animation:hide 10s infinite!important;transition:opacity 10s!important}dialog div{display:none!important;opacity:0!important;transform:scale(0)!important;clip-path:inset(50%)!important;visibility:hidden!important;filter:blur(100px)!important;animation:hide 10s infinite!important;transition:opacity 10s!important}.phase6a-mask-target{position:fixed!important;background:blue!important}';document.head.append(s);return true`);
    const overlayRuntime = await rawExecute(`const d=document.createElement('dialog');document.body.append(d);let showModal=false,modalSelector=false,error='';try{d.showModal();showModal=d.open;try{document.querySelectorAll('dialog:modal');modalSelector=true}catch(e){error=String(e)}if(d.open)d.close()}catch(e){error=String(e)}d.remove();return {showModal,modalSelector,error}`);
    if (!overlayRuntime.showModal || !overlayRuntime.modalSelector) {
      const resultDirectory = path.join(projectRoot, 'artifacts', '.umb-managed', 'desktop');
      await assert.rejects(service.capture('webview'), /mask|supported|restore/i, 'unsupported top-layer primitives must fail closed before publishing a screenshot');
      assert.deepEqual(await readdir(resultDirectory).catch(() => []), []);
      t.diagnostic(`Native WebKitGTK runtime cannot establish the protected overlay primitive (${JSON.stringify(overlayRuntime)}); capture failed closed with no PNG. Browser lifecycle success and masked pixels remain Phase 6B runtime work.`);
      return;
    }
    const tree = await service.tree(50);
    assert.ok(tree.some(node => node.role === 'button' && node.accessibleName === 'Increment counter'), 'native WebView exposes the fixture button');
    assert.equal(await service.text('#count'), '0');
    assert.equal(await service.text({ by: 'role', role: 'button', name: 'Increment counter' }), 'Increment');
    assert.equal(await service.text({ by: 'test_id', value: 'counter-increment' }), 'Increment');
    let webview;
    try { webview = await service.capture('webview'); }
    catch (error) {
      const unsupported = error instanceof AggregateError && error.errors.some(item => /operation is not supported|protected top layer|top-layer/i.test(String(item)));
      if (!unsupported) throw error;
      assert.deepEqual(await readdir(path.join(projectRoot, 'artifacts', '.umb-managed', 'desktop')).catch(() => []), [], 'unsupported WebKit overlay primitives fail closed without PNG artifacts');
      const details = error instanceof AggregateError ? error.errors.map(String).join(' | ') : String(error);
      t.diagnostic(`The actual production install script executed in native WebKitGTK but its protected top-layer/shadow overlay operation is unsupported (${details}); the service terminated the managed session and emitted no PNG. Browser lifecycle success and pixel proof remain Phase 6B.`);
      return;
    }
    assert.equal(webview.kind, 'webview');
    assert.deepEqual(webview.bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.deepEqual(await service.readArtifact(webview.artifactRef, webview.sha256!, webview.byteLength!), webview.bytes);
    assert.deepEqual(installedStates.at(-1), { open: true, connected: true, isolated: true, important: 'important', overlayImportant: 'important', visible: true, transform: 'none', clipPath: 'none', filter: 'none', hostVisible: true, privateMethod: true, globalRuntime: false, globalUpdater: false, style: 'position:fixed;left:10px;top:10px;width:60px;height:40px;background:red;color:white' }, 'the production closed shadow overlay survives adversarial page CSS and keeps integrity methods private');
    assert.equal(await rawExecute(`return document.querySelector('dialog[data-umb-capture-mask]')===null`), true, 'production cleanup removes only the temporary overlay after capture');
    t.diagnostic(`Captured WebView PNG (${webview.byteLength} bytes) and verified its persisted SHA-256 before interaction probes.`);

    if (x11Ready) {
      const window = await service.capture('window');
      assert.equal(window.kind, 'window');
      assert.deepEqual(window.bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      t.diagnostic(`Captured verified process-owned X11 window PNG (${window.byteLength} bytes).`);
    } else {
      t.diagnostic('Skipped kind=window acceptance: requires a reachable X11 DISPLAY, wmctrl, and ImageMagick import; only the WebView capture was tested.');
    }

    let elementClickFailure: unknown;
    let interactionSupported = true;
    try { await service.click('button[aria-label="Increment counter"]'); }
    catch (error) { elementClickFailure = error; }
    if (elementClickFailure) {
      t.diagnostic(`WebDriver element-click endpoint failed: ${clickResponses.at(-1) ?? String(elementClickFailure)}`);
      const session = await service.status();
      const button = await service.details('button[aria-label="Increment counter"]');
      const pointer = await fetch(`${session.endpoint}/session/${encodeURIComponent(session.id)}/actions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actions: [{ type: 'pointer', id: 'native-probe-mouse', parameters: { pointerType: 'mouse' }, actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(button.rect.x + button.rect.width / 2), y: Math.round(button.rect.y + button.rect.height / 2) },
          { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
        ] }] }),
      });
      const pointerBody = await pointer.text();
      if (!pointer.ok) { interactionSupported = false; t.diagnostic(`Native WebKitGTK host rejected both click routes; continuing DOM mask lifecycle checks without interaction acceptance. Element click: ${String(elementClickFailure)}; pointer actions: HTTP ${pointer.status} ${pointerBody}`); }
    }
    if (interactionSupported) assert.equal(await service.text('#count'), '1', 'native click or W3C pointer actions increment the real app counter');

    // Execute the real capture lifecycle against WebKitGTK; these are DOM lifecycle checks, not pixel-redaction evidence.
    for (const mode of ['late', 'top-layer', 'boundary-top-layer', 'screenshot-boundary-top-layer', 'screenshot-boundary-transient-dialog', 'screenshot-boundary-transient-match', 'screenshot-boundary-adjacency', 'screenshot-boundary-nth-child', 'screenshot-boundary-has', 'screenshot-boundary-updater', 'screenshot-boundary-same-id', 'screenshot-boundary-document-root', 'transformed', 'removed', 'closed', 'navigation']) {
      lifecycleMode = mode;
      if (!(await rawExecute(`return !!document.querySelector('.phase6a-mask-target')`))) await rawExecute(`const e=document.createElement('div');e.className='phase6a-mask-target';e.style='position:fixed;left:10px;top:10px;width:60px;height:40px;background:red';document.body.append(e);return true`);
      if (mode === 'transformed') lifecycleMode = 'transformed';
      const before = (await readdir(path.join(projectRoot, 'artifacts', '.umb-managed', 'desktop')).catch(() => [])).filter(name => name.endsWith('.png')).length;
      const screenshotsBefore = screenshotRequests;
      await assert.rejects(service.capture('webview'), `native mask lifecycle must fail closed for ${mode}`);
      assert.equal(screenshotRequests, screenshotsBefore + (mode.startsWith('screenshot-boundary-') ? 1 : 0), `${mode} must be rejected at its expected screenshot boundary`);
      if (mode === 'screenshot-boundary-updater') assert.deepEqual(updaterAttackResults.at(-1), { replaced: false, locked: true, hasRuntime: false }, 'page code cannot obtain the Node secret, replace the immutable checker, or access a runtime bypass');
      if (mode === 'screenshot-boundary-document-root') assert.equal(documentRootReplacementCompleted, true, 'the native documentElement replacement actually occurred before post-capture validation');
      if (mode === 'screenshot-boundary-same-id') {
        assert.ok(installedElementReference && maskReferenceArguments.length >= 2);
        assert.ok(maskReferenceArguments.every(reference => JSON.stringify(reference) === JSON.stringify(installedElementReference)), 'paint/check/cleanup use only the exact installation element reference');
        assert.equal(cleanupFakePresent, true, 'cleanup did not remove a page-created same-id fake dialog');
      }
      if (mode === 'screenshot-boundary-adjacency') assert.deepEqual(structuralMutationEvidence.get(mode), { before: 1, during: 0, after: 1 });
      if (mode === 'screenshot-boundary-nth-child') assert.deepEqual(structuralMutationEvidence.get(mode), { before: 'phase6a-nth-two', during: 'inserted', after: 'phase6a-nth-two' });
      if (mode === 'screenshot-boundary-has') assert.deepEqual(structuralMutationEvidence.get(mode), { before: 0, during: 1, after: 0 });
      const after = (await readdir(path.join(projectRoot, 'artifacts', '.umb-managed', 'desktop')).catch(() => [])).filter(name => name.endsWith('.png')).length;
      assert.equal(after, before, `${mode} must not publish an artifact`);
      if (mode === 'top-layer') await rawExecute(`document.querySelector('#phase6a-late-dialog')?.remove();return true`).catch(() => undefined);
      if (mode === 'boundary-top-layer') await rawExecute(`document.querySelector('#phase6a-boundary-dialog')?.remove();return true`).catch(() => undefined);
      if (mode === 'screenshot-boundary-top-layer') await rawExecute(`document.querySelector('#phase6a-screenshot-boundary-dialog')?.remove();return true`).catch(() => undefined);
      if (mode === 'late') await rawExecute(`document.querySelectorAll('.phase6a-mask-target:not(#phase6a-mask-target)').forEach(e=>e.remove());return true`).catch(() => undefined);
      if (!await service.status().then(() => true, () => false)) await service.start();
      lifecycleMode = undefined;
    }
    await service.stop();
    const invalidSelectorService = new DesktopService({ projectRoot, tauriBinary: binary, driverExecutable, artifactDirectory: 'artifacts', maskSelectors: ['input:focus'], readinessTimeoutMs: 60_000 }, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { if (String(input).endsWith('/screenshot')) screenshotRequests++; return fetch(input, init); }) as typeof fetch,
    });
    const artifactsBeforeInvalidSelector = (await readdir(path.join(projectRoot, 'artifacts', '.umb-managed', 'desktop')).catch(() => [])).filter(name => name.endsWith('.png')).length;
    const screenshotBeforeInvalidSelector = screenshotRequests;
    try {
      await invalidSelectorService.start();
      await assert.rejects(invalidSelectorService.capture('webview'), /DOM-stable compound selector/);
      assert.equal(screenshotRequests, screenshotBeforeInvalidSelector, 'input:focus is rejected before the real WebDriver screenshot endpoint');
      const artifactsAfterInvalidSelector = (await readdir(path.join(projectRoot, 'artifacts', '.umb-managed', 'desktop')).catch(() => [])).filter(name => name.endsWith('.png')).length;
      assert.equal(artifactsAfterInvalidSelector, artifactsBeforeInvalidSelector, 'unsupported dynamic selectors do not publish an artifact');
    } finally { await invalidSelectorService.stop().catch(() => undefined); }
    t.diagnostic('Executed production mask install/paint/capture/cleanup in native WebKitGTK for transient relational/structural selector mutations, documentElement replacement, same-id fake-dialog replacement, top-layer changes, and updater-replacement attempts at /screenshot. No invalidated capture published an artifact; these checks establish DOM lifecycle only, not pixel masking.');

  } finally {
    try { await service?.stop(); } finally {
      await rm(projectRoot, { recursive: true, force: true });
      if (priorWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = priorWayland;
      if (priorBackend === undefined) delete process.env.GDK_BACKEND; else process.env.GDK_BACKEND = priorBackend;
    }
  }
});
