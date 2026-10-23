import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/memory/store.js';
import { serve } from '../src/mcp/server.js';
import { reconcile } from '../src/knowledge/reconcile.js';
import { testWriter } from './helpers/learning.js';
import type { Config } from '../src/config/config.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('desktop_run_workflow enforces owned-session execution, preflight, provenance, auth safety, envelopes, and lifecycle', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-workflow-'));
  const knowledge = path.join(root, 'knowledge');
  await mkdir(knowledge);
  const probe = (await import('node:net')).createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as any).port as number;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const secretEnv = `UMB_DESKTOP_WORKFLOW_SECRET_${process.pid}`;
  const secret = `DESKTOP_WORKFLOW_SECRET_SENTINEL_${process.pid}`;
  process.env[secretEnv] = secret;
  const config: Config = {
    version: 1,
    project: { id: `desktop-workflow-${process.pid}`, name: 'Desktop workflow', base_url: 'http://127.0.0.1:1' },
    server: { host: '127.0.0.1', port, auth: { mode: 'none' } },
    browser: { headless: true, viewport: { width: 800, height: 600 }, allowed_origins: [] },
    application_auth: { mode: 'workflow', workflow_id: 'auth-safe' },
    desktop: { enabled: true, root, automation: {}, window: { screenshot_mode: 'webview' }, visual: { capture_on_failure: true } },
    artifacts: { directory: './.umb/artifacts', max_file_bytes: 100000, max_total_bytes: 100000, max_count: 50 },
    memory: { database: path.join(root, 'memory.sqlite') },
    knowledge: { path: knowledge },
  } as Config;
  const store = new Store(config.memory.database, config.project.id);
  const actions: string[] = [];
  let operationGate = { entered: deferred(), release: deferred() };
  let shouldBlock = false, failClick = false, factoryCalls = 0, startCalls = 0, stopCalls = 0, captureCalls = 0, running = false;
  const uploads: Array<{ selector: any; projectRelativePath: string }> = [];
  const directTargets: Array<{ operation: string; selector: any }> = [];
  let sessionId: string | undefined;
  let serverStop: (() => Promise<void>) | undefined, transport: StreamableHTTPClientTransport | undefined, client: Client | undefined;
  const workflow = (id: string, body: string) => `schema_version: 1\nkind: workflow\nid: ${id}\nname: ${id}\n${body}`;
  const writeWorkflow = (id: string, body: string) => writeFile(path.join(knowledge, `${id}.yaml`), workflow(id, body));
  const service = {
    start: async () => { startCalls++; running = true; return { id: 'owned-desktop-session' }; },
    stop: async () => { stopCalls++; running = false; return { stopped: true }; },
    status: async () => { if (!running) throw Error('No managed desktop session is running.'); return { id: 'owned-desktop-session', state: 'running' }; },
    setActionRequestTimeout: (_timeout: number | undefined) => {},
    find: async (selector: any) => {
      directTargets.push({ operation: 'find', selector });
      if (selector && typeof selector === 'object' && selector.value === 'missing') return [];
      if (selector && typeof selector === 'object' && selector.value === 'multiple') return [{ visible: true, enabled: true, text: 'Ready' }, { visible: true, enabled: true, text: 'Ready' }];
      return [{ visible: true, enabled: true, text: 'Ready' }];
    },
    click: async (selector: string) => {
      directTargets.push({ operation: 'click', selector });
      actions.push(`click:${typeof selector === 'string' ? selector : JSON.stringify(selector)}`);
      if (shouldBlock && selector === '#blocked') { operationGate.entered.resolve(); await operationGate.release.promise; }
      if (failClick) throw Error('Fixture click failed with PRIVATE_ACTION_SENTINEL');
    },
    type: async (selector: any, text: string) => { directTargets.push({ operation: 'type', selector }); actions.push(`type:${typeof selector === 'string' ? selector : JSON.stringify(selector)}:${text}`); },
    upload: async (selector: string, projectRelativePath: string) => {
      if (!running) throw Error('No managed WebDriver session.');
      directTargets.push({ operation: 'upload', selector });
      uploads.push({ selector, projectRelativePath });
      return { basename: path.basename(projectRelativePath), byteLength: 12 };
    },
    scroll: async (selector?: any, _x?: number, _y?: number) => { if (selector !== undefined) directTargets.push({ operation: 'scroll', selector }); actions.push('scroll'); },
    waitFor: async (selector?: any) => { if (selector !== undefined) directTargets.push({ operation: 'waitFor', selector }); actions.push('wait'); return true; },
    text: async (selector?: any) => { if (selector !== undefined) directTargets.push({ operation: 'text', selector }); return 'Ready'; },
    details: async (selector: any) => { directTargets.push({ operation: 'details', selector }); return { text: 'Ready' }; },
    capture: async () => {
      captureCalls++;
      const artifactRef = '.umb/artifacts/.umb-managed/desktop/workflow-failure.png';
      const target = path.join(root, artifactRef);
      await mkdir(path.dirname(target), { recursive: true });
      const bytes = Buffer.alloc(24);
      await writeFile(target, bytes);
      return { path: target, artifactRef, kind: 'webview', bytes, byteLength: bytes.length, sha256: '0'.repeat(64) };
    },
    pruneUnreferencedArtifacts: async () => {},
    removeArtifact: async (ref: string) => { await rm(path.join(root, ref), { force: true }); },
  } as any;
  const browser = { revision: 7, setActionTimeout: () => {}, status: async () => ({ url: 'fixture' }), page: { url: () => 'http://127.0.0.1:1/' } } as any;
  try {
    await writeFile(path.join(knowledge, 'application.yaml'), 'schema_version: 1\nid: app\nname: App\nkind: application\nstart_screen: home\n');
    await writeFile(path.join(knowledge, 'home.yaml'), 'schema_version: 1\nid: home\nname: Home\nkind: screen\n');
    await writeWorkflow('portable', `steps:
  - {id: click, action: click, target: {by: css, value: '#button'}}
  - {id: type, action: type, target: {by: css, value: '#input'}, value: hello}
  - {id: scroll, action: scroll, direction: down, amount: 30}
  - {id: wait, action: wait, condition: visible, target: {by: css, value: '#button'}, timeout_ms: 100}
  - {id: assert, action: assert, condition: text, target: {by: css, value: '#status'}, expected: Ready}
`);
    await writeWorkflow('late-unsupported', `steps:
  - {id: first, action: click, target: {by: css, value: '#marker'}}
  - {id: bad, action: fill, target: {by: css, value: '#input'}, value: secret}
`);
    await writeWorkflow('unsupported-route', `start_screen: home
steps: [{id: click, action: click, target: {by: css, value: '#marker'}}]
`);
    await writeWorkflow('unsupported-capture', `on_failure: {capture: [screenshot]}
steps: [{id: click, action: click, target: {by: css, value: '#marker'}}]
`);
    await writeWorkflow('unsupported-target', `steps: [{id: click, action: click, target: {by: role, role: button}}]
`);
    await writeWorkflow('unsupported-placeholder-target', `steps: [{id: click, action: click, target: {by: placeholder, value: Save}}]
`);
    await writeWorkflow('unsupported-label-target', `steps: [{id: click, action: click, target: {by: label, value: Save}}]
`);
    await writeWorkflow('unsupported-condition', `steps: [{id: wait, action: wait, condition: url, target: /home}]
`);
    await writeWorkflow('risky-click', `steps: [{id: click, action: click, target: {by: css, value: '#marker'}}]
`);
    await writeWorkflow('risky-any', `steps: [{id: type, action: type, target: {by: css, value: '#input'}, value: sensitive-payload}]
`);
    await writeWorkflow('auth-safe', `variables:
  AUTH_TOKEN:
    from_env: ${secretEnv}
    sensitive: true
steps:
  - {id: type-secret, action: type, target: {by: css, value: '#input'}, value: '\${{ variables.AUTH_TOKEN }}'}
on_failure: {capture: [desktop_screenshot]}
`);
    await writeWorkflow('runtime-failure', `on_failure: {capture: [desktop_screenshot]}
steps: [{id: click, action: click, target: {by: css, value: '#button'}}]
`);
    await writeWorkflow('blocked', `on_failure: {capture: []}
steps: [{id: click, action: click, target: {by: css, value: '#blocked'}}]
`);
    await reconcile(knowledge, store, testWriter(store));
    serverStop = await serve(config, store, browser, { projectRoot: root, knowledgeRoot: knowledge, desktopServiceFactory: () => { factoryCalls++; return service; } });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      fetch: async (input, init) => {
        const response = await fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), accept: 'application/json, text/event-stream' } });
        sessionId = response.headers.get('mcp-session-id') ?? sessionId;
        return response;
      },
    });
    client = new Client({ name: 'desktop-workflow-integration', version: '1' });
    await client.connect(transport);
    const call = (name: string, args: Record<string, unknown>) => client!.callTool({ name, arguments: args }) as Promise<any>;
    const countRuns = (workflowId: string) => {
      const node = store.currentYamlWorkflow(workflowId);
      return node ? Number((store.db.prepare('SELECT count(*) AS count FROM runs WHERE workflow_id=?').get(node.id) as any).count) : 0;
    };
    const workflowRun = (workflowId: string) => {
      const node = store.currentYamlWorkflow(workflowId)!;
      return (store.db.prepare('SELECT id FROM runs WHERE workflow_id=? ORDER BY started_at DESC LIMIT 1').get(node.id) as any)?.id as string | undefined;
    };
    const encoded = (result: any) => JSON.stringify({ structuredContent: result.structuredContent, content: result.content });

    const absentBefore = countRuns('portable');
    const absent = await call('desktop_run_workflow', { workflow_id: 'portable', expected_session_id: 'owned-desktop-session' });
    assert.equal(absent.structuredContent.ok, false);
    assert.equal(factoryCalls, 0); assert.equal(startCalls, 0); assert.equal(countRuns('portable'), absentBefore);
    const start = await call('desktop_session_start', {});
    assert.equal(start.structuredContent.ok, true); assert.equal(factoryCalls, 1); assert.equal(startCalls, 1);
    await call('desktop_session_stop', {});
    const stoppedCount = countRuns('portable');
    const stoppedUpload = await call('desktop_upload', { selector: 'input[type=file]', project_relative_path: 'fixtures/upload.txt' });
    assert.equal(stoppedUpload.structuredContent.ok, false);
    assert.equal(stoppedUpload.structuredContent.error.code, 'desktop_session_not_running');
    assert.equal(startCalls, 1, 'desktop_upload never starts a session');
    assert.deepEqual(uploads, []);
    const stopped = await call('desktop_run_workflow', { workflow_id: 'portable', expected_session_id: 'owned-desktop-session' });
    assert.equal(stopped.structuredContent.ok, false); assert.equal(countRuns('portable'), stoppedCount);
    await call('desktop_session_start', {});
    const roleTarget = { by: 'role', role: 'button', name: 'Save' };
    const testIdTarget = { by: 'test_id', value: 'save-button' };
    const placeholderTarget = { by: 'placeholder', value: 'Search' };
    const labelTarget = { by: 'label', value: 'Search' };
    const minimumLabelTarget = { by: 'label', value: 'x' };
    const maximumLabelTarget = { by: 'label', value: 'x'.repeat(1000) };
    const minimumPlaceholderTarget = { by: 'placeholder', value: 'x' };
    const maximumPlaceholderTarget = { by: 'placeholder', value: 'x'.repeat(1000) };
    assert.equal((await call('desktop_find_element', { selector: roleTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_find_element', { selector: testIdTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_find_element', { selector: placeholderTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_find_element', { selector: labelTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_find_element', { selector: minimumLabelTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_find_element', { selector: maximumLabelTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_find_element', { selector: minimumPlaceholderTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_find_element', { selector: maximumPlaceholderTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_click', { selector: roleTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_type', { selector: testIdTarget, text: 'hello' })).structuredContent.ok, true);
    assert.equal((await call('desktop_click', { selector: placeholderTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_type', { selector: placeholderTarget, text: 'query' })).structuredContent.ok, true);
    assert.equal((await call('desktop_upload', { selector: placeholderTarget, project_relative_path: 'fixtures/upload.txt' })).structuredContent.ok, true);
    assert.equal((await call('desktop_scroll', { selector: placeholderTarget, y: 10 })).structuredContent.ok, true);
    assert.equal((await call('desktop_wait_for', { selector: placeholderTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_assert', { selector: placeholderTarget, assertion: 'visible' })).structuredContent.ok, true);
    assert.equal((await call('desktop_assert', { selector: placeholderTarget, assertion: 'text', match: 'contains', expected: 'Ready' })).structuredContent.ok, true);
    assert.equal((await call('desktop_get_element_details', { selector: placeholderTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_scroll', { selector: roleTarget, y: 10 })).structuredContent.ok, true);
    assert.equal((await call('desktop_wait_for', { selector: testIdTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_assert', { selector: roleTarget, assertion: 'visible' })).structuredContent.ok, true);
    assert.equal((await call('desktop_get_element_details', { selector: testIdTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_click', { selector: labelTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_type', { selector: labelTarget, text: 'labeled' })).structuredContent.ok, true);
    assert.equal((await call('desktop_upload', { selector: labelTarget, project_relative_path: 'fixtures/upload.txt' })).structuredContent.ok, true);
    assert.equal((await call('desktop_scroll', { selector: labelTarget, y: 10 })).structuredContent.ok, true);
    assert.equal((await call('desktop_wait_for', { selector: labelTarget })).structuredContent.ok, true);
    assert.equal((await call('desktop_assert', { selector: labelTarget, assertion: 'visible' })).structuredContent.ok, true);
    assert.equal((await call('desktop_assert', { selector: labelTarget, assertion: 'text', match: 'contains', expected: 'Ready' })).structuredContent.ok, true);
    assert.equal((await call('desktop_get_element_details', { selector: labelTarget })).structuredContent.ok, true);
    for (const target of [roleTarget, testIdTarget, placeholderTarget, labelTarget]) assert.ok(directTargets.some(item => item.selector === target || JSON.stringify(item.selector) === JSON.stringify(target)), `semantic target passed through: ${JSON.stringify(target)}`);
    for (const operation of ['find', 'click', 'type', 'upload', 'scroll', 'waitFor', 'text', 'details']) assert.ok(directTargets.some(item => item.operation === operation && JSON.stringify(item.selector) === JSON.stringify(placeholderTarget)), `placeholder target passed through ${operation}`);
    for (const operation of ['find', 'click', 'type', 'upload', 'scroll', 'waitFor', 'text', 'details']) assert.ok(directTargets.some(item => item.operation === operation && JSON.stringify(item.selector) === JSON.stringify(labelTarget)), `label target passed through ${operation}`);
    assert.equal((await call('desktop_assert', { selector: { by: 'test_id', value: 'missing' }, assertion: 'present' })).structuredContent.data.assertion.status, 'FAIL');
    const multipleAssertion = await call('desktop_assert', { selector: { by: 'test_id', value: 'multiple' }, assertion: 'visible' });
    assert.equal(multipleAssertion.structuredContent.ok, false, 'ambiguous semantic assertion fails safely');
    const beforeInvalidTargets = directTargets.length;
    for (const invalidArgs of [
      {},
      { selector: { by: 'role' } },
      { selector: { by: 'role', role: 'button', extra: true } },
      { selector: { by: 'role', role: 'x'.repeat(101) } },
      { selector: { by: 'role', role: 'button', name: 'x'.repeat(301) } },
      { selector: { by: 'test_id', value: '' } },
      { selector: { by: 'test_id', value: 'x'.repeat(1001) } },
      { selector: { by: 'test_id', value: 'id', role: 'button' } },
      { selector: { by: 'placeholder', value: '' } },
      { selector: { by: 'placeholder', value: 'x'.repeat(1001) } },
      { selector: { by: 'placeholder', value: 'Search', extra: true } },
      { selector: { by: 'placeholder', value: 'Search', role: 'textbox' } },
      { selector: { by: 'label' } },
      { selector: { by: 'label', value: '' } },
      { selector: { by: 'label', value: 'x'.repeat(1001) } },
      { selector: { by: 'label', value: 'Search', extra: true } },
      { selector: { by: 'label', value: 'Search', role: 'textbox' } },
      { selector: '' },
      { selector: 'x'.repeat(2001) },
    ]) {
      const invalidTarget = await call('desktop_click', invalidArgs);
      assert.equal(invalidTarget.structuredContent.error.code, 'invalid_input');
    }
    assert.equal(directTargets.length, beforeInvalidTargets, 'invalid or ambiguous target shapes do not reach desktop services');
    const successfulUpload = await call('desktop_upload', { selector: '#file', project_relative_path: 'fixtures/upload.txt' });
    assert.equal(successfulUpload.structuredContent.ok, true);
    assert.deepEqual(successfulUpload.structuredContent.data, { basename: 'upload.txt', byteLength: 12 });
    assert.deepEqual(uploads[2], { selector: '#file', projectRelativePath: 'fixtures/upload.txt' });
    const semanticUpload = await call('desktop_upload', { selector: testIdTarget, project_relative_path: 'fixtures/upload.txt' });
    assert.equal(semanticUpload.structuredContent.ok, true);
    assert.deepEqual(uploads[3], { selector: testIdTarget, projectRelativePath: 'fixtures/upload.txt' });
    assert.equal(JSON.stringify(successfulUpload).includes(root), false, 'MCP result does not disclose the absolute upload path');
    const invalidUpload = await call('desktop_upload', { selector: '#file', path: 'fixtures/upload.txt' });
    assert.equal(invalidUpload.structuredContent.ok, false);
    assert.equal(invalidUpload.structuredContent.error.code, 'invalid_input');
    assert.equal(uploads.length, 4, 'invalid schema input cannot call the upload method');
    const factoryBeforeDisabled = factoryCalls;
    config.desktop!.enabled = false;
    const disabledUpload = await call('desktop_upload', { selector: '#file', project_relative_path: 'fixtures/upload.txt' });
    config.desktop!.enabled = true;
    assert.equal(disabledUpload.structuredContent.error.code, 'desktop_disabled');
    assert.equal(factoryCalls, factoryBeforeDisabled, 'disabled desktop upload does not construct or start a service');
    assert.equal(uploads.length, 4);
    for (const action of ['upload', 'any'] as const) {
      config.security = { high_risk: [{ action, target: { by: 'test_id', value: 'fixture' }, description: 'High-risk fixture' }] } as any;
      const deniedUpload = await call('desktop_upload', { selector: '#file', project_relative_path: 'fixtures/upload.txt' });
      assert.equal(deniedUpload.structuredContent.error.code, 'approval_denied');
      assert.equal(uploads.length, 4, `${action} rule denies before upload side effects`);
    }
    config.security = undefined;
    const mismatchCount = countRuns('portable');
    const mismatch = await call('desktop_run_workflow', { workflow_id: 'portable', expected_session_id: 'not-this-session' });
    assert.equal(mismatch.structuredContent.ok, false); assert.equal(countRuns('portable'), mismatchCount); assert.equal(startCalls, 2);

    const invalid = await call('desktop_run_workflow', { workflow_id: 'portable' });
    assert.equal(invalid.structuredContent.ok, false); assert.equal(invalid.structuredContent.error.code, 'invalid_input');
    assert.equal('state_revision' in invalid.structuredContent, false); assert.equal(encoded(invalid).includes('state_revision'), false);
    const success = await call('desktop_run_workflow', { workflow_id: 'portable', expected_session_id: 'owned-desktop-session', role: 'operator', environment: 'staging' });
    assert.equal(success.structuredContent.ok, true, JSON.stringify(success));
    assert.equal(success.structuredContent.data.status, 'passed', JSON.stringify(success));
    assert.equal('state_revision' in success.structuredContent, false); assert.equal(encoded(success).includes('state_revision'), false);
    assert.deepEqual(actions.slice(-4), ['click:#button', 'type:#input:hello', 'scroll', 'wait']);
    const successRun = workflowRun('portable')!;
    assert.equal((store.getRunReport(successRun) as any).run.backend, 'tauri');
    assert.equal(store.workflowExportEligibility('portable', successRun), null);
    assert.equal(store.verifyWorkflowExport('portable', successRun), false);
    assert.equal(store.hasWorkflowExportVerification('portable'), false);

    for (const workflowId of ['late-unsupported', 'unsupported-route', 'unsupported-capture', 'unsupported-target', 'unsupported-placeholder-target', 'unsupported-label-target', 'unsupported-condition']) {
      const beforeRuns = countRuns(workflowId), beforeActions = actions.length, beforeTargets = directTargets.length;
      const rejected = await call('desktop_run_workflow', { workflow_id: workflowId, expected_session_id: 'owned-desktop-session' });
      assert.equal(rejected.structuredContent.data.errorCode, 'precondition_failed', workflowId);
      assert.equal(countRuns(workflowId), beforeRuns, `${workflowId} is rejected before run creation`);
      assert.equal(actions.length, beforeActions, `${workflowId} is rejected before action effects`);
      assert.equal(directTargets.length, beforeTargets, `${workflowId} is rejected before desktop service calls`);
      assert.equal('state_revision' in rejected.structuredContent, false);
    }

    for (const [workflowId, action] of [['risky-click', 'click'], ['risky-any', 'any']] as const) {
      config.security = { high_risk: [{ action, target: { by: 'test_id', value: 'fixture' }, description: 'High-risk fixture' }] } as any;
      const beforeRuns = countRuns(workflowId), beforeActions = actions.length;
      const denied = await call('desktop_run_workflow', { workflow_id: workflowId, expected_session_id: 'owned-desktop-session' });
      assert.equal(denied.structuredContent.data.errorCode, 'approval_denied');
      assert.equal(countRuns(workflowId), beforeRuns); assert.equal(actions.length, beforeActions);
      assert.doesNotMatch(encoded(denied), /sensitive-payload|PRIVATE_ACTION_SENTINEL/);
    }
    config.security = undefined;

    const capturesBeforeAuth = captureCalls;
    const auth = await call('desktop_run_workflow', { workflow_id: 'auth-safe', expected_session_id: 'owned-desktop-session' });
    assert.equal(auth.structuredContent.data.status, 'passed');
    assert.deepEqual(Object.keys(auth.structuredContent.data).sort(), ['run_id', 'status']);
    assert.equal(captureCalls, capturesBeforeAuth); assert.doesNotMatch(encoded(auth), new RegExp(secret));
    const authRun = workflowRun('auth-safe')!;
    assert.deepEqual(JSON.parse((store.db.prepare('SELECT environment_json FROM runs WHERE id=?').get(authRun) as any).environment_json), { backend: 'tauri' });
    assert.doesNotMatch(JSON.stringify(store.getRunReport(authRun)), new RegExp(secret));

    failClick = true;
    const capturesBeforeRuntimeFailure = captureCalls;
    const failed = await call('desktop_run_workflow', { workflow_id: 'runtime-failure', expected_session_id: 'owned-desktop-session' });
    failClick = false;
    assert.equal(failed.structuredContent.data.errorCode, 'action_failed');
    assert.equal(captureCalls, capturesBeforeRuntimeFailure + 1, 'desktop failure capture executes directly inside the held queue');
    assert.equal(failed.structuredContent.data.capture.desktop_screenshot_status, 'captured');
    const failureRun = failed.structuredContent.data.run_id;
    assert.ok((store.getRunReport(failureRun).evidence as any[]).some(item => item.kind === 'workflow_desktop_screenshot' && item.artifact_ref === failed.structuredContent.data.capture.desktop_screenshot));
    assert.equal('state_revision' in failed.structuredContent, false); assert.equal(encoded(failed).includes('state_revision'), false);
    assert.doesNotMatch(encoded(failed), /PRIVATE_ACTION_SENTINEL/);
    const browserResult = await call('test_run_workflow', { workflow_id: 'missing-browser-workflow', expected_revision: 7 });
    assert.equal(browserResult.structuredContent.state_revision, 7);

    shouldBlock = true;
    const blocked = call('desktop_run_workflow', { workflow_id: 'blocked', expected_session_id: 'owned-desktop-session' });
    await operationGate.entered.promise;
    const competing = call('desktop_click', { selector: '#competing' });
    await delay(40);
    assert.equal(actions.includes('click:#competing'), false, 'desktop calls cannot interleave while the workflow holds the queue');
    shouldBlock = false;
    operationGate.release.resolve();
    const [, competingResult] = await Promise.all([blocked, competing]);
    assert.equal(competingResult.structuredContent.ok, true);
    assert.ok(actions.indexOf('click:#competing') > actions.indexOf('click:#blocked'));

    operationGate = { entered: deferred(), release: deferred() };
    shouldBlock = true;
    const closeRun = call('desktop_run_workflow', { workflow_id: 'blocked', expected_session_id: 'owned-desktop-session' });
    void closeRun.catch(() => undefined);
    await operationGate.entered.promise;
    const stopsBeforeClose = stopCalls;
    assert.ok(sessionId, 'initialized HTTP transport exposes the MCP session id');
    const closeSession = fetch(`http://127.0.0.1:${port}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sessionId!, accept: 'application/json, text/event-stream' } }).then(async response => ({ status: response.status, text: await response.text() })).catch(error => ({ error: String(error) }));
    await delay(25); // let the DELETE enter the server before shutdown closes the listener
    const closeTransport = transport!.close().catch(() => undefined);
    const shutdown = serverStop!();
    await delay(40);
    assert.equal(stopCalls, stopsBeforeClose, 'cleanup waits for the blocked workflow queue section');
    shouldBlock = false;
    operationGate.release.resolve();
    const closeResults = await Promise.allSettled([closeRun, closeTransport, closeSession, shutdown]);
    assert.equal(stopCalls, stopsBeforeClose + 1, 'duplicate close/shutdown cleanup stops once, after work');
    const blockedNode = store.currentYamlWorkflow('blocked')!;
    const statuses = store.db.prepare('SELECT status FROM runs WHERE workflow_id=? ORDER BY started_at').all(blockedNode.id) as Array<{ status: string }>;
    assert.ok(statuses.some(row => row.status === 'interrupted'), JSON.stringify({ statuses, closeResults }));
    assert.equal(factoryCalls, 1, 'workflow never invokes the factory after the service was explicitly created');
  } finally {
    delete process.env[secretEnv];
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    await serverStop?.().catch(() => undefined);
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
