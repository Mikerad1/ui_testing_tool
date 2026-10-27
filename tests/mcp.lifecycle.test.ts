import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/memory/store.js';
import { serve } from '../src/mcp/server.js';
import type { Config } from '../src/config/config.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}

async function fixture(idleTimeoutMs = 45) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-mcp-lifecycle-'));
  const probe = (await import('node:net')).createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as any).port as number;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const config: Config = {
    version: 1,
     provider: 'desktop',
     project: { id: `lifecycle-${process.pid}`, name: 'Lifecycle', base_url: 'http://127.0.0.1:1' },
    server: { host: '127.0.0.1', port, auth: { mode: 'none' } },
    browser: { headless: true, viewport: { width: 800, height: 600 }, allowed_origins: [] },
    memory: { database: path.join(root, 'memory.sqlite') },
    knowledge: { path: path.join(root, 'knowledge') },
     desktop: { mode: 'managed', enabled: true, root: '.', automation: {}, window: {}, visual: {} },
  } as Config;
  const store = new Store(config.memory.database, config.project.id);
  let sessionStatus: (() => Promise<void>) | undefined, running=false;
  let stopServer: (() => Promise<void>) | undefined;
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;
  let stopCalls = 0;
  let capability: (() => Promise<void>) | undefined;
  const desktopFactoryCalls = { value: 0 };
  try {
     stopServer = await serve(config, store, undefined, {
      idleTimeoutMs,
      desktopServiceFactory: () => {
        desktopFactoryCalls.value++;
        return {
          capabilities: async () => { await capability?.(); return { available: true }; },
          start: async () => { running=true; return{id:'owned',state:'running'}; },
          status: async () => { await sessionStatus?.(); if(!running)throw Error('No managed desktop session is running.');return{id:'owned',state:'running'}; },
          stop: async () => { stopCalls++;running=false; },
        } as any;
      },
    });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      fetch: async (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), accept: 'application/json, text/event-stream' } }),
    });
    client = new Client({ name: 'mcp-lifecycle-test', version: '1' });
    await client.connect(transport);
    return {
      client, transport, store, root, desktopFactoryCalls,
      get stopCalls() { return stopCalls; },
      setCapability(value: () => Promise<void>) { capability = value; },
       setSessionStatus(value: () => Promise<void>) { sessionStatus = value; },
      shutdown: async () => { await stopServer?.(); },
      cleanup: async () => {
        await client?.close().catch(() => undefined);
        await transport?.close().catch(() => undefined);
        await stopServer?.().catch(() => undefined);
        store.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    store.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test('any active session tool suspends idle expiry and final completion rearms one cleanup', { timeout: 10000 }, async () => {
  const f = await fixture(200);
  const entered = deferred(), release = deferred();
  try {
    await f.client.callTool({ name: 'ui_capabilities', arguments: {} });
    assert.equal(f.desktopFactoryCalls.value, 1);
    await f.client.callTool({name:'ui_session_start',arguments:{}});
    f.setSessionStatus(async () => { entered.resolve(); await release.promise; });
    const active = f.client.callTool({ name: 'ui_session_status', arguments: {} });
    await entered.promise;
    await delay(350);
    assert.equal(f.stopCalls, 0, 'idle timeout does not stop service while any session tool is active');
    release.resolve();
    await active;
    await until(() => f.stopCalls === 1, 'final tool completion rearms idle cleanup');
    await delay(100);
    assert.equal(f.stopCalls, 1, 'idle expiry invokes stop exactly once');
  } finally { await f.cleanup(); }
});

test('transport close marks session closed and serializes single-flight stop behind desktop queue work', { timeout: 10000 }, async () => {
  const f = await fixture(1000);
  const entered = deferred(), release = deferred();
  try {
    f.setCapability(async () => { entered.resolve(); await release.promise; });
    await f.client.callTool({name:'ui_session_start',arguments:{}});
    const active = f.client.callTool({ name: 'ui_capabilities', arguments: {} });
    void active.catch(() => undefined); // transport closure intentionally interrupts the client's pending request
    await entered.promise;
    const transportClose = Promise.resolve().then(() => f.transport.close()).catch(() => undefined);
    // Server shutdown and transport close race to clean the same session.
    const shutdown = f.shutdown();
    await delay(60);
    assert.equal(f.stopCalls, 0, 'stop waits for the runDesktop critical section');
    release.resolve();
    await Promise.allSettled([active, transportClose, shutdown]);
    await until(() => f.stopCalls === 1, 'transport/server cleanup eventually stops service');
    assert.equal(f.stopCalls, 1, 'duplicate cleanup paths share one stop');
  } finally { await f.cleanup(); }
});
