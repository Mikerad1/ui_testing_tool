import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/memory/store.js';

function createV1Fixture(filename: string, projectId: string) {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(1, '2026-01-01T00:00:00.000Z');
    CREATE TABLE nodes(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL, stable_key TEXT NOT NULL,
      display_name TEXT NOT NULL, attributes_json TEXT NOT NULL, origin TEXT NOT NULL,
      verification_status TEXT NOT NULL, confidence REAL NOT NULL, content_hash TEXT,
      tombstone INTEGER NOT NULL DEFAULT 0, UNIQUE(project_id,type,stable_key)
    );
    CREATE TABLE edges(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      from_node_id TEXT NOT NULL REFERENCES nodes(id), to_node_id TEXT NOT NULL REFERENCES nodes(id),
      relation_type TEXT NOT NULL, attributes_json TEXT NOT NULL, origin TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      UNIQUE(project_id,from_node_id,to_node_id,relation_type)
    );
    CREATE TABLE yaml_sources(
      project_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, imported_at TEXT NOT NULL,
      PRIMARY KEY(project_id,path)
    );
  `);
  db.prepare(`INSERT INTO nodes(id,project_id,type,stable_key,display_name,attributes_json,origin,verification_status,confidence,content_hash,tombstone)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('v1-app', projectId, 'application', 'app', 'Legacy app', '{"base_url":"http://localhost"}', 'human', 'verified', 1, 'app-hash', 0);
  db.prepare(`INSERT INTO nodes(id,project_id,type,stable_key,display_name,attributes_json,origin,verification_status,confidence,content_hash,tombstone)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('v1-screen', projectId, 'screen', 'home', 'Legacy home', '{"route":"/"}', 'yaml', 'proposed', 0.7, 'screen-hash', 0);
  db.prepare('INSERT INTO edges VALUES(?,?,?,?,?,?,?,?)').run('v1-edge', projectId, 'v1-app', 'v1-screen', 'HAS_SCREEN', '{"path":"/"}', 'yaml', 'proposed');
  db.prepare('INSERT INTO yaml_sources VALUES(?,?,?,?)').run(projectId, 'screens/home.yaml', 'source-hash', '2026-01-01T00:00:00.000Z');
  db.close();
}

function createV3Fixture(filename: string, projectId: string, corruptEdge = false) {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(1, 'v1');
    INSERT INTO schema_migrations VALUES(2, 'v2');
    INSERT INTO schema_migrations VALUES(3, 'v3');
    CREATE TABLE nodes(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL, stable_key TEXT NOT NULL,
      display_name TEXT NOT NULL, attributes_json TEXT NOT NULL, origin TEXT NOT NULL,
      verification_status TEXT NOT NULL, confidence REAL NOT NULL, content_hash TEXT,
      tombstone INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '', superseded_by TEXT,
      UNIQUE(project_id,type,stable_key)
    );
    CREATE UNIQUE INDEX nodes_project_id_id ON nodes(project_id,id);
    CREATE TABLE edges(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL,
      relation_type TEXT NOT NULL, attributes_json TEXT NOT NULL, origin TEXT NOT NULL,
      verification_status TEXT NOT NULL, UNIQUE(project_id,from_node_id,to_node_id,relation_type),
      FOREIGN KEY(project_id,from_node_id) REFERENCES nodes(project_id,id),
      FOREIGN KEY(project_id,to_node_id) REFERENCES nodes(project_id,id)
    );
    CREATE INDEX edges_from ON edges(project_id,from_node_id);
    CREATE INDEX edges_to ON edges(project_id,to_node_id);
    CREATE TABLE yaml_sources(project_id TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,imported_at TEXT NOT NULL,PRIMARY KEY(project_id,path));
    CREATE TABLE runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT);
    CREATE UNIQUE INDEX runs_project_id_id ON runs(project_id,id);
    CREATE TABLE evidence(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,subject_node_id TEXT NOT NULL,
      kind TEXT NOT NULL,outcome TEXT NOT NULL,metadata_json TEXT NOT NULL,artifact_ref TEXT,created_at TEXT NOT NULL,
      FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
      FOREIGN KEY(project_id,subject_node_id) REFERENCES nodes(project_id,id)
    );
    CREATE INDEX evidence_subject ON evidence(project_id,subject_node_id,run_id);
    CREATE TABLE yaml_ownership(project_id TEXT NOT NULL,source_path TEXT NOT NULL,entity_type TEXT NOT NULL,entity_key TEXT NOT NULL,entity_id TEXT NOT NULL,hash TEXT NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,source_path,entity_type,entity_key));
    CREATE TABLE memory_audit(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,subject_node_id TEXT NOT NULL,action TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
  db.prepare(`INSERT INTO nodes(id,project_id,type,stable_key,display_name,attributes_json,origin,verification_status,confidence,content_hash,tombstone,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('v3-app', projectId, 'application', 'app', 'Legacy v3 app', '{}', 'human', 'verified', 1, 'app-hash', 0, 'v3-created', 'v3-updated');
  db.prepare(`INSERT INTO nodes(id,project_id,type,stable_key,display_name,attributes_json,origin,verification_status,confidence,content_hash,tombstone,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('v3-screen', projectId, 'screen', 'home', 'Legacy v3 home', '{"route":"/"}', 'yaml', 'proposed', 0.7, 'screen-hash', 0, 'v3-created', 'v3-updated');
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('v3-run', projectId, 'passed', 'v3-start', 'v3-end');
  db.prepare('INSERT INTO yaml_sources VALUES(?,?,?,?)').run(projectId, 'screens/home.yaml', 'v3-source-hash', 'v3-imported');
  db.prepare('INSERT INTO yaml_ownership VALUES(?,?,?,?,?,?,0)').run(projectId, 'screens/home.yaml', 'screen', 'home', 'v3-screen', 'v3-source-hash');
  db.prepare('INSERT INTO memory_audit VALUES(?,?,?,?,?,?)').run('v3-audit', projectId, 'v3-screen', 'propose', '{}', 'v3-audit-time');
  if (corruptEdge) {
    db.pragma('foreign_keys = OFF');
    db.prepare('INSERT INTO edges VALUES(?,?,?,?,?,?,?,?)').run('v3-invalid-edge', projectId, 'missing', 'v3-screen', 'HAS_SCREEN', '{}', 'yaml', 'proposed');
  } else {
    db.prepare('INSERT INTO edges VALUES(?,?,?,?,?,?,?,?)').run('v3-edge', projectId, 'v3-app', 'v3-screen', 'HAS_SCREEN', '{"path":"/"}', 'yaml', 'proposed');
    db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?)').run('v3-evidence', projectId, 'v3-run', 'v3-screen', 'assertion', 'passed', '{"observed_count":1}', null, 'v3-evidence-time');
  }
  db.close();
}

test('populated v1 database upgrades without losing graph or YAML source data', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umb-v1-migrate-'));
  const filename = path.join(dir, 'memory.sqlite');
  let store: Store | undefined;
  try {
    createV1Fixture(filename, 'v1-project');
    store = new Store(filename, 'v1-project');
    assert.equal((store.get('v1-app') as any).display_name, 'Legacy app');
    assert.equal((store.get('v1-screen') as any).content_hash, 'screen-hash');
    assert.equal((store.listEdges() as any[]).find(e => e.id === 'v1-edge').relation_type, 'HAS_SCREEN');
    assert.equal((store.db.prepare('SELECT hash FROM yaml_sources WHERE path=?').get('screens/home.yaml') as any).hash, 'source-hash');
    assert.equal((store.db.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version, 9);
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('populated v3 database upgrades preserving runs, evidence, ownership and edges', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umb-v3-migrate-'));
  const filename = path.join(dir, 'memory.sqlite');
  let store: Store | undefined;
  try {
    createV3Fixture(filename, 'v3-project');
    store = new Store(filename, 'v3-project');
    assert.equal((store.get('v3-screen') as any).display_name, 'Legacy v3 home');
    assert.equal((store.listEdges() as any[]).find(e => e.id === 'v3-edge').relation_type, 'HAS_SCREEN');
    assert.equal((store.readEvidence('v3-screen', 'v3-run') as any[])[0].id, 'v3-evidence');
    assert.equal((store.db.prepare('SELECT hash FROM yaml_ownership WHERE entity_id=?').get('v3-screen') as any).hash, 'v3-source-hash');
    assert.equal((store.db.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version, 9);
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid populated v3 migration rolls back and retains original edge', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umb-v3-invalid-'));
  const filename = path.join(dir, 'memory.sqlite');
  try {
    createV3Fixture(filename, 'v3-project', true);
    assert.throws(() => new Store(filename, 'v3-project'), /Cannot migrate v4|FOREIGN KEY/i);
    const db = new Database(filename);
    try {
      assert.equal((db.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version, 3);
      assert.equal((db.prepare('SELECT id FROM edges WHERE id=?').get('v3-invalid-edge') as any).id, 'v3-invalid-edge');
      const edgeColumns = db.prepare('PRAGMA table_info(edges)').all() as {name:string}[];
      assert.equal(edgeColumns.some(column => column.name === 'stable_key'), false);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
