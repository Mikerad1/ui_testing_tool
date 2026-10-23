import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BrowserController } from '../src/browser/controller.js';
import { DesktopService } from '../src/desktop/index.js';
import { serve } from '../src/mcp/server.js';
import { Store } from '../src/memory/store.js';
import type { Config } from '../src/config/config.js';

const enabled = process.env.npm_lifecycle_event === 'test:desktop-mask-pixels-native' || process.env.UMB_RUN_TAURI_NATIVE === '1';
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

async function reservePort(): Promise<number> {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

function decodeRgba(png: Buffer, convert: string): { width: number; height: number; rgba: Buffer } {
  assert.equal(png.toString('ascii', 12, 16), 'IHDR', 'capture is a PNG with an IHDR chunk');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const result = spawnSync(convert, ['png:-', '-depth', '8', 'rgba:-'], { input: png, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`ImageMagick could not decode captured PNG: ${result.error?.message ?? result.stderr.toString().slice(-1000)}`);
  const rgba = result.stdout as Buffer;
  assert.equal(rgba.length, width * height * 4, 'decoded RGBA dimensions match the persisted PNG header');
  return { width, height, rgba };
}

function assertPixelCanaries(png: Buffer, convert: string, target: { x: number; y: number; width: number; height: number }, control: { x: number; y: number; width: number; height: number }, kind: string): void {
  const { width, height, rgba } = decodeRgba(png, convert);
  const visited = new Uint8Array(width * height);
  const expectedAspect = control.width / control.height;
  const candidates: Array<{ minX: number; minY: number; maxX: number; maxY: number; pixels: number }> = [];

  for (let start = 0; start < width * height; start++) {
    if (visited[start]) continue;
    const startOffset = start * 4;
    if (!(rgba[startOffset]! < 20 && rgba[startOffset + 1]! > 200 && rgba[startOffset + 2]! < 20 && rgba[startOffset + 3] === 255)) continue;
    const queue = [start]; visited[start] = 1;
    let minX = width, minY = height, maxX = -1, maxY = -1, pixels = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor]!; const x = index % width, y = Math.floor(index / width);
      pixels++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      for (const neighbor of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) {
        if (neighbor < 0 || visited[neighbor]) continue;
        const offset = neighbor * 4;
        if (rgba[offset]! < 20 && rgba[offset + 1]! > 200 && rgba[offset + 2]! < 20 && rgba[offset + 3] === 255) {
          visited[neighbor] = 1; queue.push(neighbor);
        }
      }
    }
    const componentWidth = maxX - minX + 1, componentHeight = maxY - minY + 1;
    const aspect = componentWidth / componentHeight;
    const filled = pixels === componentWidth * componentHeight;
    if (filled && Math.abs(aspect / expectedAspect - 1) <= 0.2) candidates.push({ minX, minY, maxX, maxY, pixels });
  }
  assert.equal(candidates.length, 1, `${kind} expected one filled opaque-green control component with aspect ${expectedAspect.toFixed(3)}, found ${candidates.length} candidate(s)`);
  const fiducial = candidates[0]!;
  const componentWidth = fiducial.maxX - fiducial.minX + 1, componentHeight = fiducial.maxY - fiducial.minY + 1;
  const scaleX = componentWidth / control.width, scaleY = componentHeight / control.height;
  assert.ok(Number.isFinite(scaleX) && Number.isFinite(scaleY) && scaleX >= 0.5 && scaleY >= 0.5 && Math.abs(scaleX / scaleY - 1) <= 0.1,
    `${kind} implausible output scale from control DOM rect ${JSON.stringify(control)} and fiducial pixel rect (${fiducial.minX},${fiducial.minY},${componentWidth},${componentHeight}): scale=(${scaleX},${scaleY}), expected both axes >= 0.5 and within 10%`);

  const mapRect = (rect: typeof target) => ({
    left: fiducial.minX + (rect.x - control.x) * scaleX,
    top: fiducial.minY + (rect.y - control.y) * scaleY,
    right: fiducial.minX + (rect.x + rect.width - control.x) * scaleX,
    bottom: fiducial.minY + (rect.y + rect.height - control.y) * scaleY,
  });
  const interiorPixels = (rect: ReturnType<typeof mapRect>) => ({
    left: Math.ceil(rect.left + (rect.right - rect.left) * 0.1),
    top: Math.ceil(rect.top + (rect.bottom - rect.top) * 0.1),
    right: Math.floor(rect.right - (rect.right - rect.left) * 0.1),
    bottom: Math.floor(rect.bottom - (rect.bottom - rect.top) * 0.1),
  });
  const targetPixels = interiorPixels(mapRect(target)), controlPixels = interiorPixels(mapRect(control));
  const verifyInterior = (label: string, bounds: typeof targetPixels, expected: 'black' | 'green') => {
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= width && bounds.bottom <= height && bounds.right > bounds.left && bounds.bottom > bounds.top,
      `${kind} ${label} interior pixel bounds are within ${width}x${height}: ${JSON.stringify(bounds)}`);
    let matched = 0, total = 0, firstMismatch: string | undefined;
    for (let y = bounds.top; y < bounds.bottom; y++) for (let x = bounds.left; x < bounds.right; x++) {
      const i = (y * width + x) * 4; total++;
      const isMatch = expected === 'black'
        ? rgba[i] === 0 && rgba[i + 1] === 0 && rgba[i + 2] === 0 && rgba[i + 3] === 255
        : rgba[i]! < 20 && rgba[i + 1]! > 200 && rgba[i + 2]! < 20 && rgba[i + 3] === 255;
      if (isMatch) matched++; else if (!firstMismatch) firstMismatch = `(${x},${y})=[${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},${rgba[i + 3]}]`;
    }
    assert.equal(matched, total, `${kind} ${label} mapped rect ${JSON.stringify(mapRect(label === 'target' ? target : control))}, interior pixels ${JSON.stringify(bounds)}: expected ${expected} at every pixel, matched ${matched}/${total}${firstMismatch ? `; first mismatch ${firstMismatch}` : ''}`);
  };
  verifyInterior('target', targetPixels, 'black');
  verifyInterior('control', controlPixels, 'green');
}

test('real Tauri WebView and X11 mask pixels persist and match MCP image bytes', { skip: !enabled, timeout: 600_000 }, async t => {
  if (process.platform !== 'linux') throw Error('The Phase 6B native pixel acceptance currently supports Linux only.');
  const cargo = commandPath('cargo'), driverExecutable = commandPath('tauri-driver'), webkitDriver = commandPath('WebKitWebDriver');
  const display = process.env.DISPLAY;
  const xdpyinfo = commandPath('xdpyinfo'), wmctrl = commandPath('wmctrl'), importTool = commandPath('import'), convert = commandPath('convert');
  if (!cargo || !driverExecutable || !webkitDriver) throw Error('Phase 6B requires cargo, tauri-driver, and WebKitWebDriver on PATH.');
  if (!display || !xdpyinfo || !wmctrl || !importTool || !convert) throw Error('Phase 6B requires DISPLAY plus xdpyinfo, wmctrl, ImageMagick import, and ImageMagick convert on PATH.');
  const displayCheck = spawnSync(xdpyinfo, ['-display', display], { encoding: 'utf8' });
  if (displayCheck.status !== 0) throw Error(`Phase 6B X11 display ${display} is not reachable: ${displayCheck.stderr}`);

  const manifest = path.join(fixtureRoot, 'src-tauri', 'Cargo.toml');
  run(cargo, ['build', '--locked', '--manifest-path', manifest], fixtureRoot, 540_000);
  const binary = path.join(fixtureRoot, 'src-tauri', 'target', 'debug', 'tauri-acceptance-fixture');
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'umb-tauri-mask-pixels-'));
  const oldWayland = process.env.WAYLAND_DISPLAY, oldBackend = process.env.GDK_BACKEND;
  const tokenEnv = `UMB_DESKTOP_PIXEL_${process.pid}_${Date.now()}`, previousToken = process.env[tokenEnv];
  const token = `pixel-${process.pid}-${Date.now()}`;
  process.env[tokenEnv] = token;
  delete process.env.WAYLAND_DISPLAY;
  process.env.GDK_BACKEND = 'x11';

  let service: DesktopService | undefined, store: Store | undefined, stopServer: (() => Promise<void>) | undefined;
  let transport: StreamableHTTPClientTransport | undefined, client: Client | undefined;
  let primaryError: unknown;
  try {
    const port = await reservePort(), projectId = `desktop-pixel-${process.pid}`;
    const config = {
      version: 1,
      project: { id: projectId, name: 'Desktop Pixel Acceptance', base_url: 'http://127.0.0.1:39999' },
      server: { host: '127.0.0.1', port, auth: { mode: 'token', token_env: tokenEnv } },
      browser: { engine: 'chromium', headless: true, ignore_https_errors: false, viewport: { width: 800, height: 600 }, allowed_origins: [] },
      desktop: {
        enabled: true, framework: 'tauri', root: '.',
        automation: { provider: 'tauri-driver', driver_path: driverExecutable, binary_path: binary, ready_timeout_seconds: 60 },
        window: { title: 'Tauri Acceptance Fixture', screenshot_mode: 'webview' },
        visual: { output_directory: 'artifacts', return_mcp_images: true, mask_selectors: ['.phase6b-mask-target'] },
      },
      artifacts: { directory: 'artifacts', redact_sensitive: true, max_file_bytes: 10_000_000, max_total_bytes: 100_000_000, max_count: 100, max_age_days: 30 },
      memory: { database: path.join(projectRoot, 'memory.sqlite'), environment: 'local', persistent_learning_writes: false, trust_yaml_seeds: false },
      knowledge: { path: projectRoot },
    } as unknown as Config;
    store = new Store(config.memory.database, projectId, 'local');
    const browser = new BrowserController(config, projectRoot);
    stopServer = await serve(config, store, browser, {
      projectRoot, knowledgeRoot: projectRoot, idleTimeoutMs: 60_000,
      desktopServiceFactory: settings => { service = new DesktopService(settings); return service; },
    });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), accept: 'application/json, text/event-stream' } }),
    });
    client = new Client({ name: 'desktop-mask-pixel-acceptance', version: '1.0.0' });
    await client.connect(transport);
    const started = await client.callTool({ name: 'desktop_session_start', arguments: {} }) as any;
    assert.equal(started.structuredContent.ok, true, JSON.stringify(started.structuredContent));
    assert.ok(service, 'real DesktopService is created by the production MCP factory');

    const session = await service!.status();
    const execute = await fetch(`${session.endpoint}/session/${encodeURIComponent(session.id)}/execute/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script: `const target=document.createElement('div');target.id='phase6b-mask-target';target.className='phase6b-mask-target';target.style='position:fixed;left:30px;top:30px;width:100px;height:80px;background:rgb(255,0,255);pointer-events:none;z-index:1';const control=document.createElement('div');control.id='phase6b-unmasked-control';control.style='position:fixed;left:160px;top:30px;width:100px;height:80px;background:rgb(0,255,0);pointer-events:none;z-index:1';document.body.append(target,control);const a=target.getBoundingClientRect(),b=control.getBoundingClientRect();return {target:{x:a.x,y:a.y,width:a.width,height:a.height},control:{x:b.x,y:b.y,width:b.width,height:b.height},targetColor:getComputedStyle(target).backgroundColor,controlColor:getComputedStyle(control).backgroundColor}`, args: [] }),
    });
    const injected = await execute.json() as any;
    assert.equal(execute.ok, true, JSON.stringify(injected.value));
    assert.equal(injected.value?.targetColor, 'rgb(255, 0, 255)', 'canary target begins with a known magenta fill');
    assert.equal(injected.value?.controlColor, 'rgb(0, 255, 0)', 'unselected control begins with a known green fill');
    const targetRect = injected.value.target, controlRect = injected.value.control;
    assert.ok(targetRect.width >= 90 && controlRect.width >= 90 && targetRect.height >= 70 && controlRect.height >= 70);

    for (const kind of ['webview', 'window'] as const) {
      const result = await client.callTool({ name: 'desktop_screenshot', arguments: { kind } }) as any;
      assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent));
      const data = result.structuredContent.data;
      assert.equal(data.capture_type, kind);
      assert.equal(data.redaction.applied, true);
      assert.equal(result.structuredContent.image_delivery.status, 'included_in_mcp_result');
      const image = result.content.find((entry: any) => entry.type === 'image' && entry.mimeType === 'image/png');
      assert.ok(image, `${kind} capture returned an MCP image/png content block`);
      const mcpBytes = Buffer.from(image.data, 'base64');
      const artifactRef = String(data.artifact_ref);
      assert.match(artifactRef, /^artifacts\/\.umb-managed\/desktop\/.+\.png$/);
      const persistedBytes = await readFile(path.resolve(projectRoot, artifactRef));
      assert.deepEqual(mcpBytes, persistedBytes, `${kind} MCP image bytes equal the persisted artifact exactly`);
      assert.equal(data.byte_length, persistedBytes.length);
      assert.equal(data.sha256, createHash('sha256').update(persistedBytes).digest('hex'));
      assertPixelCanaries(persistedBytes, convert, targetRect, controlRect, kind);
      t.diagnostic(`${kind}: persisted PNG contains black masked target and intact green control; MCP image bytes match artifact (${persistedBytes.length} bytes, sha256 ${data.sha256}).`);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (label: string, operation: () => Promise<unknown> | unknown) => {
      try { await operation(); } catch (error) { cleanupErrors.push(new Error(`${label} failed`, { cause: error })); }
    };
    await cleanup('MCP client close', () => client?.close());
    await cleanup('HTTP transport close', () => transport?.close());
    await cleanup('MCP server stop', () => stopServer?.());
    await cleanup('Desktop service stop', () => service?.stop());
    await cleanup('store close', () => store?.close());
    await cleanup('temporary project removal', () => rm(projectRoot, { recursive: true, force: true }));
    await cleanup('WAYLAND_DISPLAY restoration', () => { if (oldWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = oldWayland; });
    await cleanup('GDK_BACKEND restoration', () => { if (oldBackend === undefined) delete process.env.GDK_BACKEND; else process.env.GDK_BACKEND = oldBackend; });
    await cleanup('token environment restoration', () => { if (previousToken === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = previousToken; });
    if (primaryError !== undefined || cleanupErrors.length) {
      const errors = [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors];
      throw new AggregateError(errors, `Native desktop pixel test ${primaryError === undefined ? 'cleanup failed' : 'failed; cleanup was also attempted'}`);
    }
  }
});
