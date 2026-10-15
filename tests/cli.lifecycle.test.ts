import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, unlink, readFile, realpath, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { acquireProjectLock } from '../src/security/project-lock.js';
import { ShutdownLifecycle } from '../src/cli/lifecycle.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function freePort(): Promise<number> {
 const server = createNetServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const port = (server.address() as import('node:net').AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
function child(config: string, _cwd: string): { process: ChildProcess; stderr: () => string; stdout: () => string } {
 const proc = spawn(process.execPath, [path.join(repo, 'dist/src/cli/index.js'), 'serve', '--config', config], { cwd: repo, env: { ...process.env, UMB_MCP_TOKEN: 'test-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
 let out = '', err = ''; proc.stdout?.on('data', b => { out += b.toString(); }); proc.stderr?.on('data', b => { err += b.toString(); });
 return { process: proc, stderr: () => err, stdout: () => out };
}
async function waitReady(c: ReturnType<typeof child>, stage: string): Promise<void> {
 const deadline = Date.now() + 30000;
 while (Date.now() < deadline) {
  if (c.stderr().includes('listening at')) return;
  if (c.process.exitCode !== null) throw new Error(`${stage}: child exited ${c.process.exitCode}; stderr=${c.stderr()}; stdout=${c.stdout()}`);
  await new Promise(resolve => setTimeout(resolve, 100));
 }
 throw new Error(`${stage}: ready banner timeout; stderr=${c.stderr()}; stdout=${c.stdout()}`);
}
async function exitChild(c: ReturnType<typeof child>, stage: string, signal?: NodeJS.Signals): Promise<void> {
 if (c.process.exitCode !== null) return;
 const exited = once(c.process, 'exit');
 if (signal) c.process.kill(signal); else c.process.kill();
 const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${stage}: child did not exit; stderr=${c.stderr()}`)), 20000));
 await Promise.race([exited, timer]);
}

test('project lock contends, releases idempotently, and can be reacquired', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'umb-lock-'));
 try {
  const lock = await acquireProjectLock(root, 'test', './db.sqlite');
  await assert.rejects(acquireProjectLock(root, 'test', './db.sqlite'), /locked/);
  await lock.release(); await lock.release();
  const next = await acquireProjectLock(root, 'test', './db.sqlite'); await next.release();
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent lock acquisition has exactly one winner', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'umb-race-'));
 try {
  const results = await Promise.allSettled([acquireProjectLock(root, 'test', './db.sqlite'), acquireProjectLock(root, 'test', './db.sqlite')]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'fulfilled') await result.value.release();
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('dead same-host owner is recovered; malformed and foreign owners fail closed', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'umb-stale-'));
 const lockDir = path.join(root, '.umb', 'locks'); await mkdir(lockDir, { recursive: true });
 const { createHash } = await import('node:crypto');
  const project = path.join(lockDir, `${createHash('sha256').update(`project:${await realpath(root)}:test`).digest('hex')}.lock`);
 try {
  await writeFile(project, JSON.stringify({ token: 'old', pid: 2147483647, host: os.hostname(), acquiredAt: new Date().toISOString() }));
   const lock = await acquireProjectLock(root, 'test', './db.sqlite'); await lock.release();
   const original = `${project}.original`;
   await writeFile(project, '{broken');
   await rename(project, original);
   try {
    await writeFile(project, '{broken'); await assert.rejects(acquireProjectLock(root, 'test', './db.sqlite'), /malformed/);
   } finally { await unlink(project).catch(() => undefined); await rename(original, project); }
  await writeFile(project, JSON.stringify({ token: 'other', pid: 2147483647, host: 'remote-host', acquiredAt: new Date().toISOString() }));
  await assert.rejects(acquireProjectLock(root, 'test', './db.sqlite'), /host/);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('canonical root and database aliases share lock identity', async () => {
 const parent = await mkdtemp(path.join(os.tmpdir(), 'umb-alias-'));
 const root = path.join(parent, 'project'); await mkdir(root);
 try {
  const first = await acquireProjectLock(root, 'test', './nested/../db.sqlite');
  await assert.rejects(acquireProjectLock(path.resolve(root, '.'), 'test', './db.sqlite'), /locked/);
  await first.release();
 } finally { await rm(parent, { recursive: true, force: true }); }
});

test('overlapping project roots contend on the identical canonical database file', async () => {
 const parent = await mkdtemp(path.join(os.tmpdir(), 'umb-shared-db-'));
 const rootA = path.join(parent, 'project'); const rootB = path.join(rootA, 'sub');
 await mkdir(rootB, { recursive: true });
 try {
  const first = await acquireProjectLock(rootA, 'project-a', './sub/.umb/memory.sqlite');
  await assert.rejects(acquireProjectLock(rootB, 'project-b', './.umb/memory.sqlite'), /locked by PID|already locked/i);
  await first.release();
  const second = await acquireProjectLock(rootB, 'project-b', './.umb/memory.sqlite');
  await second.release();
 } finally { await rm(parent, { recursive: true, force: true }); }
});

test('concurrent stale-lock reclaim preserves the winning owner token', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'umb-reclaim-race-'));
 try {
  const lockDir = path.join(root, '.umb', 'locks'); await mkdir(lockDir, { recursive: true });
  const { createHash } = await import('node:crypto');
   const projectLock = path.join(lockDir, `${createHash('sha256').update(`project:${await realpath(root)}:race`).digest('hex')}.lock`);
  await writeFile(projectLock, JSON.stringify({ token: 'stale-owner', pid: 2147483647, host: os.hostname(), acquiredAt: new Date(0).toISOString() }));
  const attempts = await Promise.allSettled([
   acquireProjectLock(root, 'race', './.umb/memory.sqlite'),
   acquireProjectLock(root, 'race', './.umb/memory.sqlite'),
  ]);
  const winners = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireProjectLock>>> => result.status === 'fulfilled');
  const losers = attempts.filter(result => result.status === 'rejected');
  assert.equal(winners.length, 1, 'exactly one contender must own both locks');
  assert.equal(losers.length, 1, 'the competing contender must fail closed');
  assert.match(String((losers[0] as PromiseRejectedResult).reason), /locked|gate.*busy/i);
  const current = JSON.parse(await readFile(projectLock, 'utf8')) as { token: string; pid: number };
  assert.notEqual(current.token, 'stale-owner');
  assert.equal(current.pid, process.pid);
  await winners[0].value.release();
  const next = await acquireProjectLock(root, 'race', './.umb/memory.sqlite'); await next.release();
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('post-create acquisition failure removes owned lock and permits retry', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'umb-create-failure-'));
 let createdPath = '';
 try {
  await assert.rejects(acquireProjectLock(root, 'fault', './.umb/memory.sqlite', {
   afterMainLockCreate(file) { createdPath = file; throw new Error('injected post-create failure'); },
  }), /injected post-create failure/);
  assert.ok(createdPath, 'failure hook must run after a main lock is created');
  await assert.rejects(readFile(createdPath), { code: 'ENOENT' }, 'failed acquisition must not leave its main lock behind');
  const lock = await acquireProjectLock(root, 'fault', './.umb/memory.sqlite');
  await lock.release();
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('post-create cleanup preserves a malformed replacement file', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'umb-replacement-'));
 let lockPath = '';
 const replacement = '{replacement-owner-metadata';
 try {
  await assert.rejects(acquireProjectLock(root, 'replace', './.umb/memory.sqlite', {
   async afterMainLockCreate(file) {
    lockPath = file;
     await rename(file, `${file}.original`);
     await writeFile(file, replacement);
    throw new Error('injected failure after replacement');
   },
  }), /injected failure after replacement/);
  assert.ok(lockPath);
  assert.equal(await readFile(lockPath, 'utf8'), replacement, 'cleanup must not delete malformed content at a replaced path');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shutdown requested during startup waits for readiness and runs ordered cleanup once', async () => {
 const order: string[] = [];
 const lifecycle = new ShutdownLifecycle(async () => { order.push('listener/sessions', 'browser', 'store', 'lock'); });
 lifecycle.requestStop(); lifecycle.requestStop();
 assert.equal(lifecycle.stopRequested, true);
 assert.deepEqual(order, [], 'startup resources must not be closed while initialization is active');
 let stopObserved = false; void lifecycle.waitForStopRequest().then(() => { stopObserved = true; });
 await Promise.resolve(); assert.equal(stopObserved, true);
 lifecycle.markReady(); lifecycle.markReady();
 await lifecycle.shutdown(); await lifecycle.shutdown();
 assert.deepEqual(order, ['listener/sessions', 'browser', 'store', 'lock']);
});

test('startup failure can explicitly clean up before ready and cleanup errors propagate', async () => {
 let calls = 0;
 const failure = new Error('cleanup failed');
 const lifecycle = new ShutdownLifecycle(async () => { calls++; throw failure; });
 await assert.rejects(lifecycle.shutdown(), error => error === failure);
 await assert.rejects(lifecycle.shutdown(), error => error === failure);
 assert.equal(calls, 1);
});

test('serve child locks, cleans up on startup failure and signal, then restarts', { timeout: 60000 }, async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'umb-process-'));
 const app = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>fixture</title><body>ready</body></html>'); });
 app.listen(0, '127.0.0.1'); await once(app, 'listening');
 const appPort = (app.address() as import('node:net').AddressInfo).port;
  const port = await freePort(); const config = path.join(root, 'umb.config.yaml');
 const yaml = (db = './.umb/memory.sqlite') => `version: 1\nproject:\n  id: lifecycle\n  name: lifecycle\n  base_url: http://127.0.0.1:${appPort}\nserver:\n  host: 127.0.0.1\n  port: ${port}\n  auth:\n    mode: token\n    token_env: UMB_MCP_TOKEN\nbrowser:\n  headless: true\n  allowed_origins:\n    - http://127.0.0.1:${appPort}\nmemory:\n  database: ${db}\nknowledge:\n  path: ./knowledge\n`;
 await mkdir(path.join(root, 'knowledge'), { recursive: true }); await writeFile(config, yaml());
 let running: ReturnType<typeof child> | undefined;
 try {
  // Force a failure after acquiring the lock (parent component is a file).
  const blocker = path.join(root, 'not-a-directory'); await writeFile(blocker, 'x');
  await writeFile(config, yaml('./not-a-directory/db.sqlite'));
  let failed = child(config, root); running = failed;
  await once(failed.process, 'exit');
  assert.notEqual(failed.process.exitCode, 0, `startup failure exit expected; stderr=${failed.stderr()}`);
  await unlink(blocker); await writeFile(config, yaml());

   running = child(config, root); await waitReady(running, 'first serve');
  const duplicate = child(config, root); await once(duplicate.process, 'exit');
  assert.notEqual(duplicate.process.exitCode, 0, `duplicate serve should fail; stderr=${duplicate.stderr()}`);
  assert.match(duplicate.stderr(), /locked by PID|already locked/i, `duplicate must show lock diagnostic: ${duplicate.stderr()}`);

  const signal: NodeJS.Signals = 'SIGINT';
  const first = running; first.process.kill(signal);
  const exit = await Promise.race([once(first.process, 'exit'), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`graceful ${signal} shutdown timed out: ${first.stderr()}`)), 20000))]);
  assert.ok(exit, `signal shutdown exit event missing; stderr=${first.stderr()}`);
  if (process.platform === 'win32' && first.process.exitCode === null) {
   // Node's Windows child-process signal API terminates the child rather than delivering a catchable POSIX signal.
   // Continue with restart/recovery assertions; the graceful-handler assertion is unavailable on this platform.
   assert.equal(first.process.signalCode, signal, `Windows termination signal observed; stderr=${first.stderr()}`);
   } else assert.equal(first.process.exitCode, 0, `graceful signal exit; stderr=${first.stderr()}`);
   running = undefined;
   const probe = createServer(); probe.listen(port, '127.0.0.1'); await once(probe, 'listening'); await new Promise<void>(resolve => probe.close(() => resolve()));
   const recoveredLock = await acquireProjectLock(root, 'lifecycle', './.umb/memory.sqlite');
   await recoveredLock.release();

  running = child(config, root); await waitReady(running, 'restart after signal');
  await exitChild(running, 'final cleanup', signal); running = undefined;
 } catch (error) {
  assert.fail(`CLI lifecycle stage failed: ${(error as Error).message}${running ? `; stderr=${running.stderr()}; stdout=${running.stdout()}` : ''}`);
 } finally {
  if (running) { try { await exitChild(running, 'finally cleanup'); } catch { running.process.kill(); } }
  await new Promise<void>(resolve => app.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
 }
});

test('serve remains available until the configured frontend starts, then refreshes over HTTP', { timeout: 60000 }, async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'umb-late-frontend-'));
 const app = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>late app</title><body>ready</body></html>'); });
 const appPort = await freePort(), port = await freePort(), config = path.join(root, 'umb.config.yaml');
 await mkdir(path.join(root, 'knowledge'), { recursive: true });
 await writeFile(config, `version: 1\nproject:\n  id: late-frontend\n  name: late-frontend\n  base_url: http://127.0.0.1:${appPort}\nserver:\n  host: 127.0.0.1\n  port: ${port}\n  auth:\n    mode: token\n    token_env: UMB_MCP_TOKEN\nbrowser:\n  headless: true\n  allowed_origins:\n    - http://127.0.0.1:${appPort}\nmemory:\n  database: ./.umb/memory.sqlite\nknowledge:\n  path: ./knowledge\n`);
 const running = child(config, root), token = 'test-token';
 let client: Client | undefined, transport: StreamableHTTPClientTransport | undefined;
 try {
  await waitReady(running, 'serve with frontend unavailable');
  transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
   requestInit: { headers: { authorization: `Bearer ${token}` } },
   fetch: (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), accept: 'application/json, text/event-stream' } }),
  });
  client = new Client({ name: 'late-frontend-http-test', version: '1.0.0' });
  await client.connect(transport);
  const status = await client.callTool({ name: 'browser_status', arguments: {} });
  assert.equal((status as any).structuredContent.data.application_ready, false);
  const failed = await client.callTool({ name: 'browser_refresh', arguments: {} });
  assert.equal(failed.isError, true);
  assert.match((failed as any).structuredContent.error.message, /start the application.*browser_refresh/i);
  const stillUnavailable = await client.callTool({ name: 'browser_status', arguments: {} });
  assert.equal((stillUnavailable as any).structuredContent.data.application_ready, false);
  app.listen(appPort, '127.0.0.1'); await once(app, 'listening');
  const refreshed = await client.callTool({ name: 'browser_refresh', arguments: {} });
  assert.equal((refreshed as any).structuredContent.data.application_ready, true);
  const ready = await client.callTool({ name: 'browser_status', arguments: {} });
  assert.equal((ready as any).structuredContent.data.application_ready, true);
 } finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  if (running.process.exitCode === null) await exitChild(running, 'late frontend cleanup');
  if (app.listening) await new Promise<void>(resolve => app.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
 }
});
