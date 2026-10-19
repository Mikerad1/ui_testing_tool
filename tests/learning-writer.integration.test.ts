import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/memory/store.js';
import { reconcile } from '../src/knowledge/reconcile.js';
import { createLearningWriter, persistentLearningWritesEnabled } from '../src/memory/runtime.js';
import type { Config } from '../src/config/config.js';
import { testLearningWriter } from './helpers/learning.js';

test('LearningWriter redacts content before sending it to analyze', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'learning-redact-'));
  let store: Store | undefined;
  try {
    store = new Store(path.join(dir, 'memory.sqlite'), 'p');
    const analyzed: string[] = [];
    const writer = testLearningWriter(store, { sensitivePaths: ['/attributes/private'], inputs: analyzed });
    await writer.propose({ observation_id:'redact-safe',type: 'screen', stable_key: 'safe-id', display_name: 'Safe name', attributes: { private: 'SENTINEL_VALUE', note: 'ordinary' } });
    assert.equal(analyzed.length, 1);
    assert.equal(analyzed[0]!.includes('SENTINEL_VALUE'), false);
    assert.equal(analyzed[0]!.includes('[REDACTED]'), true);
    const persisted = JSON.stringify(store.getByTypeKey('screen', 'safe-id'));
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
    await assert.rejects(() => writer.propose({ observation_id:'identity-blocked',type: 'screen', stable_key: 'IDENTITY_SECRET', display_name: 'Safe' }));
    assert.deepEqual(analyzed, []);
    assert.equal(store.getByTypeKey('screen', 'IDENTITY_SECRET'), null);
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
    const beforeObservations=store.listCandidateObservations({source_kind:'yaml_document'});
    await writeFile(source, 'schema_version: 1\nkind: screen\nid: home\nname: Changed\n');
    state.failAnalyze = true;
    await assert.rejects(() => reconcile(root, store!, writer));
    assert.deepEqual(store.db.prepare("SELECT id,type,stable_key,attributes_json,tombstone FROM nodes WHERE project_id='p' ORDER BY id").all(), beforeNodes);
    assert.deepEqual(store.db.prepare("SELECT id,stable_key,tombstone FROM edges WHERE project_id='p' ORDER BY id").all(), beforeEdges);
    assert.deepEqual(store.db.prepare("SELECT * FROM yaml_ownership WHERE project_id='p' ORDER BY source_path,entity_key").all(), beforeOwners);
    assert.deepEqual(store.listCandidateObservations({source_kind:'yaml_document'}),beforeObservations);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('YAML candidate observations preserve redacted mentions, are idempotent, and version with rulesets',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'learning-yaml-observation-')),root=path.join(dir,'knowledge');let store:Store|undefined;
  try{
    await mkdir(root);store=new Store(path.join(dir,'memory.sqlite'),'p');
    const source=path.join(root,'home.yaml'),analyzed:string[]=[];
    await writeFile(source,'schema_version: 1\nkind: screen\nid: home\nname: Home\nelements:\n  - id: title\n    description: SENTINEL_PRIVATE\n    locator: {by: text, value: Home}\nactions:\n  - id: open\n    element: title\n');
    const firstWriter=testLearningWriter(store,{inputs:analyzed,candidateMentions:true,sensitivePaths:['/elements/0/description']});
    await reconcile(root,store,firstWriter);
    const first=store.listCandidateObservations({source_kind:'yaml_document'});
    assert.equal(first.length,1);assert.equal(first[0]!.source_key,'screen:home');assert.equal(first[0]!.status,'proposed');
    assert.match(first[0]!.source_revision_hash,/^[a-f0-9]{64}$/,'the observation records a redacted-source revision fingerprint');
    assert.equal(first[0]!.extraction_ready,true);assert.deepEqual(first[0]!.links,[]);
    const mention=(first[0]!.entities as any[])[0]!;
    assert.equal(mention.text,'Home');assert.equal(Array.from(first[0]!.redacted_source_text!).slice(mention.start,mention.end).join(''),'Home');
    const candidates=first[0]!.entities as any[],relations=first[0]!.relations as any[];
    assert.equal(relations.length,1);assert.equal(relations[0].from_candidate_id,candidates[0].id);assert.equal(relations[0].to_candidate_id,candidates[1].id);
    assert.equal(Array.from(first[0]!.redacted_source_text!).slice(relations[0].evidence.start,relations[0].evidence.end).join(''),relations[0].evidence.text);
    assert.equal(JSON.stringify(first[0]).includes('SENTINEL_PRIVATE'),false);assert.equal(analyzed[0]!.includes('SENTINEL_PRIVATE'),false);
    const firstPreparation=(store.db.prepare('SELECT preparation_key FROM yaml_record_fingerprints').get() as any).preparation_key;
    await reconcile(root,store,firstWriter);
    assert.equal(store.listCandidateObservations({source_kind:'yaml_document'}).length,1);assert.equal(analyzed.length,1,'an exact profile and provenance cache hit skips NLP');
    const changedRulesWriter=testLearningWriter(store,{inputs:analyzed,candidateMentions:true,patternsDigest:'c'.repeat(64),sensitivePaths:['/elements/0/description']});
    await reconcile(root,store,changedRulesWriter);
    const observations=store.listCandidateObservations({source_kind:'yaml_document'});
    assert.equal(observations.length,2);assert.notEqual(observations[0]!.pipeline_fingerprint,observations[1]!.pipeline_fingerprint);
    assert.equal(observations[0]!.source_key,observations[1]!.source_key,'profile changes add provenance under the same document identity');
    assert.notEqual((store.db.prepare('SELECT preparation_key FROM yaml_record_fingerprints').get() as any).preparation_key,firstPreparation);
    assert.equal(analyzed.length,2,'a changed NLP profile requires fresh analysis');
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('YAML empty rules persist normalized-only evidence and reconciliation rollback removes observations',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'learning-yaml-rollback-')),root=path.join(dir,'knowledge');let store:Store|undefined;
  try{
    await mkdir(root);const filename=path.join(dir,'memory.sqlite');store=new Store(filename,'p');
    await writeFile(path.join(root,'empty.yaml'),'schema_version: 1\nkind: screen\nid: empty\nname: Empty\n');
    await reconcile(root,store,testLearningWriter(store,{emptyPatterns:true,candidateMentions:true}));
    const empty=store.listCandidateObservations({source_kind:'yaml_document'})[0]!;
    assert.equal(empty.extraction_ready,false);assert.deepEqual(empty.entities,[]);assert.deepEqual(empty.relations,[]);assert.equal(empty.status,'proposed');
    const beforeNodes=(store.db.prepare('SELECT count(*) count FROM nodes WHERE origin=\'yaml\'').get() as any).count;
    const native=new Database(filename);native.exec("CREATE TRIGGER fail_yaml_source BEFORE INSERT ON yaml_sources WHEN NEW.path='rollback.yaml' BEGIN SELECT RAISE(ABORT,'forced yaml commit failure'); END");native.close();
    await writeFile(path.join(root,'rollback.yaml'),'schema_version: 1\nkind: screen\nid: rollback\nname: Rollback\n');
    await assert.rejects(()=>reconcile(root,store!,testLearningWriter(store!)));
    assert.equal(store.listCandidateObservations({source_kind:'yaml_document'}).length,1);
    assert.equal((store.db.prepare('SELECT count(*) count FROM nodes WHERE origin=\'yaml\'').get() as any).count,beforeNodes);
    assert.equal(store.db.prepare("SELECT 1 FROM memory_candidate_observations WHERE source_key='screen:rollback'").get(),undefined);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
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
    await assert.rejects(() => writer.propose({ observation_id:'not-ready',type: 'screen', stable_key: 'blocked', display_name: 'Blocked' }));
    assert.equal(store.getByTypeKey('screen', 'blocked'), null);
    const application = store.applicationSubject()!;
    const assertion = store.recordAssertion({ session_id: 'test-session', subject_node_id: application.id, passed: true, observed_count: 1, actions: [] });
    assert.equal((store.getRunReport(assertion.id) as any).run.status, 'passed');
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('production runtime keeps persistent learning disabled until the FR-07 gate passes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'learning-runtime-'));
  let store: Store | undefined;
  let healthCalls = 0;
  let analyzeCalls = 0;
  try {
    store = new Store(path.join(dir, 'memory.sqlite'), 'p');
    const config = { memory: { database: path.join(dir, 'memory.sqlite'), sensitive_paths: ['/attributes/private'], sensitive_values_env: [] } } as Config;
    assert.equal(persistentLearningWritesEnabled(), false);
    const writer = createLearningWriter(store, config, { env: {}, nlp: {
      async health() { healthCalls += 1; return { version: 3, id: 'health', ok: true, op: 'health', health: { protocol: 3, python: 'test', spacy: 'fake', model: 'fake', model_version: '1.0.0', rules: '1', patterns_schema_version: 1, patterns_digest: 'b'.repeat(64), pattern_count: 1, patterns_ready: true, ready: true } }; },
      async analyze() { analyzeCalls += 1; return { version: 3, id: 'analyze', ok: true, op: 'analyze', normalized: 'safe normalized', tokens: [], entities: [], relations: [] }; },
    } });
    await assert.rejects(() => writer.propose({ observation_id:'runtime-proposal',type: 'screen', stable_key: 'runtime-proposal', display_name: 'Safe', attributes: { private: 'RUNTIME_SECRET' } }));
    assert.equal(healthCalls, 0, 'the disabled runtime rejects before consulting injected NLP');
    assert.equal(analyzeCalls, 0);
    assert.equal(store.getByTypeKey('screen', 'runtime-proposal'), null);
    assert.equal(store.listCandidateObservations({ source_kind: 'mcp_node' }).length, 0);
    await writer.close();
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});
