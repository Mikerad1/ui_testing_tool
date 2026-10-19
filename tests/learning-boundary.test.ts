import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { Store } from '../src/memory/store.js';
import { storeLearningCommit } from '../src/memory/store-internal.js';
import { withNlpMetadata } from '../src/memory/learning-types.js';
import { LearningWriter } from '../src/memory/learning-writer.js';
import { createMemoryRedactor } from '../src/memory/redactor.js';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : /\.ts$/.test(entry.name) ? [filename] : [];
  }));
  return files.flat();
}

test('production learning graph writes stay behind Store and LearningWriter', async () => {
  const files = await sourceFiles(sourceRoot);
  const sqlMutation = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+["'`]?\s*(?:main\s*\.\s*)?["'`]?(?:nodes|edges)\b/i;
  const directCommit = /(?:\bstore|\.store)\.commit(?:ProposedNode|PreparedEdge|Reconciliation)\s*\(/;
  const directWriter = /\bnew\s+LearningWriter\s*\(/;
  const internalCapability = /from\s+['"][^'"]*store-internal\.js['"]/;
  const metadataMinterImport = /import\s*\{[^}]*\bwithNlpMetadata\b[^}]*\}\s*from/;
  const metadataMinterCall = /\bwithNlpMetadata\s*\(/;
  const metadataMintingFiles = new Set(['memory/learning-writer.ts', 'knowledge/reconcile.ts']);
  const storeMutationFiles = new Set(['memory/store.ts', 'memory/schema-v11.ts', 'memory/schema-v15.ts', 'memory/schema-v16.ts', 'memory/yaml-commit.ts']);

  for (const filename of files) {
    const relative = path.relative(sourceRoot, filename).split(path.sep).join('/');
    const source = await readFile(filename, 'utf8');
    if (!storeMutationFiles.has(relative)) assert.doesNotMatch(source, sqlMutation, `${relative} must not mutate graph tables directly outside the Store/migration boundary`);
    if (relative !== 'memory/store.ts' && relative !== 'memory/learning-writer.ts') {
      assert.doesNotMatch(source, directCommit, `${relative} must use LearningWriter rather than Store commit internals`);
    }
    if (relative !== 'memory/runtime.ts') assert.doesNotMatch(source, directWriter, `${relative} must use the runtime release gate`);
    if (relative !== 'memory/store.ts' && relative !== 'memory/learning-writer.ts') {
      assert.doesNotMatch(source, internalCapability, `${relative} must not access Store's internal commit capability`);
    }
    if (relative !== 'memory/learning-writer.ts' && relative !== 'knowledge/reconcile.ts') {
      assert.doesNotMatch(source, metadataMinterImport, `${relative} must not import the NLP metadata minting capability`);
    }
    if (relative !== 'memory/learning-types.ts' && !metadataMintingFiles.has(relative)) {
      assert.doesNotMatch(source, metadataMinterCall, `${relative} must not mint NLP metadata`);
    }
  }
});

test('Store internal commits require branded NLP attributes before any reconciliation writes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'learning-store-brand-'));
  const store = new Store(path.join(directory, 'memory.sqlite'), 'p');
  const forged = { __umb_memory_nlp: { protocol: 1, normalized: 'valid-looking' } };
  const branded = withNlpMetadata({ name: 'approved' }, 'normalized');
  const readRows = (table: string) => store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
  try {
    assert.throws(() => storeLearningCommit.proposedNode(store, {
      type: 'screen', stable_key: 'forged', display_name: 'Forged', attributes: forged,
    }), /NLP ingestion is required/);
    assert.throws(() => storeLearningCommit.preparedEdge(store, {
      from_id: 'missing-from', to_id: 'missing-to', relation: 'forged', attributes: forged,
    }), /NLP ingestion is required/);

    const before = {
      nodes: readRows('nodes'), edges: readRows('edges'), yamlSources: readRows('yaml_sources'), yamlOwnership: readRows('yaml_ownership'),
    };
    const plan = {
      sources: [{ path: 'forged.yaml', hash: 'a'.repeat(64) }],
      entities: [
        { type: 'screen', key: 'valid', name: 'Valid', attrs: branded, hash: 'b'.repeat(64), source: 'forged.yaml' },
        { type: 'screen', key: 'forged', name: 'Forged', attrs: forged, hash: 'c'.repeat(64), source: 'forged.yaml' },
      ],
      edges: [],
    } as any;
    assert.throws(() => storeLearningCommit.reconciliation(store, plan), /NLP ingestion is required/);
    assert.deepEqual({
      nodes: readRows('nodes'), edges: readRows('edges'), yamlSources: readRows('yaml_sources'), yamlOwnership: readRows('yaml_ownership'),
    }, before, 'all entries are preflighted before any reconciliation transaction writes');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('analysis-only LearningWriter cannot invoke any persistent mutation with a real Store',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'learning-analysis-only-')),store=new Store(path.join(directory,'memory.sqlite'),'analysis-only');
  try{
    const writer=new LearningWriter(store,undefined,createMemoryRedactor({sensitive_paths:[],sensitive_values_env:[]},{}),false,true);
    const tables=['nodes','edges','yaml_sources','memory_backfill_jobs','memory_backfill_items','memory_candidate_observations','memory_lifecycle_events'];
    const state=()=>Object.fromEntries(tables.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
    const before=state();
    await assert.rejects(()=>writer.propose({observation_id:'preview',type:'screen',stable_key:'screen',display_name:'Screen'}),/NLP/);
    await assert.rejects(()=>writer.addEdge({observation_id:'preview-edge',from_id:'a',to_id:'b',relation:'HAS_ACTION'}),/NLP/);
    await assert.rejects(()=>writer.verify('missing','run',{approved:true,source:'local_approver'}),/NLP/);
    await assert.rejects(()=>writer.supersede('old','new'),/NLP/);
    await assert.rejects(()=>writer.commitReconciliation({sources:[],entities:[],edges:[]} as any),/NLP/);
    await assert.rejects(()=>writer.reprocessBackfillNode('job',{id:'node',type:'note',stable_key:'node',display_name:'Node',attributes:{},payloadHash:'a'.repeat(64),redactedHash:''}),/NLP/);
    await assert.rejects(()=>writer.reprocessBackfillEdge('job',{id:'edge',from_id:'a',to_id:'b',relation:'MENTIONS',attributes:{},payloadHash:'a'.repeat(64),redactedHash:''}),/NLP/);
    assert.deepEqual(state(),before);
    await writer.close();
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('public Store database rejects DML and hides internal commit methods', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'learning-store-boundary-'));
  const store = new Store(path.join(directory, 'memory.sqlite'), 'p');
  try {
    assert.equal(Reflect.set(store, 'projectId', 'other'), false, 'project identity cannot be reassigned');
    assert.throws(() => Object.defineProperty(store, 'projectId', { value: 'other' }), /Cannot redefine property/);
    assert.equal(store.projectId, 'p', 'rejected replacement preserves the Store project identity');
    const databaseView = store.db;
    assert.equal(Reflect.set(store, 'db', {}), false, 'the public database reference cannot be reassigned');
    assert.throws(() => Object.defineProperty(store, 'db', { value: databaseView }), /Cannot redefine property/);
    assert.equal(store.db, databaseView, 'rejected replacement leaves the protected view in place');
    assert.equal(Reflect.getPrototypeOf(databaseView), null, 'database view has no Database prototype to escape through');
    assert.equal(Reflect.setPrototypeOf(databaseView, {}), false);
    assert.equal(Reflect.set(databaseView, 'prepare', () => ({})), false);
    assert.equal(Reflect.defineProperty(databaseView, 'raw', { value: {} }), false);
    assert.equal(Reflect.deleteProperty(databaseView, 'prepare'), false);
    assert.deepEqual(Reflect.ownKeys(databaseView).sort(), ['pragma', 'prepare']);
    assert.equal(databaseView.prepare('SELECT 1 AS value').get().value, 1, 'supported read-only queries remain available');
    const originalUserVersion = databaseView.pragma('user_version');
    assert.throws(() => databaseView.pragma('user_version(123)'), /read-only/);
    assert.deepEqual(databaseView.pragma('user_version'), originalUserVersion, 'setter syntax cannot mutate PRAGMA state');
    for (const sql of [
      "INSERT INTO nodes(id) VALUES('forged')",
      "UPDATE nodes SET display_name='forged'",
      "DELETE FROM edges",
      "WITH candidate AS (SELECT 1) UPDATE nodes SET display_name='forged'",
      "CREATE TRIGGER forged AFTER INSERT ON evidence BEGIN INSERT INTO nodes(id) VALUES('forged'); END",
      "UPDATE runs SET status='forged'",
      "INSERT INTO evidence(id) VALUES('forged')",
      "WITH candidate AS (SELECT 1) UPDATE runs SET status='forged'",
    ]) assert.throws(() => store.db.prepare(sql).run(), /read-only|Schema changes/);
    for (const method of ['commitProposedNode', 'commitPreparedEdge', 'commitReconciliation']) assert.equal(method in store, false);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
