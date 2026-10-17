import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/memory/store.js';
import { reconcile } from '../src/knowledge/reconcile.js';
import { createLearningWriter } from '../src/memory/runtime.js';
import type { Config } from '../src/config/config.js';
import { testLearningWriter } from './helpers/learning.js';

test('LearningWriter redacts content before sending it to analyze', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'learning-redact-'));
  let store: Store | undefined;
  try {
    store = new Store(path.join(dir, 'memory.sqlite'), 'p');
    const analyzed: string[] = [];
    const writer = testLearningWriter(store, { sensitivePaths: ['/attributes/private'], inputs: analyzed });
    await writer.propose({ type: 'note', stable_key: 'safe-id', display_name: 'Safe name', attributes: { private: 'SENTINEL_VALUE', note: 'ordinary' } });
    assert.equal(analyzed.length, 1);
    assert.equal(analyzed[0]!.includes('SENTINEL_VALUE'), false);
    assert.equal(analyzed[0]!.includes('[REDACTED]'), true);
    const persisted = JSON.stringify(store.getByTypeKey('note', 'safe-id'));
    assert.equal(persisted.includes('SENTINEL_VALUE'), false);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('LearningWriter rejects redaction that changes identity before analyze or graph writes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'learning-identity-'));
  let store: Store | undefined;
  try {
    store = new Store(path.join(dir, 'memory.sqlite'), 'p');
    const analyzed: string[] = [];
    const writer = testLearningWriter(store, { sensitivePaths: ['/stable_key'], inputs: analyzed });
    await assert.rejects(() => writer.propose({ type: 'note', stable_key: 'IDENTITY_SECRET', display_name: 'Safe' }));
    assert.deepEqual(analyzed, []);
    assert.equal(store.getByTypeKey('note', 'IDENTITY_SECRET'), null);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('failed sidecar analysis leaves YAML graph and ownership unchanged', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'learning-atomic-'));
  const root = path.join(dir, 'knowledge');
  let store: Store | undefined;
  try {
    await mkdir(root);
    store = new Store(path.join(dir, 'memory.sqlite'), 'p');
    const state: { failAnalyze?: boolean } = {};
    const writer = testLearningWriter(store, state);
    const source = path.join(root, 'home.yaml');
    await writeFile(source, 'schema_version: 1\nkind: screen\nid: home\nname: Home\n');
    await reconcile(root, store, writer);
    const beforeNodes = store.db.prepare("SELECT id,type,stable_key,attributes_json,tombstone FROM nodes WHERE project_id='p' ORDER BY id").all();
    const beforeEdges = store.db.prepare("SELECT id,stable_key,tombstone FROM edges WHERE project_id='p' ORDER BY id").all();
    const beforeOwners = store.db.prepare("SELECT * FROM yaml_ownership WHERE project_id='p' ORDER BY source_path,entity_key").all();
    await writeFile(source, 'schema_version: 1\nkind: screen\nid: home\nname: Changed\n');
    state.failAnalyze = true;
    await assert.rejects(() => reconcile(root, store!, writer));
    assert.deepEqual(store.db.prepare("SELECT id,type,stable_key,attributes_json,tombstone FROM nodes WHERE project_id='p' ORDER BY id").all(), beforeNodes);
    assert.deepEqual(store.db.prepare("SELECT id,stable_key,tombstone FROM edges WHERE project_id='p' ORDER BY id").all(), beforeEdges);
    assert.deepEqual(store.db.prepare("SELECT * FROM yaml_ownership WHERE project_id='p' ORDER BY source_path,entity_key").all(), beforeOwners);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('failure while preparing a later YAML document commits none of the batch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'learning-batch-'));
  const root = path.join(dir, 'knowledge');
  let store: Store | undefined;
  try {
    await mkdir(root);
    store = new Store(path.join(dir, 'memory.sqlite'), 'p');
    const state: { failAtAnalysis?: number } = {};
    const writer = testLearningWriter(store, state);
    const first = path.join(root, 'a.yaml');
    const second = path.join(root, 'b.yaml');
    await writeFile(first, 'schema_version: 1\nkind: screen\nid: alpha\nname: Alpha\n');
    await writeFile(second, 'schema_version: 1\nkind: screen\nid: beta\nname: Beta\n');
    await reconcile(root, store, writer);
    const beforeNodes = store.db.prepare("SELECT id,type,stable_key,attributes_json,tombstone FROM nodes WHERE project_id='p' ORDER BY id").all();
    const beforeSources = store.db.prepare("SELECT * FROM yaml_sources WHERE project_id='p' ORDER BY path").all();
    const beforeOwners = store.db.prepare("SELECT * FROM yaml_ownership WHERE project_id='p' ORDER BY source_path,entity_key").all();

    await writeFile(first, 'schema_version: 1\nkind: screen\nid: alpha\nname: Alpha changed\n');
    await writeFile(second, 'schema_version: 1\nkind: screen\nid: beta\nname: Beta changed\n');
    state.failAtAnalysis = 4; // a.yaml succeeds; b.yaml fails before the transaction starts
    await assert.rejects(() => reconcile(root, store!, writer));

    assert.deepEqual(store.db.prepare("SELECT id,type,stable_key,attributes_json,tombstone FROM nodes WHERE project_id='p' ORDER BY id").all(), beforeNodes);
    assert.deepEqual(store.db.prepare("SELECT * FROM yaml_sources WHERE project_id='p' ORDER BY path").all(), beforeSources);
    assert.deepEqual(store.db.prepare("SELECT * FROM yaml_ownership WHERE project_id='p' ORDER BY source_path,entity_key").all(), beforeOwners);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('unready NLP fails closed while operational assertion writes remain available', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'learning-operational-'));
  let store: Store | undefined;
  try {
    store = new Store(path.join(dir, 'memory.sqlite'), 'p');
    const writer = testLearningWriter(store, { ready: false });
    await assert.rejects(() => writer.propose({ type: 'note', stable_key: 'blocked', display_name: 'Blocked' }));
    assert.equal(store.getByTypeKey('note', 'blocked'), null);
    const application = store.applicationSubject()!;
    const assertion = store.recordAssertion({ session_id: 'test-session', subject_node_id: application.id, passed: true, observed_count: 1, actions: [] });
    assert.equal((store.getRunReport(assertion.id) as any).run.status, 'passed');
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('production runtime keeps persistent learning writes disabled before Phase 1C', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'learning-release-gate-'));
  let store: Store | undefined;
  let healthCalls = 0;
  let analyzeCalls = 0;
  try {
    store = new Store(path.join(dir, 'memory.sqlite'), 'p');
    const config = { memory: { database: path.join(dir, 'memory.sqlite'), sensitive_paths: [], sensitive_values_env: [] } } as Config;
    const writer = createLearningWriter(store, config, { nlp: {
      async health() { healthCalls += 1; return { version: 1, id: 'health', ok: true, op: 'health', health: { protocol: 1, python: 'test', spacy: 'fake', model: 'fake', rules: '1', ready: true } }; },
      async analyze() { analyzeCalls += 1; throw new Error('must not be reached'); },
    } });
    await assert.rejects(() => writer.propose({ type: 'note', stable_key: 'release-gated', display_name: 'Blocked' }));
    assert.equal(healthCalls, 0);
    assert.equal(analyzeCalls, 0);
    assert.equal(store.getByTypeKey('note', 'release-gated'), null);
    await writer.close();
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});
