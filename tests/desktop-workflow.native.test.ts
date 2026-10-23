import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopService } from '../src/desktop/index.js';
import { Store } from '../src/memory/store.js';
import { reconcile } from '../src/knowledge/reconcile.js';
import { createDesktopWorkflowDriver } from '../src/workflow/desktop-driver.js';
import { runWorkflowWithDriver } from '../src/workflow/runner.js';
import { testWriter } from './helpers/learning.js';

const enabled = process.env.npm_lifecycle_event === 'test:desktop-native' || process.env.UMB_RUN_TAURI_NATIVE === '1';
const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/tauri-app');

function commandPath(name: string): string | undefined {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
}

test('stored YAML workflow runs against the real Tauri counter fixture', { skip: !enabled, timeout: 180_000 }, async () => {
  if (process.platform !== 'linux') throw Error('This direct tauri-driver acceptance fixture currently supports Linux only.');
  const driverExecutable = commandPath('tauri-driver');
  if (!driverExecutable) throw Error('Install tauri-driver and ensure it is on PATH before running the native acceptance test.');

  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-tauri-workflow-'));
  const knowledge = path.join(root, 'knowledge');
  let store: Store | undefined;
  let service: DesktopService | undefined;

  try {
    await mkdir(knowledge);
    store = new Store(path.join(root, 'memory.sqlite'), `tauri-workflow-${process.pid}`);
    service = new DesktopService({
      projectRoot: root,
      tauriBinary: path.join(fixtureRoot, 'src-tauri', 'target', 'debug', 'tauri-acceptance-fixture'),
      driverExecutable,
      readinessTimeoutMs: 60_000,
      artifactDirectory: 'artifacts',
    });
    await writeFile(path.join(knowledge, 'counter.yaml'), `schema_version: 1
kind: workflow
id: native-counter
name: Native counter workflow
steps:
  - id: increment
    action: click
    target: {by: css, value: 'button[aria-label="Increment counter"]'}
  - id: scroll
    action: scroll
    direction: down
    amount: 25
  - id: wait-count
    action: wait
    condition: visible
    target: {by: css, value: '#count'}
    timeout_ms: 5000
  - id: assert-count
    action: assert
    condition: text
    target: {by: css, value: '#count'}
    expected: '1'
    match: exact
`);
    await reconcile(knowledge, store, testWriter(store));

    // Native session ownership is explicit; the driver itself never starts the service.
    await service.start();
    const session = await service.status();
    const result = await runWorkflowWithDriver({
      store,
      session: { id: session.id, closed: false },
      workflowId: 'native-counter',
      backend: 'tauri',
    }, createDesktopWorkflowDriver({ service }));

    assert.equal(result.status, 'passed', JSON.stringify(result));
    const runId = (result as any).run_id as string;
    const report = store.getRunReport(runId) as any;
    assert.equal(report.run.backend, 'tauri');
    assert.deepEqual(report.stepAttempts.map((attempt: any) => attempt.stepId), ['__preflight__', 'increment', 'scroll', 'wait-count', 'assert-count']);
    assert.deepEqual(report.stepAttempts.map((attempt: any) => attempt.action), ['assert', 'click', 'scroll', 'wait', 'assert']);
    assert.ok(report.stepAttempts.every((attempt: any) => attempt.status === 'passed'));
  } finally {
    try { await service?.stop(); } catch { /* cleanup is best-effort if startup failed */ }
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
