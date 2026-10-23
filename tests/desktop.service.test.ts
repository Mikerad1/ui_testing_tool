import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat, utimes, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as nodeFs } from 'node:fs';
import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { DesktopService, type DesktopAdapters, type DesktopCommandResult } from '../src/desktop/index.js';
import { createRgbaPng } from './png-fixture.js';

const png = createRgbaPng();
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-service-'));
  await mkdir(path.join(root, 'src-tauri'), { recursive: true });
  await writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), '{}');
  await writeFile(path.join(root, 'app'), 'fake binary');
  await mkdir(path.join(root, 'artifacts'));
  return root;
}
function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: 4321, exitCode: null, kill: () => { Object.assign(child, { exitCode: 0 }); child.emit('exit', 0); return true; } });
  return child;
}
function fakeBuildChild(pid: number, closeOnTerm = true): ChildProcess & { signals: string[] } {
  const child = new EventEmitter() as ChildProcess & { signals: string[] };
  const signals: string[] = [];
  Object.assign(child, {
    pid, exitCode: null, signalCode: null, signals, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: (signal = 'SIGTERM') => {
      signals.push(signal);
      if (closeOnTerm || signal === 'SIGKILL') {
        Object.assign(child, { exitCode: null, signalCode: signal }); child.emit('close', null, signal);
      }
      return true;
    },
  });
  return child;
}
function response(status: number, value: unknown) {
  return { ok: status >= 200 && status < 300, status, statusText: 'fake', json: async () => value } as Response;
}
const config = (projectRoot: string) => ({ projectRoot, tauriBinary: 'app', driverExecutable: '/fake/tauri-driver', windowTitle: 'Demo Window', artifactDirectory: 'artifacts', readinessTimeoutMs: 50 });
const driverFakes = { reservePort: async () => 23456, killProcess: () => undefined };

async function uploadHarness(root: string, options: { matches?: number; tagName?: unknown; type?: unknown; enabled?: unknown } = {}) {
  const calls: { url: string; method: string; body?: any }[] = [];
  const service = new DesktopService(config(root), {
    ...driverFakes,
    spawn: (() => fakeChild()) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/status')) return response(200, { value: {} });
      if (url.endsWith('/session')) return response(200, { value: { sessionId: 'upload-session' } });
      if (url.endsWith('/elements')) return response(200, { value: Array.from({ length: options.matches ?? 1 }, (_, i) => ({ 'element-6066-11e4-a52e-4f735466cecf': `element-${i + 1}` })) });
      if (url.endsWith('/element/element-1/name')) return response(200, { value: options.tagName ?? 'input' });
      if (url.endsWith('/attribute/type')) return response(200, { value: options.type ?? 'file' });
      if (url.endsWith('/enabled')) return response(200, { value: options.enabled ?? true });
      return response(200, { value: null });
    }) as typeof fetch,
  });
  await service.start();
  return { service, calls };
}

type LocatorNode = { tag: string; role?: string; label?: string; text: string; alt?: string; testId?: string; placeholder?: string; inputType?: string; visible?: boolean; enabled?: boolean };
async function locatorHarness(root: string, nodes: LocatorNode[]) {
  const calls: { url: string; method: string; body?: any }[] = [];
  const matches = (locator: any) => nodes.map((node, index) => ({ node, index })).filter(({ node }) => {
    const role = node.role || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' } as Record<string, string>)[node.tag] || node.tag.toLowerCase();
    const name = (node.label || node.text || node.alt || '').trim().slice(0, 300);
    return locator.by === 'role' ? role === locator.role && (locator.name === undefined || name === locator.name)
      : locator.by === 'test_id' ? node.testId === locator.value
        : (node.tag === 'TEXTAREA' || node.tag === 'INPUT' && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(node.inputType ?? 'text')) && node.placeholder === locator.value;
  });
  const service = new DesktopService(config(root), {
    ...driverFakes, spawn: (() => fakeChild()) as typeof import('node:child_process').spawn,
    processTree: async () => new Set([4321]), isProcessAlive: () => false, isProcessGroupAlive: () => false,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/status')) return response(200, { value: {} });
      if (url.endsWith('/session')) return response(200, { value: { sessionId: 'locator-session' } });
      if (url.endsWith('/elements')) return response(200, { value: [{ 'element-6066-11e4-a52e-4f735466cecf': 'css-element' }] });
      if (url.endsWith('/execute/sync')) {
        const locator = body.args[0];
        if (body.script.includes('out.push(e)')) return response(200, { value: matches(locator).slice(0, 2).map(({ index }) => ({ 'element-6066-11e4-a52e-4f735466cecf': `element-${index}` })) });
        if (body.script.includes('return {visible:')) {
          const ref = locator?.['element-6066-11e4-a52e-4f735466cecf'];
          const node = nodes[Number(String(ref).replace('element-', ''))];
          return response(200, { value: { visible: node?.visible !== false, enabled: node?.enabled !== false } });
        }
        const summary = matches(locator).slice(0, body.args[1]).map(({ node, index }) => ({ index, role: node.role || node.tag.toLowerCase(), accessibleName: (node.label || node.text || node.alt || '').trim().slice(0, 300), text: node.text, enabled: node.enabled !== false, visible: node.visible !== false, rect: { x: 0, y: 0, width: 10, height: 10 } }));
        return response(200, { value: summary });
      }
      if (url.endsWith('/text')) return response(200, { value: 'resolved text' });
      return response(200, { value: null });
    }) as typeof fetch,
  });
  await service.start();
  return { service, calls };
}

test('semantic locators use exact case-sensitive role/name and test id arguments and W3C references', async () => {
  const root = await project();
  try {
    const { service, calls } = await locatorHarness(root, [
      { tag: 'BUTTON', label: `Say "hi"'); document.body.innerHTML='pwned'//`, text: 'Other' },
      { tag: 'BUTTON', label: 'Increment counter', text: 'Increment', testId: 'counter-increment' },
      { tag: 'BUTTON', label: 'increment counter', text: 'lowercase' },
    ]);
    try {
      const locator = { by: 'role' as const, role: 'button', name: `Say "hi"'); document.body.innerHTML='pwned'//` };
      await service.click(locator);
      const execute = calls.find(call => call.url.endsWith('/execute/sync') && call.body?.script.includes('return out;'))!;
      assert.deepEqual(execute.body.args, [locator]);
      assert.equal(execute.body.script.includes(locator.name), false);
      assert.match(execute.body.script, /out.length<2/);
      assert.ok(calls.some(call => call.url.endsWith('/element/element-0/click')));
      const actionability = calls.find(call => call.url.endsWith('/execute/sync') && call.body?.script.includes('return {visible:'))!;
      assert.deepEqual(actionability.body.args, [{ 'element-6066-11e4-a52e-4f735466cecf': 'element-0' }], 'state check uses the exact returned W3C reference');
      assert.equal(await service.text({ by: 'role', role: 'button', name: 'Increment counter' }), 'resolved text');
      assert.equal(await service.text({ by: 'test_id', value: 'counter-increment' }), 'resolved text');
      assert.equal((await service.find({ by: 'role', role: 'button', name: 'Increment counter' }))[0]?.accessibleName, 'Increment counter');
      assert.equal((await service.find({ by: 'role', role: 'button', name: 'increment counter' })).length, 1);
      assert.equal((await service.find({ by: 'role', role: 'button', name: 'INCREMENT COUNTER' })).length, 0);
    } finally { await service.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('semantic mutations fail closed for zero, duplicate, hidden, or disabled matches; CSS remains W3C CSS lookup', async () => {
  const root = await project();
  try {
    for (const nodes of [
      [{ tag: 'BUTTON', text: 'other' }],
      [{ tag: 'BUTTON', text: 'Go' }, { tag: 'BUTTON', text: 'Go' }, { tag: 'BUTTON', text: 'Go' }],
      [{ tag: 'BUTTON', text: 'Go', visible: false }],
      [{ tag: 'BUTTON', text: 'Go', enabled: false }],
    ]) {
      const { service, calls } = await locatorHarness(root, nodes);
      try {
        let failure: unknown;
        try { await service.click({ by: 'role', role: 'button', name: 'Go' }); } catch (error) { failure = error; }
        assert.match(String(failure), /exactly one|visible and enabled/);
        if (nodes.length > 1) {
          assert.match(String(failure), /matches: 2 or more/);
          assert.doesNotMatch(String(failure), /"text"/);
        }
        assert.equal(calls.some(call => /\/element\/.*\/click$/.test(call.url)), false);
        if (nodes.length === 1 && nodes[0]?.text === 'Go') assert.ok(calls.some(call => call.url.endsWith('/execute/sync') && call.body?.script.includes('return {visible:')), 'unique non-actionable match is checked before action');
      } finally { await service.stop(); }
    }
    const { service, calls } = await locatorHarness(root, [{ tag: 'BUTTON', text: 'Go', visible: false }]);
    try {
      await service.click('button.primary');
      assert.ok(calls.some(call => call.url.endsWith('/elements') && call.body.using === 'css selector' && call.body.value === 'button.primary'));
      assert.ok(calls.some(call => call.url.endsWith('/element/css-element/click')));
      await assert.rejects(service.scroll({ by: 'role', role: 'button', name: 'Go' }), /visible and enabled/);
      assert.equal(calls.some(call => call.body?.script === 'arguments[0].scrollIntoView({block:"center",inline:"center"});'), false);
    } finally { await service.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('semantic locator validation enforces schema lengths and rejects extra or malformed fields', async () => {
  const root = await project();
  try {
    const { service, calls } = await locatorHarness(root, []);
    try {
      for (const locator of [
        { by: 'role', role: 'r'.repeat(101) },
        { by: 'role', role: 'button', name: 'n'.repeat(301) },
        { by: 'test_id', value: 'i'.repeat(1001) },
        { by: 'placeholder', value: '' },
        { by: 'placeholder', value: 'p'.repeat(1001) },
        { by: 'placeholder', value: 'ok', extra: true },
        { by: 'placeholder', value: 42 },
        { by: 'test_id', value: 'ok', extra: true },
        { by: 'role', role: 'button', unexpected: true },
        [],
      ]) await assert.rejects(service.find(locator as any), /Invalid desktop locator/);
      assert.equal(calls.some(call => call.url.endsWith('/execute/sync')), false);
    } finally { await service.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('placeholder locators use exact raw equality for supported native text controls and preserve safe actions', async () => {
  const root = await project();
  try {
    const placeholder = `Say "hi"'); document.body.innerHTML='pwned'//`;
    const { service, calls } = await locatorHarness(root, [
      { tag: 'INPUT', inputType: 'text', placeholder, text: '' },
      { tag: 'INPUT', inputType: 'search', placeholder: 'Case', text: '' },
      { tag: 'INPUT', inputType: 'url', placeholder: ' URL ', text: '' },
      { tag: 'INPUT', inputType: 'tel', placeholder: 'phone', text: '' },
      { tag: 'INPUT', inputType: 'email', placeholder: 'email', text: '' },
      { tag: 'INPUT', inputType: 'password', placeholder: 'secret', text: '' },
      { tag: 'TEXTAREA', placeholder: 'Case', text: '' },
      { tag: 'INPUT', inputType: 'number', placeholder: 'Case', text: '' },
      { tag: 'INPUT', inputType: 'file', placeholder: 'Case', text: '' },
      { tag: 'INPUT', inputType: 'text', placeholder: 'case', text: '' },
      { tag: 'INPUT', inputType: 'text', placeholder: ' Case ', text: '' },
    ]);
    try {
      const locator = { by: 'placeholder' as const, value: placeholder };
      await service.click(locator);
      assert.ok(calls.some(call => call.url.endsWith('/element/element-0/click')));
      const resolveScript = calls.find(call => call.url.endsWith('/execute/sync') && call.body?.script.includes('out.push(e)'))!;
      assert.deepEqual(resolveScript.body.args, [locator]);
      assert.doesNotMatch(resolveScript.body.script, /Say|pwned|placeholder\]/);
      assert.match(resolveScript.body.script, /getAttribute\('placeholder'\)===l\.value/);
      assert.match(resolveScript.body.script, /\['text','search','url','tel','email','password'\]/);
      assert.equal((await service.find({ by: 'placeholder', value: 'Case' })).length, 2);
      assert.equal((await service.find({ by: 'placeholder', value: 'case' })).length, 1);
      assert.equal((await service.find({ by: 'placeholder', value: ' Case ' })).length, 1);
      assert.equal((await service.find({ by: 'placeholder', value: 'missing' })).length, 0);
    } finally { await service.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('placeholder semantic actions reject duplicates and check visibility and enabled state on resolved reference', async () => {
  const root = await project();
  try {
    for (const nodes of [
      [{ tag: 'INPUT', inputType: 'text', placeholder: 'same', text: '' }, { tag: 'TEXTAREA', placeholder: 'same', text: '' }],
      [{ tag: 'INPUT', inputType: 'text', placeholder: 'same', text: '', visible: false }],
      [{ tag: 'INPUT', inputType: 'text', placeholder: 'same', text: '', enabled: false }],
    ] as LocatorNode[][]) {
      const { service, calls } = await locatorHarness(root, nodes);
      try {
        await assert.rejects(service.click({ by: 'placeholder', value: 'same' }), /exactly one|visible and enabled/);
        assert.equal(calls.some(call => /\/element\/.*\/click$/.test(call.url)), false);
        if (nodes.length === 1) {
          const check = calls.find(call => call.body?.script?.includes('return {visible:'))!;
          assert.deepEqual(check.body.args, [{ 'element-6066-11e4-a52e-4f735466cecf': 'element-0' }]);
        }
      } finally { await service.stop(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('upload sends one bounded local path through W3C element value and returns only metadata', async () => {
  const root = await project();
  try {
    const bytes = Buffer.from('safe upload'); await writeFile(path.join(root, 'upload.txt'), bytes);
    const { service, calls } = await uploadHarness(root);
    try {
      const result = await service.upload('input[type=file]', 'upload.txt');
      assert.deepEqual(result, { basename: 'upload.txt', byteLength: bytes.length });
      assert.deepEqual(Object.keys(result).sort(), ['basename', 'byteLength']);
      const sent = calls.find(call => call.method === 'POST' && call.url.endsWith('/element/element-1/value'))!;
      assert.deepEqual(sent.body, { text: path.join(root, 'upload.txt'), value: [...path.join(root, 'upload.txt')] });
      assert.ok(calls.some(call => call.method === 'GET' && call.url.endsWith('/element/element-1/name')));
      assert.ok(calls.some(call => call.method === 'GET' && call.url.endsWith('/element/element-1/attribute/type')));
      assert.ok(calls.some(call => call.method === 'GET' && call.url.endsWith('/element/element-1/enabled')));
    } finally { await service.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('upload requires a managed session and rejects invalid paths and targets without sending element value', async () => {
  const root = await project();
  try {
    await writeFile(path.join(root, 'upload.txt'), 'ok');
    await mkdir(path.join(root, 'folder'));
    await writeFile(path.join(root, `line\nbreak.txt`), 'bad');
    const outside = await mkdtemp(path.join(os.tmpdir(), 'desktop-upload-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'secret');
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
      const noSession = new DesktopService(config(root), { fetch: (async () => { throw Error('unexpected request'); }) as typeof fetch });
      await assert.rejects(noSession.upload('input[type=file]', 'upload.txt'), /managed WebDriver session/);

      const scenarios: Array<{ label: string; filename: string; options?: { matches?: number; type?: unknown; enabled?: unknown }; pattern: RegExp }> = [
        { label: 'traversal', filename: '../secret.txt', pattern: /relative|traversal/ },
        { label: 'symlink escape', filename: 'escape.txt', pattern: /escapes|Symlink/ },
        { label: 'directory', filename: 'folder', pattern: /regular file/ },
        { label: 'newline path', filename: 'line\nbreak.txt', pattern: /CR or LF/ },
        { label: 'selector cardinality', filename: 'upload.txt', options: { matches: 2 }, pattern: /exactly one/ },
        { label: 'wrong element', filename: 'upload.txt', options: { tagName: 'button' }, pattern: /input\[type=file\]/ },
        { label: 'wrong input type', filename: 'upload.txt', options: { type: 'text' }, pattern: /input\[type=file\]/ },
        { label: 'disabled input', filename: 'upload.txt', options: { enabled: false }, pattern: /enabled/ },
      ];
      const oversized = path.join(root, 'oversized.bin');
      const handle = await nodeFs.open(oversized, 'w'); try { await handle.truncate(20 * 1024 * 1024 + 1); } finally { await handle.close(); }
      scenarios.push({ label: 'oversized file', filename: 'oversized.bin', pattern: /20 MiB/ });
      for (const scenario of scenarios) {
        const { service, calls } = await uploadHarness(root, scenario.options);
        try {
          await assert.rejects(service.upload('input[type=file]', scenario.filename), scenario.pattern, scenario.label);
          assert.equal(calls.some(call => call.method === 'POST' && /\/element\/[^/]+\/value$/.test(call.url)), false, `${scenario.label} must not issue element/value`);
        } finally { await service.stop(); }
      }
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('inspection discovers Tauri without executing commands', async () => {
  const root = await project(); let commandCalls = 0;
  try {
    const service = new DesktopService({ ...config(root), buildCommand: { command: 'npm', args: ['run', 'tauri:build'] } }, {
      command: async () => { commandCalls++; throw Error('must not run'); },
      spawn: (() => { commandCalls++; throw Error('build must not run during inspection'); }) as typeof import('node:child_process').spawn,
    });
    const inspected = await service.inspectProject();
    assert.equal(inspected.tauri, true); assert.deepEqual(inspected.tauriConfigFiles, ['src-tauri/tauri.conf.json']);
    assert.equal(inspected.tauriBinary, path.join(root, 'app')); assert.equal(commandCalls, 0);
    assert.equal(inspected.buildCommandConfigured, true);
    assert.equal((await service.capabilities()).tauriBinary.available, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed start creates W3C session using configured binary and cleanup deletes only owned session', async () => {
  const root = await project(); const calls: { url: string; method: string; body?: string }[] = [];
  const child = fakeChild();
  const killed: number[] = [];
  const adapters: Partial<DesktopAdapters> = {
    processTree: async pid => new Set([pid, 4322]),
    killProcess: pid => { killed.push(pid); },
    spawn: ((exe: string, args: string[], options: unknown) => { assert.equal(exe, '/fake/tauri-driver'); assert.deepEqual(args, ['--port', '23456']); assert.equal((options as { shell: boolean }).shell, false); return child; }) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, method: init?.method ?? 'GET', body: init?.body?.toString() });
      if (url.endsWith('/status')) return response(200, { value: { ready: true } });
      if (url.endsWith('/session')) return response(200, { value: { sessionId: 'owned-1' } });
      return response(200, { value: null });
    }) as typeof fetch,
  };
  try {
    const service = new DesktopService(config(root), { ...driverFakes, ...adapters });
    const session = await service.start(); assert.equal(session.id, 'owned-1');
    const create = calls.find(c => c.url.endsWith('/session'))!;
    assert.equal(JSON.parse(create.body!).capabilities.alwaysMatch['tauri:options'].application, path.join(root, 'app'));
    assert.equal(JSON.parse(create.body!).capabilities.alwaysMatch.browserName, 'wry');
    assert.ok(session.endpoint.endsWith(':23456'));
    assert.equal(calls.some(c => c.url.includes('wdio')), false);
    assert.deepEqual(await service.stop(), { stopped: true });
    assert.ok(calls.some(c => c.url.endsWith('/session/owned-1') && c.method === 'DELETE'));
    assert.equal(child.exitCode, 0);
    assert.deepEqual(killed, [4322]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stop bounds a hung remote session DELETE and still terminates the owned driver tree', async () => {
  const root = await project(); const child = fakeChild(); const killed: number[] = []; let deleteStarted = false, deleteAborted = false;
  const service = new DesktopService(config(root), {
    ...driverFakes,
    processTree: async pid => new Set([pid, 4322]),
    killProcess: pid => { killed.push(pid); },
    spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') { deleteStarted = true; init.signal?.addEventListener('abort', () => { deleteAborted = true; }); return new Promise<Response>(() => {}); }
      return String(input).endsWith('/status') ? response(200, { value: {} }) : response(200, { value: { sessionId: 'hung-delete' } });
    }) as typeof fetch,
  });
  try {
    await service.start();
    const started = Date.now();
    await assert.rejects(service.stop(), /Timed out waiting for WebDriver session deletion/);
    assert.ok(Date.now() - started < 2500, 'stop must finish within a bounded interval');
    assert.equal(deleteStarted, true);
    assert.equal(deleteAborted, true, 'the injected fetch receives and observes the abort signal');
    assert.equal(child.exitCode, 0, 'the owned driver is terminated after DELETE times out');
    assert.deepEqual(killed, [4322], 'only the owned descendant is signaled');
    assert.equal((await readdir(root)).includes('app'), true, 'project cleanup remains reachable after stop settles');
  } finally { await rm(root, { recursive: true, force: true }); }
  await assert.rejects(readdir(root), { code: 'ENOENT' }, 'caller cleanup can remove the temporary project after stop settles');
});

test('stalled WebDriver fetch is aborted with a stable sanitized timeout error', { timeout: 10_000 }, async () => {
  const root = await project(); const child = fakeChild(); let aborted = false;
  const service = new DesktopService({ ...config(root), readinessTimeoutMs: 6_000 }, {
    ...driverFakes, spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/status')) return response(200, { value: {} });
      if (String(input).endsWith('/session')) return response(200, { value: { sessionId: 'fetch-stall' } });
      if (init?.method === 'DELETE') return response(200, { value: null });
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return new Promise<Response>(() => {});
    }) as typeof fetch,
  });
  try {
    await service.start();
    await assert.rejects(service.click('button'), error => {
      assert.equal((error as { code?: string }).code, 'WEBDRIVER_REQUEST_TIMEOUT');
      assert.match(String(error), /WebDriver request timed out after 5000ms/);
      assert.doesNotMatch(String(error), /127\.0\.0\.1|secret|sentinel|\?/);
      return true;
    });
    assert.equal(aborted, true);
    await service.stop();
    assert.equal(child.exitCode, 0, 'driver teardown remains reachable after request timeout');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a stalled direct readiness fetch is aborted within the startup deadline', { timeout: 3_000 }, async () => {
  const root = await project(); const child = fakeChild(); let statusAborted = false;
  const service = new DesktopService(config(root), {
    ...driverFakes, spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { statusAborted = true; });
      return new Promise<Response>(() => {});
    }) as typeof fetch,
  });
  try {
    const started = Date.now();
    await assert.rejects(service.start(), /did not become ready/);
    assert.ok(Date.now() - started < 500, 'readiness polling cannot outlive its configured startup deadline');
    assert.equal(statusAborted, true);
    assert.equal(child.exitCode, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stalled WebDriver JSON body read is bounded by the same abort signal', { timeout: 10_000 }, async () => {
  const root = await project(); const child = fakeChild(); let aborted = false;
  const service = new DesktopService(config(root), {
    ...driverFakes, spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/status')) return response(200, { value: {} });
      if (String(input).endsWith('/session')) return response(200, { value: { sessionId: 'json-stall' } });
      if (init?.method === 'DELETE') return response(200, { value: null });
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return { ok: true, status: 200, statusText: 'sentinel-body', json: async () => new Promise(() => {}) } as Response;
    }) as typeof fetch,
  });
  try {
    await service.start();
    await assert.rejects(service.click('button'), error => {
      assert.equal((error as { code?: string }).code, 'WEBDRIVER_REQUEST_TIMEOUT');
      assert.match(String(error), /WebDriver request timed out after 5000ms/);
      assert.doesNotMatch(String(error), /sentinel-body|127\.0\.0\.1|\?/);
      return true;
    });
    assert.equal(aborted, true);
    await service.stop();
    assert.equal(child.exitCode, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('session creation may exceed the ordinary request timeout within its readiness bound', { timeout: 10_000 }, async () => {
  const root = await project(); const child = fakeChild();
  const service = new DesktopService({ ...config(root), readinessTimeoutMs: 6_000 }, {
    ...driverFakes, spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/status')) return response(200, { value: {} });
      if (init?.method === 'DELETE') return response(200, { value: null });
      await new Promise(resolve => setTimeout(resolve, 5_150));
      return response(200, { value: { sessionId: 'delayed-session' } });
    }) as typeof fetch,
  });
  try {
    const started = Date.now();
    const session = await service.start();
    assert.equal(session.id, 'delayed-session');
    assert.ok(Date.now() - started > 5_000, 'session creation exceeded the ordinary request limit');
    await service.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stalled session creation aborts at its readiness bound and tears down the driver', { timeout: 3_000 }, async () => {
  const root = await project(); const child = fakeChild(); let sessionAborted = false, treeCalls = 0;
  const service = new DesktopService({ ...config(root), readinessTimeoutMs: 100 }, {
    ...driverFakes, spawn: (() => child) as typeof import('node:child_process').spawn,
    processTree: async pid => { treeCalls++; return new Set([pid]); },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/status')) return response(200, { value: {} });
      init?.signal?.addEventListener('abort', () => { sessionAborted = true; });
      return new Promise<Response>(() => {});
    }) as typeof fetch,
  });
  try {
    const started = Date.now();
    await assert.rejects(service.start(), error => {
      assert.equal((error as { code?: string }).code, 'WEBDRIVER_REQUEST_TIMEOUT');
      assert.match(String(error), /timed out after 100ms/);
      return true;
    });
    assert.ok(Date.now() - started < 500);
    assert.equal(sessionAborted, true);
    assert.equal(child.exitCode, 0);
    assert.equal(treeCalls, 2, 'failed-start cleanup runs one driver-tree teardown');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capture request timeout tears down the driver once and publishes no artifact', { timeout: 8_000 }, async () => {
  const root = await project(); const child = fakeChild(); let screenshotAborted = false, treeCalls = 0;
  const service = new DesktopService({ ...config(root), readinessTimeoutMs: 6_000 }, {
    ...driverFakes, spawn: (() => child) as typeof import('node:child_process').spawn,
    processTree: async pid => { treeCalls++; return new Set([pid]); },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/status')) return response(200, { value: {} });
      if (url.endsWith('/session')) return response(200, { value: { sessionId: 'capture-timeout' } });
      if (url.endsWith('/screenshot')) {
        init?.signal?.addEventListener('abort', () => { screenshotAborted = true; });
        return new Promise<Response>(() => {});
      }
      if (init?.method === 'DELETE') return response(200, { value: null });
      return response(200, { value: null });
    }) as typeof fetch,
  });
  try {
    await service.start();
    await assert.rejects(service.capture('webview'), error => {
      assert.equal((error as { code?: string }).code, 'WEBDRIVER_REQUEST_TIMEOUT');
      assert.match(String(error), /timed out after 3000ms/);
      return true;
    });
    assert.equal(screenshotAborted, true);
    assert.equal(treeCalls, 3, 'capture timeout invokes exactly one managed teardown');
    assert.equal(child.exitCode, 0);
    assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ordinary interaction timeout is bounded and the managed session remains stoppable', { timeout: 12_000 }, async () => {
  const root = await project(); const child = fakeChild(); let interactionAborted = false;
  const service = new DesktopService({ ...config(root), readinessTimeoutMs: 6_000 }, {
    ...driverFakes, spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/status')) return response(200, { value: {} });
      if (url.endsWith('/session')) return response(200, { value: { sessionId: 'ordinary-timeout' } });
      if (init?.method === 'DELETE') return response(200, { value: null });
      init?.signal?.addEventListener('abort', () => { interactionAborted = true; });
      return new Promise<Response>(() => {});
    }) as typeof fetch,
  });
  try {
    await service.start();
    await assert.rejects(service.click('button'), error => {
      assert.equal((error as { code?: string }).code, 'WEBDRIVER_REQUEST_TIMEOUT');
      assert.doesNotMatch(String(error), /127\.0\.0\.1|sentinel|\?/);
      return true;
    });
    assert.equal(interactionAborted, true);
    assert.deepEqual(await service.stop(), { stopped: true });
    assert.equal(child.exitCode, 0, 'process-tree teardown remains reachable after an interaction timeout');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('non-Tauri adapter contract covers managed startup, request, capture, ownership, and failed-start cleanup', async () => {
  const root = await project();
  const requests: { method: string; pathname: string }[] = [];
  const killedDescendants: string[] = [];
  const child = fakeChild();
  const adapters: Partial<DesktopAdapters> = {
    ...driverFakes,
    processTree: async pid => { assert.equal(pid, 4321); return new Set([pid, 4322]); },
    killProcess: (pid, signal) => { killedDescendants.push(`${pid}:${signal}`); },
    spawn: ((executable: string, args: string[], options: unknown) => {
      assert.equal(executable, '/fake/tauri-driver'); assert.deepEqual(args, ['--port', '23456']);
      assert.equal((options as { shell: boolean }).shell, false); return child;
    }) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname; requests.push({ method: init?.method ?? 'GET', pathname });
      if (pathname.endsWith('/status')) return response(200, { value: { ready: true } });
      if (pathname.endsWith('/session')) return response(200, { value: { sessionId: 'adapter-contract' } });
      if (pathname.endsWith('/execute/sync')) return response(200, { value: [] });
      if (pathname.endsWith('/screenshot')) return response(200, { value: png.toString('base64') });
      return response(200, { value: null });
    }) as typeof fetch,
  };
  try {
    const service = new DesktopService(config(root), adapters);
    assert.equal((await service.start()).id, 'adapter-contract');
    assert.deepEqual(await service.tree(5), []);
    const capture = await service.capture('webview');
    assert.equal(capture.kind, 'webview'); assert.deepEqual(capture.bytes, png);
    assert.deepEqual(await service.stop(), { stopped: true });
    assert.ok(requests.some(request => request.method === 'POST' && request.pathname.endsWith('/session')));
    assert.ok(requests.some(request => request.method === 'POST' && request.pathname.endsWith('/execute/sync')));
    assert.ok(requests.some(request => request.method === 'GET' && request.pathname.endsWith('/screenshot')));
    assert.ok(requests.some(request => request.method === 'DELETE' && request.pathname.endsWith('/session/adapter-contract')));
    assert.deepEqual(killedDescendants, ['4322:SIGTERM']); assert.equal(child.exitCode, 0);

    const failedChild = fakeChild();
    const failedRequests: string[] = [];
    const failedService = new DesktopService(config(root), {
      ...adapters,
      spawn: (() => failedChild) as typeof import('node:child_process').spawn,
      fetch: (async (input: RequestInfo | URL) => {
        const pathname = new URL(String(input)).pathname; failedRequests.push(pathname);
        return pathname === '/status' ? response(200, { value: {} }) : response(200, { value: {} });
      }) as typeof fetch,
    });
    await assert.rejects(failedService.start(), /did not create a W3C session/);
    assert.ok(!failedRequests.some(pathname => pathname.startsWith('/session/')));
    assert.equal(failedChild.exitCode, 0); assert.deepEqual(killedDescendants, ['4322:SIGTERM', '4322:SIGTERM']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('actionable failures when driver or configured Tauri binary is missing', async () => {
  const root = await project();
  try {
    const noDriver = new DesktopService({ projectRoot: root, tauriBinary: 'app' });
    await assert.rejects(noDriver.start(), /absolute Linux tauri-driver executable/);
    const noApp = new DesktopService({ projectRoot: root, tauriBinary: 'missing', driverExecutable: '/fake/driver' });
    await assert.rejects(noApp.start(), /does not exist.*build it separately/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('WebView screenshot is WebDriver PNG while window screenshot uses verified exact-title X11 window only', async () => {
  const root = await project(); const child = fakeChild(); const commands: string[][] = [];
  const previousWayland = process.env.WAYLAND_DISPLAY, previousDisplay = process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY; process.env.DISPLAY = ':test';
  let webviewCalled = false;
  const adapters: Partial<DesktopAdapters> = {
    spawn: (() => child) as typeof import('node:child_process').spawn,
    processTree: async pid => { assert.equal(pid, 4321); return new Set([4321, 4444]); },
    command: async (_exe: string, args: string[]): Promise<DesktopCommandResult> => {
      commands.push(args);
      if (args[0] === '-lp') return { code: 0, stdout: '0x1 0 9999 host Demo Window\n0x2 0 4444 host Other\n0x3 0 4444 host Demo Window\n', stderr: '' };
      if (args[0] === '-window') await writeFile(args[2]!, png);
      return { code: 0, stdout: '', stderr: '' };
    },
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/status')) return response(200, { value: {} });
      if (url.endsWith('/session')) return response(200, { value: { sessionId: 'owned' } });
      if (url.endsWith('/screenshot')) { webviewCalled = true; return response(200, { value: png.toString('base64') }); }
      return response(200, { value: null });
    }) as typeof fetch,
  };
  try {
    const service = new DesktopService(config(root), { ...driverFakes, ...adapters }); await service.start();
    const webview = await service.capture('webview'); assert.equal(webview.kind, 'webview'); assert.equal(webview.bytes.toString('hex'), png.toString('hex'));
    const window = await service.capture('window'); assert.equal(window.kind, 'window'); assert.equal(webviewCalled, true);
    assert.ok(commands.some(args => args.join(' ') === `-window 0x3 ${window.path}`));
    assert.equal((await readFile(window.path)).subarray(0, 8).toString('hex'), png.subarray(0, 8).toString('hex'));
    await service.stop();
  } finally { await rm(root, { recursive: true, force: true }); if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previousWayland; if (previousDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = previousDisplay; }
});

test('configured masks install and paint before both capture backends and always restore', async () => {
  const root = await project(), child = fakeChild(), calls: string[] = [];
  const oldDisplay = process.env.DISPLAY, oldWayland = process.env.WAYLAND_DISPLAY; delete process.env.WAYLAND_DISPLAY; process.env.DISPLAY = ':test';
  const service = new DesktopService({ ...config(root), maskSelectors: ['.secret', '#account'] }, {
    ...driverFakes, spawn: (() => child) as typeof import('node:child_process').spawn,
    processTree: async pid => new Set([pid]),
    command: async (_exe, args) => { calls.push(`cmd:${args[0]}`); if (args[0] === '-lp') return { code: 0, stdout: '0x3 0 4321 host Demo Window\n', stderr: '' }; if (args[0] === '-window') await writeFile(args[2]!, png); return { code: 0, stdout: '', stderr: '' }; },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); if (url.endsWith('/status')) return response(200, { value: {} }); if (url.endsWith('/session')) return response(200, { value: { sessionId: 'mask' } });
      if (url.endsWith('/execute/async')) { calls.push('paint'); return response(200, { value: true }); }
      if (url.endsWith('/execute/sync')) { const script = JSON.parse(String(init?.body)).script; const phase = script.includes('showModal') ? 'install' : script.includes('node.remove()') ? 'remove' : 'verify'; calls.push(phase); return response(200, { value: phase === 'install' ? { 'element-6066-11e4-a52e-4f735466cecf': 'fake-mask-element' } : true }); }
      if (url.endsWith('/screenshot')) { calls.push('screenshot'); return response(200, { value: png.toString('base64') }); }
      return response(200, { value: null });
    }) as typeof fetch,
  });
  try {
    await service.start();
    await service.capture('webview');
    assert.deepEqual(calls.slice(0, 6), ['install', 'paint', 'verify', 'screenshot', 'verify', 'remove']);
    calls.length = 0;
    await service.capture('window');
    assert.ok(calls.indexOf('install') < calls.indexOf('paint'));
    assert.ok(calls.indexOf('paint') < calls.indexOf('cmd:-lp'));
    assert.ok(calls.indexOf('cmd:-window') < calls.indexOf('remove'));
    assert.ok(calls.lastIndexOf('verify') < calls.indexOf('remove'), 'X11 mask integrity is checked after import and before removal/publication');
    await service.stop();
  } finally { await rm(root, { recursive: true, force: true }); if (oldDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = oldDisplay; if (oldWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = oldWayland; }
});

test('direct DesktopService config rejects dynamic and relational mask selectors before WebDriver capture', async () => {
  for (const selector of ['input:focus', 'input:checked', '.a + .b', '.card:has(.x)', 'li:nth-child(2)']) {
    const root = await project();
    let screenshotCalls = 0, executeCalls = 0;
    const service = new DesktopService({ ...config(root), maskSelectors: [selector] }, {
      ...driverFakes, spawn: (() => fakeChild()) as typeof import('node:child_process').spawn,
      fetch: (async (input: RequestInfo | URL) => { const url = String(input); if (url.endsWith('/status')) return response(200, { value: {} }); if (url.endsWith('/session')) return response(200, { value: { sessionId: 'mask-selector-reject' } }); if (url.includes('/execute/')) executeCalls++; if (url.endsWith('/screenshot')) screenshotCalls++; return response(200, { value: null }); }) as typeof fetch,
    });
    try { await service.start(); await assert.rejects(service.capture('webview'), /DOM-stable compound selector/); assert.equal(screenshotCalls, 0); assert.equal(executeCalls, 0, 'invalid selector syntax is rejected before any WebDriver script'); assert.equal((await service.status()).state, 'running'); await service.stop(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('mask uses protected top-layer important overlays and geometry refresh; async paint is ordered', async () => {
  const root = await project(), child = fakeChild(), scripts: string[] = [], referenceArgs: unknown[] = [];
  const trustedRef = { 'element-6066-11e4-a52e-4f735466cecf': 'fake-mask-element' };
  const service = new DesktopService({ ...config(root), maskSelectors: ['.secret'] }, { ...driverFakes,
    spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); if (url.endsWith('/status')) return response(200, { value: {} }); if (url.endsWith('/session')) return response(200, { value: { sessionId: 'overlay' } }); if (url.endsWith('/execute/sync') || url.endsWith('/execute/async')) { const body = JSON.parse(String(init?.body)), script = body.script; scripts.push(script); if (script.includes('__umbMaskCheck(secret)') || script.includes('__umbMaskCleanup(secret)')) referenceArgs.push(body.args[0]); return response(200, { value: url.endsWith('/execute/async') ? true : script.includes('showModal') ? trustedRef : true }); } if (url.endsWith('/screenshot')) return response(200, { value: png.toString('base64') }); return response(200, { value: null }); }) as typeof fetch,
  });
  try { await service.start(); await service.capture('webview'); assert.match(scripts[0]!, /showModal/); assert.match(scripts[0]!, /return dlg/); assert.match(scripts[0]!, /important/); assert.match(scripts[0]!, /closed shadow overlay setup/); assert.match(scripts[0]!, /attachShadow\(\{mode:'closed'\}\)/); assert.match(scripts[0]!, /getComputedStyle/); assert.match(scripts[0]!, /rectFor/); assert.match(scripts[0]!, /characterData:true/); assert.match(scripts[0]!, /observer\.observe\(document,/); assert.match(scripts[0]!, /external page DOM changed during capture/); assert.doesNotMatch(scripts[0]!, /clientWidth|clientLeft/, 'transformed overflow ancestors are handled conservatively using the viewport-clipped target rect'); assert.match(scripts[0]!, /selector match set changed/); assert.match(scripts[0]!, /another top-layer element may cover the mask/); assert.match(scripts[0]!, /fullscreen state cannot be masked/); assert.match(scripts[1]!, /requestAnimationFrame/); assert.match(scripts[1]!, /__umbMaskCheck/); assert.ok(referenceArgs.length >= 3); assert.ok(referenceArgs.every(reference => JSON.stringify(reference) === JSON.stringify(trustedRef)), 'paint, pre/post checks, and removal use the retained install reference'); assert.doesNotMatch(scripts[1]!, /querySelectorAll/); assert.doesNotMatch(scripts.at(-1)!, /querySelectorAll/); await service.stop(); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('uncertain install response is cleaned up, and failed cleanup kills driver and whole owned tree', async () => {
  const root = await project(), child = fakeChild(), killed: string[] = [];
  const service = new DesktopService({ ...config(root), maskSelectors: ['.secret'] }, { ...driverFakes,
    spawn: (() => child) as typeof import('node:child_process').spawn, processTree: async pid => new Set([pid, 4322, 4323]), isProcessAlive: () => true, killProcess: (pid, signal) => { killed.push(`${pid}:${signal}`); },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); if (url.endsWith('/status')) return response(200, { value: {} }); if (url.endsWith('/session')) return response(200, { value: { sessionId: 'lost-install' } }); if (url.endsWith('/execute/sync')) { const script = JSON.parse(String(init?.body)).script; return script.includes('showModal') ? response(200, { value: null }) : response(500, { value: { message: 'cleanup refused' } }); } return response(200, { value: null }); }) as typeof fetch,
  });
  try { await service.start(); await assert.rejects(service.capture('webview'), /trusted mask element/); assert.ok(killed.includes('4322:SIGTERM')); assert.ok(killed.includes('4322:SIGKILL')); assert.ok(killed.includes('4323:SIGKILL')); assert.equal(child.exitCode, 0); assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), []); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('mask loss, navigation, late matches, and new top-layer dialogs fail before capture', async () => {
  for (const mode of ['removed', 'closed', 'navigated', 'late-match', 'top-layer']) {
    const root = await project(), child = fakeChild(); let screenshots = 0, cleanup = false, killed: string[] = [];
    const service = new DesktopService({ ...config(root), maskSelectors: ['.secret'] }, { ...driverFakes,
      spawn: (() => child) as typeof import('node:child_process').spawn, processTree: async pid => new Set([pid, 4322]), isProcessAlive: pid => pid === 4322,
      killProcess: (pid, signal) => killed.push(`${pid}:${signal}`),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); if (url.endsWith('/status')) return response(200, { value: {} }); if (url.endsWith('/session')) return response(200, { value: { sessionId: `loss-${mode}` } }); if (url.endsWith('/screenshot')) screenshots++;
        if (url.endsWith('/execute/sync')) { const body = JSON.parse(String(init?.body)); if (body.script.includes('showModal')) return response(200, { value: { 'element-6066-11e4-a52e-4f735466cecf': 'fake-mask-element' } }); if (body.script.includes('node.remove()')) { cleanup = true; return mode === 'navigated' || mode === 'removed' || mode === 'closed' ? response(500, { value: { message: 'mask context lost' } }) : response(200, { value: true }); } return response(200, { value: true }); }
        if (url.endsWith('/execute/async')) return response(200, { value: { error: `${mode} detected` } }); return response(200, { value: null }); }) as typeof fetch,
    });
    try { await service.start(); await assert.rejects(service.capture('webview')); assert.equal(screenshots, 0); assert.equal(cleanup, true); if (mode === 'navigated' || mode === 'removed' || mode === 'closed') assert.ok(killed.includes('4322:SIGKILL')); await service.stop(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('fullscreen mutation injected at the final capture guard prevents screenshot request and artifact', async () => {
  const root = await project(), child = fakeChild(); let screenshotCalls = 0, mutationInjected = false;
  const service = new DesktopService({ ...config(root), maskSelectors: ['.secret'] }, { ...driverFakes,
    spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); if (url.endsWith('/status')) return response(200, { value: {} }); if (url.endsWith('/session')) return response(200, { value: { sessionId: 'fullscreen-boundary' } }); if (url.endsWith('/screenshot')) screenshotCalls++;
      if (url.endsWith('/execute/sync')) { const body = JSON.parse(String(init?.body)); if (body.script.includes('dlg.showModal()')) return response(200, { value: { 'element-6066-11e4-a52e-4f735466cecf': 'fake-mask-element' } }); if (body.script.includes('document.fullscreenElement')) { mutationInjected = true; return response(500, { value: { message: 'fullscreen state cannot be masked' } }); } return response(200, { value: true }); }
      if (url.endsWith('/execute/async')) return response(200, { value: true }); return response(200, { value: null }); }) as typeof fetch,
  });
  try { await service.start(); await assert.rejects(service.capture('webview'), /fullscreen state cannot be masked/); assert.equal(mutationInjected, true); assert.equal(screenshotCalls, 0); assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), []); await service.stop(); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('fullscreen or top-layer mutation at the screenshot request boundary discards returned bytes before saving', async () => {
  for (const mutation of ['fullscreen', 'top-layer']) {
    const root = await project(), child = fakeChild(); let screenshotCalls = 0, postCaptureCheck = false;
    const service = new DesktopService({ ...config(root), maskSelectors: ['.secret'] }, { ...driverFakes,
      spawn: (() => child) as typeof import('node:child_process').spawn,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/status')) return response(200, { value: {} });
        if (url.endsWith('/session')) return response(200, { value: { sessionId: `screenshot-boundary-${mutation}` } });
        if (url.endsWith('/screenshot')) { screenshotCalls++; return response(200, { value: png.toString('base64') }); }
        if (url.endsWith('/execute/sync')) {
          const body = JSON.parse(String(init?.body));
          if (body.script.includes('dlg.showModal()')) return response(200, { value: { 'element-6066-11e4-a52e-4f735466cecf': 'fake-mask-element' } });
          if (body.script.includes('dlg.__umbMaskCheck(secret)!==true')) {
            if (screenshotCalls > 0) { postCaptureCheck = true; return response(500, { value: { message: `${mutation} state changed at screenshot boundary` } }); }
            return response(200, { value: true });
          }
          return response(200, { value: true });
        }
        if (url.endsWith('/execute/async')) return response(200, { value: true });
        return response(200, { value: null });
      }) as typeof fetch,
    });
    try {
      await service.start();
      await assert.rejects(service.capture('webview'), new RegExp(`${mutation} state changed at screenshot boundary`));
      assert.equal(screenshotCalls, 1, 'the screenshot endpoint can return bytes before the post-capture guard');
      assert.equal(postCaptureCheck, true, 'post-capture integrity is checked before PNG persistence');
      assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), [], 'changed state publishes neither PNG nor artifact reference');
      await service.stop();
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('X11 command timeout contract reaps the import child before mask cleanup and leaves no PNG', async () => {
  const root = await project(), child = fakeChild(), events: string[] = [], oldDisplay = process.env.DISPLAY, oldWayland = process.env.WAYLAND_DISPLAY; delete process.env.WAYLAND_DISPLAY; process.env.DISPLAY = ':test';
  const service = new DesktopService({ ...config(root), maskSelectors: ['.secret'] }, { ...driverFakes, spawn: (() => child) as typeof import('node:child_process').spawn, processTree: async pid => new Set([pid]),
    command: async (_exe, args, timeoutMs) => { if (args[0] === '-lp') return { code: 0, stdout: '0x3 0 4321 host Demo Window\n', stderr: '' }; assert.equal(timeoutMs, 5000); events.push('term'); await new Promise(resolve => setTimeout(resolve, 1)); events.push('reaped'); throw Error('command timed out after child close'); },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); if (url.endsWith('/status')) return response(200, { value: {} }); if (url.endsWith('/session')) return response(200, { value: { sessionId: 'timeout' } }); if (url.endsWith('/execute/sync')) { const body = JSON.parse(String(init?.body)), script = body.script; if (script.includes('showModal')) return response(200, { value: { 'element-6066-11e4-a52e-4f735466cecf': 'fake-mask-element' } }); if (script.includes('node.remove()')) events.push('remove'); return response(200, { value: true }); } if (url.endsWith('/execute/async')) return response(200, { value: true }); return response(200, { value: null }); }) as typeof fetch,
  });
  try { await service.start(); await assert.rejects(service.capture('window'), /timed out/); assert.ok(events.indexOf('reaped') < events.indexOf('remove')); assert.equal(events.includes('remove'), true); assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), []); await service.stop(); }
  finally { await rm(root, { recursive: true, force: true }); if (oldDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = oldDisplay; if (oldWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = oldWayland; }
});

test('default X11 command TERM/KILLs and reaps a timed-out import before mask removal', { timeout: 15000 }, async () => {
  if (process.platform !== 'linux') return;
  const root = await project(), bin = path.join(root, 'bin'), pidFile = path.join(root, 'import.pid'), child = fakeChild(); await mkdir(bin);
  await writeFile(path.join(bin, 'wmctrl'), `#!/bin/sh\nprintf '0x3 0 4321 host Demo Window\\n'\n`); await chmod(path.join(bin, 'wmctrl'), 0o700);
  await writeFile(path.join(bin, 'import'), `#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/sleep 30\n`); await chmod(path.join(bin, 'import'), 0o700);
  const oldPath = process.env.PATH, oldDisplay = process.env.DISPLAY, oldWayland = process.env.WAYLAND_DISPLAY; process.env.PATH = bin; process.env.DISPLAY = ':test'; delete process.env.WAYLAND_DISPLAY;
  const events: string[] = [];
  const service = new DesktopService({ ...config(root), maskSelectors: ['.secret'] }, { ...driverFakes,
    spawn: (() => child) as typeof import('node:child_process').spawn, processTree: async pid => new Set([pid]),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); if (url.endsWith('/status')) return response(200, { value: {} }); if (url.endsWith('/session')) return response(200, { value: { sessionId: 'owned-timeout' } }); if (url.endsWith('/execute/sync')) { const body = JSON.parse(String(init?.body)); if (body.script.includes('showModal')) return response(200, { value: { 'element-6066-11e4-a52e-4f735466cecf': 'fake-mask-element' } }); events.push('remove'); return response(200, { value: true }); } if (url.endsWith('/execute/async')) return response(200, { value: true }); return response(200, { value: null }); }) as typeof fetch,
  });
  try {
    await service.start(); await assert.rejects(service.capture('window'), /timed out after 5000ms/);
    assert.ok(events.includes('remove'));
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'import process is reaped before mask cleanup completes');
    assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), []);
    await service.stop();
  } finally { await rm(root, { recursive: true, force: true }); if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; if (oldDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = oldDisplay; if (oldWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = oldWayland; }
});

test('post-write X11 quota failure removes reserved PNG', async () => {
  const root = await project(), oldDisplay = process.env.DISPLAY, oldWayland = process.env.WAYLAND_DISPLAY; delete process.env.WAYLAND_DISPLAY; process.env.DISPLAY = ':test';
  const service = new DesktopService({ ...config(root), maxArtifactBytes: 1 }, { ...driverFakes, spawn: (() => fakeChild()) as typeof import('node:child_process').spawn, processTree: async pid => new Set([pid]), command: async (_exe, args) => { if (args[0] === '-lp') return { code: 0, stdout: '0x3 0 4321 host Demo Window\n', stderr: '' }; if (args[0] === '-window') await writeFile(args[2]!, png); return { code: 0, stdout: '', stderr: '' }; }, fetch: (async (input: RequestInfo | URL) => String(input).endsWith('/status') ? response(200, { value: {} }) : String(input).endsWith('/session') ? response(200, { value: { sessionId: 'quota' } }) : response(200, { value: null })) as typeof fetch });
  try { await service.start(); await assert.rejects(service.capture('window'), /quota exceeded/); assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), []); await service.stop(); }
  finally { await rm(root, { recursive: true, force: true }); if (oldDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = oldDisplay; if (oldWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = oldWayland; }
});

test('partial WebDriver PNG writes and chmod failures leave no artifact', async () => {
  const root = await project(), child = fakeChild(), openDescriptor = Object.getOwnPropertyDescriptor(nodeFs, 'open'), chmodDescriptor = Object.getOwnPropertyDescriptor(nodeFs, 'chmod');
  const service = new DesktopService(config(root), { ...driverFakes, spawn: (() => child) as typeof import('node:child_process').spawn, fetch: (async (input: RequestInfo | URL) => String(input).endsWith('/status') ? response(200, { value: {} }) : String(input).endsWith('/session') ? response(200, { value: { sessionId: 'partial-write' } }) : response(200, { value: png.toString('base64') })) as typeof fetch });
  try {
    await service.start();
    Object.defineProperty(nodeFs, 'open', { configurable: true, value: async (...args: Parameters<typeof nodeFs.open>) => { const handle = await openDescriptor!.value(...args); if (String(args[0]).endsWith('.png')) { const realWrite = handle.writeFile.bind(handle); handle.writeFile = async data => { await realWrite(Buffer.from(data as any).subarray(0, 12)); throw Error('injected partial PNG write'); }; } return handle; } });
    await assert.rejects(service.capture('webview'), /partial PNG write/);
    assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), []);
    Object.defineProperty(nodeFs, 'open', openDescriptor!);
    Object.defineProperty(nodeFs, 'chmod', { configurable: true, value: async () => { throw Error('injected chmod failure'); } });
    await assert.rejects(service.capture('webview'), /chmod failure/);
    assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), []);
    await service.stop();
  } finally { if (openDescriptor) Object.defineProperty(nodeFs, 'open', openDescriptor); if (chmodDescriptor) Object.defineProperty(nodeFs, 'chmod', chmodDescriptor); await rm(root, { recursive: true, force: true }); }
});

test('reserved X11 temp PNG is removed when chmod fails immediately after creation', async () => {
  const root = await project(), oldDisplay = process.env.DISPLAY, oldWayland = process.env.WAYLAND_DISPLAY, chmodDescriptor = Object.getOwnPropertyDescriptor(nodeFs, 'chmod'); delete process.env.WAYLAND_DISPLAY; process.env.DISPLAY = ':test';
  const service = new DesktopService(config(root), { ...driverFakes, spawn: (() => fakeChild()) as typeof import('node:child_process').spawn, processTree: async pid => new Set([pid]),
    command: async (_exe, args) => { if (args[0] === '-lp') return { code: 0, stdout: '0x3 0 4321 host Demo Window\n', stderr: '' }; if (args[0] === '-window') await writeFile(args[2]!, png); return { code: 0, stdout: '', stderr: '' }; },
    fetch: (async (input: RequestInfo | URL) => String(input).endsWith('/status') ? response(200, { value: {} }) : String(input).endsWith('/session') ? response(200, { value: { sessionId: 'reserve-chmod' } }) : response(200, { value: null })) as typeof fetch,
  });
  try { await service.start(); Object.defineProperty(nodeFs, 'chmod', { configurable: true, value: async (target: any, mode: any) => { if (String(target).endsWith('.png')) throw Error('injected reserve chmod failure'); return chmodDescriptor!.value(target, mode); } }); await assert.rejects(service.capture('window'), /reserve chmod failure/); assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), []); await service.stop(); }
  finally { if (chmodDescriptor) Object.defineProperty(nodeFs, 'chmod', chmodDescriptor); await rm(root, { recursive: true, force: true }); if (oldDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = oldDisplay; if (oldWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = oldWayland; }
});

test('mask cleanup reports artifact deletion failure and never returns a capture ref', async () => {
  const root = await project(), child = fakeChild(), rmDescriptor = Object.getOwnPropertyDescriptor(nodeFs, 'rm');
  const service = new DesktopService({ ...config(root), maskSelectors: ['.secret'] }, { ...driverFakes,
    spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); if (url.endsWith('/status')) return response(200, { value: {} }); if (url.endsWith('/session')) return response(200, { value: { sessionId: 'cleanup-rm-fail' } }); if (url.endsWith('/execute/sync')) { const body = JSON.parse(String(init?.body)); if (body.script.includes('showModal')) return response(200, { value: { 'element-6066-11e4-a52e-4f735466cecf': 'fake-mask-element' } }); if (body.script.includes('mask cleanup context was lost')) return response(500, { value: { message: 'mask removed unexpectedly' } }); return response(200, { value: true }); } if (url.endsWith('/execute/async')) return response(200, { value: true }); if (url.endsWith('/screenshot')) return response(200, { value: png.toString('base64') }); return response(200, { value: null }); }) as typeof fetch,
  });
  try {
    await service.start();
    Object.defineProperty(nodeFs, 'rm', { configurable: true, value: async (target: any, options: any) => { if (String(target).endsWith('.png')) throw Error('injected artifact deletion failure'); return rmDescriptor!.value(target, options); } });
    await assert.rejects(service.capture('webview'), error => { assert.match(String(error), /artifact deletion failed/); assert.doesNotMatch(String(error), /artifact_ref/); return true; });
    assert.equal((await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop'))).filter(name => name.endsWith('.png')).length, 1, 'the injected filesystem refusal is surfaced, never returned as a capture');
  } finally { if (rmDescriptor) Object.defineProperty(nodeFs, 'rm', rmDescriptor); await rm(root, { recursive: true, force: true }); }
});

test('session stop retains and kills a surviving owned descendant after driver exits unexpectedly', async () => {
  const root = await project(), child = fakeChild(), signals: string[] = [];
  let alive = true;
  const service = new DesktopService(config(root), { ...driverFakes, spawn: (() => child) as typeof import('node:child_process').spawn,
    processTree: async pid => pid === 4321 ? new Set([4321, 4322]) : new Set([4322]),
    isProcessAlive: pid => pid === 4322 && alive,
    killProcess: (pid, signal) => { signals.push(`${pid}:${signal}`); if (signal === 'SIGKILL') alive = false; },
    fetch: (async (input: RequestInfo | URL) => String(input).endsWith('/status') ? response(200, { value: {} }) : String(input).endsWith('/session') ? response(200, { value: { sessionId: 'unexpected-exit' } }) : response(200, { value: null })) as typeof fetch,
  });
  try { await service.start(); child.emit('exit', 0); await new Promise(resolve => setImmediate(resolve)); assert.ok(signals.includes('4322:SIGTERM')); assert.ok(signals.includes('4322:SIGKILL')); assert.deepEqual(await service.stop(), { stopped: false }); assert.equal(alive, false); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux process-group boundary kills late reparented descendants absent from processTree without harming unrelated groups', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const root = await project(), pidFile = path.join(root, 'late-child.pid'), serverScript = path.join(root, 'driver-server.cjs');
  const serverSource = `const http=require('node:http'),{spawn}=require('node:child_process');const port=Number(process.argv[process.argv.indexOf('--port')+1]);const pidFile=${JSON.stringify(pidFile)};const childCode=\`const {spawn}=require('node:child_process');setTimeout(()=>{const p=spawn('/bin/sh',['-c',\"echo \\\$\\$ > '\${pidFile}'; trap '' TERM; exec /bin/sleep 60\"],{stdio:'ignore'});p.unref()},350);setInterval(()=>{},1000);\`;const child=spawn(process.execPath,['-e',childCode],{stdio:'ignore'});child.unref();http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/status')return res.end(JSON.stringify({value:{ready:true}}));if(req.method==='POST'&&req.url==='/session')return res.end(JSON.stringify({value:{sessionId:'group-owned'}}));return res.end(JSON.stringify({value:null}))}).listen(port,'127.0.0.1');`;
  await writeFile(serverScript, serverSource);
  let driver: ChildProcess | undefined;
  const unrelated = realSpawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' }); unrelated.unref();
  const service = new DesktopService({ projectRoot: root, tauriBinary: 'app', driverExecutable: process.execPath, driverArgs: [serverScript], artifactDirectory: 'artifacts', readinessTimeoutMs: 3000 }, {
    spawn: ((command: string, args: string[], options: any) => { driver = realSpawn(command, args, options); return driver; }) as typeof import('node:child_process').spawn,
    processTree: async pid => new Set([pid]),
  });
  const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
  try {
    await service.start();
    const deadline = Date.now() + 4000;
    let latePid = 0;
    while (Date.now() < deadline) { latePid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim()); if (latePid) break; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.ok(latePid, 'a descendant created after the service processTree snapshot is running');
    assert.equal(isAlive(unrelated.pid!), true);
    driver!.kill('SIGTERM');
    await new Promise<void>(resolve => driver!.once('exit', () => resolve()));
    await service.stop();
    assert.equal(groupAlive(driver!.pid!), false, 'stop resolves only after the isolated process group disappears');
    assert.equal(isAlive(latePid), false, 'late reparented descendant is gone before stop resolves');
    assert.equal(isAlive(unrelated.pid!), true, 'unrelated process group is not signaled');
  } finally {
    await service.stop().catch(() => undefined);
    if (driver && driver.exitCode === null) driver.kill('SIGKILL');
    if (unrelated.exitCode === null) unrelated.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('failed group TERM signal with an untracked member reports stop failure for stop and capture', { skip: process.platform !== 'linux', timeout: 20000 }, async () => {
  const root = await project(), child = fakeChild(); let screenshotCalls = 0, groupPresent = true; const groupSignals: string[] = [];
  const service = new DesktopService({ ...config(root), maskSelectors: ['.secret'] }, { ...driverFakes,
    spawn: (() => child) as typeof import('node:child_process').spawn,
    processTree: async pid => new Set([pid]),
    killProcessGroup: (_pgid, signal) => { groupSignals.push(signal); if (signal === 'SIGTERM' && groupPresent) { const error = Object.assign(new Error('fixture group TERM denied'), { code: 'EPERM' }); throw error; } },
    isProcessGroupAlive: () => groupPresent,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/status')) return response(200, { value: {} });
      if (url.endsWith('/session')) return response(200, { value: { sessionId: 'group-stop-failure' } });
      if (url.endsWith('/screenshot')) { screenshotCalls++; return response(200, { value: png.toString('base64') }); }
      if (url.endsWith('/execute/async')) return response(200, { value: true });
      if (url.endsWith('/execute/sync')) {
        const body = JSON.parse(String(init?.body));
        if (body.script.includes('dlg.showModal()')) return response(200, { value: { 'element-6066-11e4-a52e-4f735466cecf': 'fake-mask-element' } });
        if (body.script.includes('node.__umbMaskCleanup(secret)')) return response(500, { value: { message: 'fixture mask cleanup failed' } });
        return response(200, { value: true });
      }
      return response(200, { value: null });
    }) as typeof fetch,
  });
  try {
    await service.start();
    await assert.rejects(service.capture('webview'), error => {
      assert.match(String(error), /managed session stop failed/);
      assert.match(String(error), /remained alive after SIGKILL/);
      return true;
    });
    assert.equal(screenshotCalls, 1, 'received screenshot bytes are discarded after cleanup and stop both fail');
    assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), [], 'no artifact reference or PNG is published');
    await assert.rejects(service.stop(), /remained alive after SIGKILL/, 'explicit stop also reports a group that PID fallback could not terminate');
    assert.ok(groupSignals.includes('SIGTERM') && groupSignals.includes('SIGKILL'));
    groupPresent = false;
    await service.stop();
  } finally { groupPresent = false; await service.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('group TERM rejection with a real untracked member fails masked capture and withholds artifact', { skip: process.platform !== 'linux', timeout: 20000 }, async () => {
  const root = await project(), pidFile = path.join(root, 'untracked-member.pid'), serverScript = path.join(root, 'mask-driver-server.cjs');
  const serverSource = `const http=require('node:http'),{spawn}=require('node:child_process'),fs=require('node:fs');const port=Number(process.argv[process.argv.indexOf('--port')+1]);setTimeout(()=>{const child=spawn('/bin/sleep',['60'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref()},300);http.createServer((req,res)=>{res.setHeader('content-type','application/json');let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{const body=raw?JSON.parse(raw):{};if(req.url==='/status')return res.end(JSON.stringify({value:{ready:true}}));if(req.method==='POST'&&req.url==='/session')return res.end(JSON.stringify({value:{sessionId:'real-untracked'}}));if(req.url.endsWith('/execute/async'))return res.end(JSON.stringify({value:true}));if(req.url.endsWith('/execute/sync')){if(body.script.includes('return dlg'))return res.end(JSON.stringify({value:{'element-6066-11e4-a52e-4f735466cecf':'trusted-dialog'}}));if(body.script.includes('__umbMaskCleanup(secret)')){res.statusCode=500;return res.end(JSON.stringify({value:{error:'unknown error',message:'fixture overlay cleanup failed'}}))}return res.end(JSON.stringify({value:true}))}if(req.url==='/screenshot')return res.end(JSON.stringify({value:${JSON.stringify(png.toString('base64'))}}));return res.end(JSON.stringify({value:null}))})}).listen(port,'127.0.0.1');`;
  await writeFile(serverScript, serverSource);
  let driver: ChildProcess | undefined, latePid = 0;
  const service = new DesktopService({ projectRoot: root, tauriBinary: 'app', driverExecutable: process.execPath, driverArgs: [serverScript], artifactDirectory: 'artifacts', maskSelectors: ['.secret'], readinessTimeoutMs: 3000 }, {
    spawn: ((command: string, args: string[], options: any) => { driver = realSpawn(command, args, options); return driver; }) as typeof import('node:child_process').spawn,
    processTree: async pid => new Set([pid]),
    killProcessGroup: (_pgid, signal) => { const error = Object.assign(new Error(`fixture ${signal} group permission denied`), { code: 'EPERM' }); throw error; },
    isProcessGroupAlive: pgid => { try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } },
  });
  const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
  try {
    await service.start();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) { latePid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim()); if (latePid) break; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.ok(latePid, 'untracked process group member has started after the processTree snapshot');
    assert.equal(process.kill(latePid, 0), true);
    await assert.rejects(service.capture('webview'), error => {
      assert.match(String(error), /managed session stop failed/);
      assert.match(String(error), /remained alive after SIGKILL/);
      return true;
    });
    assert.equal(process.kill(latePid, 0), true, 'PID fallback did not imply the untracked group member was gone');
    assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), [], 'failed group termination publishes neither bytes nor an artifact reference');
  } finally {
    if (driver?.pid) try { process.kill(-driver.pid, 'SIGKILL'); } catch { /* group may already be gone */ }
    const cleanupDeadline = Date.now() + 4000;
    if (driver?.pid) while (groupAlive(driver.pid) && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    await service.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses unrelated windows and Wayland does not downgrade to desktop capture', async () => {
  const root = await project(); const child = fakeChild(); let imageCalls = 0;
  const previousWayland = process.env.WAYLAND_DISPLAY, previousDisplay = process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY; process.env.DISPLAY = ':test';
  const base: Partial<DesktopAdapters> = {
    spawn: (() => child) as typeof import('node:child_process').spawn,
    processTree: async () => new Set([4321]),
    command: async (_exe, args) => { if (args[0] === '-lp') return { code: 0, stdout: '0x1 0 9876 host Demo Window\n', stderr: '' }; if (args[0] === '-window') imageCalls++; return { code: 0, stdout: '', stderr: '' }; },
    fetch: (async (input: RequestInfo | URL) => String(input).endsWith('/status') ? response(200, { value: {} }) : String(input).endsWith('/session') ? response(200, { value: { sessionId: 'owned' } }) : response(200, { value: null })) as typeof fetch,
  };
  try {
    const service = new DesktopService(config(root), { ...driverFakes, ...base }); await service.start();
    await assert.rejects(service.capture('window'), /refusing unrelated-window capture/); assert.equal(imageCalls, 0);
    const oldWayland = process.env.WAYLAND_DISPLAY; process.env.WAYLAND_DISPLAY = 'wayland-0';
    try { await assert.rejects(service.capture('window'), /Wayland.*no configured consented portal/); } finally { if (oldWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = oldWayland; }
    assert.equal(imageCalls, 0); await service.stop();
  } finally { await rm(root, { recursive: true, force: true }); if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previousWayland; if (previousDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = previousDisplay; }
});

test('window capability requires both X11 capture utilities', async () => {
  if (process.platform !== 'linux') return;
  const root = await project(); const oldWayland = process.env.WAYLAND_DISPLAY, oldDisplay = process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY; process.env.DISPLAY = ':test';
  try {
    const missing = new DesktopService(config(root), { command: async executable => ({ code: executable === 'wmctrl' ? 127 : 0, stdout: '', stderr: '' }) });
    const unavailable = await missing.capabilities();
    assert.equal(unavailable.windowCapture.available, false); assert.match(unavailable.windowCapture.reason!, /wmctrl/);
    const installed = new DesktopService(config(root), { command: async () => ({ code: 0, stdout: '', stderr: '' }) });
    assert.equal((await installed.capabilities()).windowCapture.available, true);
  } finally {
    if (oldWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = oldWayland;
    if (oldDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = oldDisplay;
    await rm(root, { recursive: true, force: true });
  }
});

test('bounded semantic APIs use safe summaries and supported W3C actions', async () => {
  const root = await project(); const child = fakeChild(); const requests: { url: string; body?: string }[] = [];
  const adapters: Partial<DesktopAdapters> = {
    spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); requests.push({ url, body: init?.body?.toString() });
      if (url.endsWith('/status')) return response(200, { value: {} });
      if (url.endsWith('/session')) return response(200, { value: { sessionId: 'api-session' } });
      if (url.endsWith('/element')) return response(200, { value: { 'element-6066-11e4-a52e-4f735466cecf': 'element-1' } });
      if (url.endsWith('/elements')) return response(200, { value: [{ 'element-6066-11e4-a52e-4f735466cecf': 'element-1' }] });
      if (url.endsWith('/execute/sync')) {
        const body = JSON.parse(init?.body?.toString() ?? '{}');
        if (body.script.includes('document.querySelectorAll')) return response(200, { value: [{ role: 'button', accessibleName: 'Save', text: 'Save', enabled: true, visible: true, rect: { x: 1, y: 2, width: 30, height: 20 } }] });
        if (body.script.includes('getComputedStyle')) return response(200, { value: { text: 'Save', rect: { x: 1, y: 2, width: 30, height: 20 }, attributes: { id: 'save', 'aria-label': 'Save' }, styles: { display: 'block', paddingTop: '8px' }, overflow: { horizontal: true, vertical: false, clippedHorizontal: true, clippedVertical: false, scrollWidth: 80, scrollHeight: 20, clientWidth: 30, clientHeight: 20 } } });
        if (body.script.includes('arguments[0].map')) return response(200, { value: [{ index: 0, role: 'button', accessibleName: 'Save', text: 'Save', enabled: true, visible: true, rect: { x: 1, y: 2, width: 30, height: 20 } }] });
      }
      if (url.endsWith('/window/rect')) return response(200, { value: { x: 0, y: 0, width: 800, height: 600 } });
      return response(200, { value: null });
    }) as typeof fetch,
  };
  try {
    const service = new DesktopService(config(root), { ...driverFakes, ...adapters }); await service.start();
    const found = await service.find('#save', 2); assert.equal(found[0]?.accessibleName, 'Save');
    await service.click('#save');
    assert.equal(requests.find(request => request.url.endsWith('/click'))?.body, '{}', 'W3C element click sends a valid JSON object body');
    const tree = await service.tree(20); assert.ok(Array.isArray(tree));
    const details = await service.details('#save'); assert.equal('value' in details.attributes, false); assert.equal(details.overflow.clippedHorizontal, true); assert.equal(details.styles.paddingTop, '8px');
    await service.keypress(['A', 'B']); await service.scroll(undefined, 0, 300); await service.scroll('#save');
    assert.equal(await service.waitFor('#save', 'visible', 100), true);
    assert.equal((await service.resizeWindow(800, 600)).width, 800);
    assert.ok(requests.some(r => r.url.endsWith('/actions')));
    assert.ok(requests.some(r => r.url.endsWith('/window/rect')));
    const detailsRequest = requests.find(r => r.url.endsWith('/execute/sync') && r.body?.includes("const e=arguments[0],s=getComputedStyle(e)"))!;
    assert.doesNotMatch(detailsRequest.body!, /['"]value['"]/, 'details never includes an input value attribute');
    await assert.rejects(service.tree(301), /maxNodes/);
    await service.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('temporary window size restores the complete original rect after success and callback failure', async () => {
  const root = await project(); const child = fakeChild();
  let rect = { x: 17, y: 29, width: 900, height: 700 };
  let failRestore = false;
  const calls: { method: string; body?: any }[] = [];
  const service = new DesktopService(config(root), { ...driverFakes,
    spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/status')) return response(200, { value: {} });
      if (url.endsWith('/session')) return response(200, { value: { sessionId: 'window-size' } });
      if (url.endsWith('/window/rect')) {
        const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, body });
        if (method === 'GET') return response(200, { value: rect });
        if (failRestore && body?.x === 17) { failRestore = false; return response(500, { value: { message: 'restore refused' } }); }
        rect = { ...rect, ...body };
        return response(200, { value: rect });
      }
      return response(200, { value: null });
    }) as typeof fetch,
  });
  try {
    await service.start();
    assert.equal(await service.withWindowSize(1280, 720, async () => { assert.deepEqual(rect, { x: 17, y: 29, width: 1280, height: 720 }); return 'ok'; }), 'ok');
    assert.deepEqual(rect, { x: 17, y: 29, width: 900, height: 700 });
    await assert.rejects(service.withWindowSize(640, 480, async () => { throw Error('capture failed'); }), /capture failed/);
    assert.deepEqual(rect, { x: 17, y: 29, width: 900, height: 700 });
    failRestore = true;
    await assert.rejects(service.withWindowSize(320, 240, async () => 'captured'), /Could not restore original WebDriver window rect: WebDriver POST \/window\/rect failed: restore refused/);
    failRestore = true;
    await assert.rejects(service.withWindowSize(320, 240, async () => { throw Error('callback failed'); }), error => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors[0].message, /callback failed/);
      assert.match(error.errors[1].message, /restore refused/);
      return true;
    });
    const postsBeforeInvalidRect = calls.filter(call => call.method === 'POST').length;
    rect = { x: 17, y: 29, width: 0, height: 240 };
    await assert.rejects(service.withWindowSize(800, 600, async () => 'never'), /invalid original window rect/);
    assert.equal(calls.filter(call => call.method === 'POST').length, postsBeforeInvalidRect, 'invalid original rect must be rejected before resizing or restoration');
    assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.body), [
      { width: 1280, height: 720 }, { x: 17, y: 29, width: 900, height: 700 },
      { width: 640, height: 480 }, { x: 17, y: 29, width: 900, height: 700 },
      { width: 320, height: 240 }, { x: 17, y: 29, width: 900, height: 700 },
      { width: 320, height: 240 }, { x: 17, y: 29, width: 320, height: 240 },
    ]);
    await service.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('screenshots use configured private artifact subdirectory and enforce quota', async () => {
  const root = await project(); const child = fakeChild();
  const adapters: Partial<DesktopAdapters> = {
    spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL) => String(input).endsWith('/status') ? response(200, { value: {} }) : String(input).endsWith('/session') ? response(200, { value: { sessionId: 'artifacts' } }) : response(200, { value: png.toString('base64') })) as typeof fetch,
  };
  try {
    const service = new DesktopService({ ...config(root), maxArtifactCount: 1 }, { ...driverFakes, ...adapters }); await service.start();
    const saved = await service.capture('webview');
    assert.equal(path.dirname(saved.path), path.join(root, 'artifacts', '.umb-managed', 'desktop'));
    assert.equal(saved.artifactRef, 'artifacts/.umb-managed/desktop/' + path.basename(saved.path));
    assert.equal('managedArtifactRef' in saved, false);
    assert.equal(saved.sha256, createHash('sha256').update(png).digest('hex'));
    assert.equal(saved.byteLength, png.length);
    assert.equal((await lstat(saved.path)).mode & 0o777, 0o600);
    assert.equal((await lstat(path.dirname(saved.path))).mode & 0o777, 0o700);
    assert.deepEqual(await service.readArtifact(saved.artifactRef!, saved.sha256!, saved.byteLength!), png);
    const alias = `desktop/${path.basename(saved.path)}`;
    await assert.rejects(service.readArtifact(alias, saved.sha256!, saved.byteLength!), /reference/);
    await assert.rejects(service.removeArtifact(alias), /reference/);
    await assert.rejects(service.capture('webview'), /artifact quota exceeded/);
    const malformed = Buffer.from(png); malformed[malformed.length - 1] ^= 1;
    await writeFile(saved.path, malformed);
    await assert.rejects(service.readArtifact(saved.artifactRef!, createHash('sha256').update(malformed).digest('hex'), malformed.length), /PNG|CRC/);
    await writeFile(saved.path, Buffer.concat([png, Buffer.from([1])]));
    await assert.rejects(service.readArtifact(saved.artifactRef!, saved.sha256!, saved.byteLength!), /size|integrity/);
    await rm(saved.path);
    await assert.rejects(service.readArtifact(saved.artifactRef!, saved.sha256!, saved.byteLength!), /missing|regular PNG/);
    await assert.rejects(new DesktopService({ ...config(root), artifactDirectory: undefined }).capture('webview'), /No artifact directory is created implicitly/);
    await service.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generated artifacts use canonical refs, bounded writes, and rollback cleanup', async () => {
  const root = await project();
  try {
    const service = new DesktopService(config(root));
    const saved = await service.saveGeneratedArtifact(png);
    assert.equal(saved.artifactRef, `artifacts/.umb-managed/desktop/${path.basename(saved.path)}`);
    assert.equal('managedArtifactRef' in saved, false);
    assert.equal(saved.byteLength, png.length);
    assert.equal(saved.sha256, createHash('sha256').update(png).digest('hex'));
    assert.deepEqual(await service.readArtifact(saved.artifactRef, saved.sha256, saved.byteLength), png);
    const alias = `desktop/${path.basename(saved.path)}`;
    await assert.rejects(service.readArtifact(alias, saved.sha256, saved.byteLength), /reference/);
    await assert.rejects(service.removeArtifact(alias), /reference/);
    await service.removeArtifact(saved.artifactRef);
    await assert.rejects(readFile(saved.path), { code: 'ENOENT' });
    await assert.rejects(service.removeArtifact('../outside.png'), /canonical desktop artifact reference/);

    const limited = new DesktopService({ ...config(root), maxArtifactFileBytes: 8 });
    await assert.rejects(limited.saveGeneratedArtifact(png), /per-file desktop artifact limit/);
    await assert.rejects(service.saveGeneratedArtifact(Buffer.from('not a png')), /PNG/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('age pruning removes only old unreferenced canonical regular PNGs in the managed directory', async () => {
  const root = await project();
  try {
    const service = new DesktopService(config(root));
    const managed = path.join(root, 'artifacts', '.umb-managed', 'desktop');
    await mkdir(managed, { recursive: true });
    const old = path.join(managed, 'desktop-old.png'), recent = path.join(managed, 'desktop-recent.png');
    const referenced = path.join(managed, 'desktop-referenced.png'), temporary = path.join(managed, '.desktop-temp.png');
    const nonPng = path.join(managed, 'desktop-other.txt'), odd = path.join(managed, 'desktop-temp.png.tmp');
    for (const file of [old, recent, referenced, temporary, nonPng, odd]) await writeFile(file, png);
    const oldTime = new Date(Date.now() - 10 * 86400_000);
    await utimes(old, oldTime, oldTime); await utimes(referenced, oldTime, oldTime);
    await utimes(temporary, oldTime, oldTime); await utimes(nonPng, oldTime, oldTime); await utimes(odd, oldTime, oldTime);
    const outside = path.join(root, 'outside.png'); await writeFile(outside, png);
    await symlink(outside, path.join(managed, 'desktop-symlink.png'));
    const deleted = await service.pruneUnreferencedArtifacts(['artifacts/.umb-managed/desktop/desktop-referenced.png'], 5);
    assert.deepEqual(deleted, ['artifacts/.umb-managed/desktop/desktop-old.png']);
    await assert.rejects(readFile(old), { code: 'ENOENT' });
    for (const file of [recent, referenced, temporary, nonPng, odd, path.join(managed, 'desktop-symlink.png'), outside]) assert.ok(await lstat(file));
    await assert.rejects(service.pruneUnreferencedArtifacts([], 0), /maxArtifactAgeDays/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('desktop artifact paths reject symlinks in configured roots and persisted refs', async () => {
  const root = await project(), outside = await mkdtemp(path.join(os.tmpdir(), 'desktop-outside-'));
  try {
    await symlink(outside, path.join(root, 'linked-artifacts'));
    const linked = new DesktopService({ ...config(root), artifactDirectory: 'linked-artifacts' });
    await assert.rejects(linked.capture('webview'), /symlink|Symlinks/i);

    const service = new DesktopService(config(root));
    const managed = path.join(root, 'artifacts', '.umb-managed', 'desktop');
    await mkdir(managed, { recursive: true });
    const outsidePng = path.join(outside, 'outside.png'); await writeFile(outsidePng, png);
    await symlink(outsidePng, path.join(managed, 'linked.png'));
    await assert.rejects(service.readArtifact('artifacts/.umb-managed/desktop/linked.png', createHash('sha256').update(png).digest('hex'), png.length), /symlink/i);
    await assert.rejects(service.readArtifact('../outside.png', createHash('sha256').update(png).digest('hex'), png.length), /reference/i);
    assert.equal((await lstat(path.join(managed, 'linked.png'))).isSymbolicLink(), true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('individual screenshot file limit is enforced independently of total-byte quota', async () => {
  const root = await project(); const child = fakeChild();
  const adapters: Partial<DesktopAdapters> = {
    spawn: (() => child) as typeof import('node:child_process').spawn,
    fetch: (async (input: RequestInfo | URL) => String(input).endsWith('/status') ? response(200, { value: {} }) : String(input).endsWith('/session') ? response(200, { value: { sessionId: 'file-limit' } }) : response(200, { value: png.toString('base64') })) as typeof fetch,
  };
  try {
    const service = new DesktopService({ ...config(root), maxArtifactFileBytes: 8, maxArtifactBytes: 1024 }, { ...driverFakes, ...adapters });
    await service.start();
    await assert.rejects(service.capture('webview'), /per-file desktop artifact limit of 8 bytes/);
    assert.deepEqual(await readdir(path.join(root, 'artifacts', '.umb-managed', 'desktop')), []);
    await service.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configured build runs only on start with exact argv and validated cwd before session creation', async () => {
  const root = await project(); const build = fakeBuildChild(8801); const requests: string[] = []; const spawnCalls: { command: string; args: string[]; options: any }[] = [];
  const adapters: Partial<DesktopAdapters> = {
    spawn: ((command: string, args: string[], options: any) => {
      spawnCalls.push({ command, args, options });
      if (command === 'npm') { setImmediate(() => { build.stdout!.write('build ok'); Object.assign(build, { exitCode: 0 }); build.emit('close', 0, null); }); return build; }
      return fakeChild();
    }) as typeof import('node:child_process').spawn,
    reservePort: async () => 23456,
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input); requests.push(url);
      return url.endsWith('/status') ? response(200, { value: {} }) : response(200, { value: { sessionId: 'built-app' } });
    }) as typeof fetch,
  };
  try {
    const service = new DesktopService({ ...config(root), buildCommand: { command: 'npm', args: ['run', 'tauri:build'], cwd: '.' }, buildTimeoutMs: 1000 }, adapters);
    await service.inspectProject(); assert.equal(spawnCalls.length, 0);
    const session = await service.start(); assert.equal(session.id, 'built-app');
    assert.equal(spawnCalls[0]?.command, 'npm'); assert.deepEqual(spawnCalls[0]?.args, ['run', 'tauri:build']);
    assert.equal(spawnCalls[0]?.options.cwd, root); assert.equal(spawnCalls[0]?.options.shell, false);
    assert.equal(spawnCalls[1]?.command, '/fake/tauri-driver');
    assert.ok(requests.some(url => url.endsWith('/session')));
    await service.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build failure reports bounded output and exit status without starting driver', async () => {
  const root = await project(); const build = fakeBuildChild(8802); let driverStarted = false;
  const service = new DesktopService({ ...config(root), buildCommand: { command: 'builder', args: ['--build'] } }, {
    spawn: ((command: string) => {
      if (command !== 'builder') { driverStarted = true; return fakeChild(); }
      setImmediate(() => { build.stdout!.write('stdout diagnostic'); build.stderr!.write('stderr diagnostic'); Object.assign(build, { exitCode: 7 }); build.emit('close', 7, null); });
      return build;
    }) as typeof import('node:child_process').spawn,
  });
  try {
    await assert.rejects(service.start(), error => {
      assert.match(String(error), /exit status 7/); assert.match(String(error), /stdout diagnostic/); assert.match(String(error), /stderr diagnostic/); return true;
    });
    assert.equal(driverStarted, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build timeout and explicit stop terminate only the owned build child', async () => {
  const root = await project(); const child = fakeBuildChild(8803, false); const unrelatedKills: number[] = [];
  const service = new DesktopService({ ...config(root), buildCommand: { command: 'slow-build', args: [] }, buildTimeoutMs: 20 }, {
    spawn: (() => child) as typeof import('node:child_process').spawn,
    killProcess: pid => { unrelatedKills.push(pid); },
  });
  try {
    await assert.rejects(service.start(), /timed out after 20ms/);
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(unrelatedKills, []);

    const stoppedChild = fakeBuildChild(8804, true); let spawnCount = 0;
    const stoppedService = new DesktopService({ ...config(root), buildCommand: { command: 'slow-build', args: [] }, buildTimeoutMs: 5000 }, {
      spawn: (() => { spawnCount++; return stoppedChild; }) as typeof import('node:child_process').spawn,
      killProcess: pid => { unrelatedKills.push(pid); },
    });
    const start = stoppedService.start();
    for (let i = 0; i < 20 && spawnCount === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(spawnCount, 1);
    assert.deepEqual(await stoppedService.stop(), { stopped: true });
    await assert.rejects(start, /was stopped/);
    assert.deepEqual(stoppedChild.signals, ['SIGTERM']);
    assert.deepEqual(unrelatedKills, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
