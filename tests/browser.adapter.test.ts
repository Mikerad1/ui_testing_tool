import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserController, PlaywrightBrowserAdapter } from '../src/browser/controller.js';
import type { BrowserTarget, CapturedActionGuard } from '../src/browser/adapter.js';
import type { Config } from '../src/config/config.js';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

async function close(server: Server) {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
}

test('captured targets are opaque, guarded at mutation time, and explicitly released', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-browser-adapter-'));
  const fixture = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(
    '<button data-testid="protected" onclick="document.querySelector(\'#result\').textContent=\'clicked\'">Go</button><input data-testid="upload" type="file"><div id="result"></div>',
  ));
  const port = await listen(fixture);
  const config = { project: { base_url: `http://127.0.0.1:${port}` }, browser: { headless: true, viewport: { width: 800, height: 600 }, allowed_origins: [] } } as Config;
  const browser = new PlaywrightBrowserAdapter(config, root);
  const target: BrowserTarget = { by: 'test_id', value: 'protected' };
  try {
    await browser.start();
    await browser.navigate('/');

    const stale = await browser.captureVisibleTarget(target);
    assert.ok(stale);
    assert.equal('handle' in stale, false, 'provider handle is not exposed through the adapter token');
    const staleGuard: CapturedActionGuard = { expectedRevision: browser.revision, expectedOrigin: new URL(browser.currentUrl()).origin, isSessionCurrent: () => true, targets: [target] };
    await browser.setViewport(801, 600);
    await assert.rejects(browser.performCaptured('click', stale, undefined, 0, staleGuard), /approval_denied/);
    assert.equal(await browser.page.locator('#result').textContent(), '', 'stale state does not perform the action');
    await browser.releaseCapturedTarget(stale);
    assert.equal(await browser.capturedTargetUsable(stale), false, 'released tokens cannot be reused');

    const expiredSession = await browser.captureVisibleTarget(target);
    assert.ok(expiredSession);
    const expiredGuard: CapturedActionGuard = { expectedRevision: browser.revision, expectedOrigin: new URL(browser.currentUrl()).origin, isSessionCurrent: () => false, targets: [target] };
    await assert.rejects(browser.performCaptured('click', expiredSession, undefined, 0, expiredGuard), /approval_denied/);
    assert.equal(await browser.page.locator('#result').textContent(), '', 'expired session does not perform the action');
    await browser.releaseCapturedTarget(expiredSession);

    const replaced = await browser.captureVisibleTarget(target);
    assert.ok(replaced);
    const unchangedRevision = browser.revision;
    await browser.page.getByTestId('protected').evaluate(element => element.replaceWith(element.cloneNode(true)));
    assert.equal(browser.revision, unchangedRevision, 'page-side DOM replacement does not bump the adapter revision');
    const replacementGuard: CapturedActionGuard = { expectedRevision: unchangedRevision, expectedOrigin: new URL(browser.currentUrl()).origin, isSessionCurrent: () => true, targets: [target] };
    await assert.rejects(browser.performCaptured('click', replaced, undefined, 0, replacementGuard), /approval_denied/);
    assert.equal(await browser.page.locator('#result').textContent(), '', 'a cloned replacement target is not acted on');
    await browser.releaseCapturedTarget(replaced);

    const allowed = await browser.captureVisibleTarget(target);
    assert.ok(allowed);
    const allowedGuard: CapturedActionGuard = { expectedRevision: browser.revision, expectedOrigin: new URL(browser.currentUrl()).origin, isSessionCurrent: () => true, targets: [target] };
    await browser.performCaptured('click', allowed, undefined, 0, allowedGuard);
    assert.equal(await browser.page.locator('#result').textContent(), 'clicked');
    await browser.releaseCapturedTarget(allowed);
  } finally {
    await browser.close();
    await close(fixture);
    await rm(root, { recursive: true, force: true });
  }
});

test('BrowserController remains a compatibility alias and browser consumers stay provider-neutral', async () => {
  assert.equal(BrowserController, PlaywrightBrowserAdapter);
  const files = [
    '../src/mcp/server.ts',
    '../src/workflow/runner.ts',
    '../src/workflow/browser-driver.ts',
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"]playwright['"]/);
    assert.doesNotMatch(source, /\bbrowser\.page\b/);
    assert.doesNotMatch(source, /BrowserController/);
  }
  const server = await readFile(new URL('../src/mcp/server.ts', import.meta.url), 'utf8');
  assert.match(server, /browserAdapter:\s*BrowserAdapter\s*\|\s*undefined/);
});
