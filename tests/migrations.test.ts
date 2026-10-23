import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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

function demoteWorkflowAttemptsToV18(database:Database.Database){
  database.exec(`CREATE TABLE workflow_step_attempts_v18(
    project_id TEXT NOT NULL,run_id TEXT NOT NULL,step_id TEXT NOT NULL CHECK(length(step_id) BETWEEN 1 AND 100),
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 101),attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
    action TEXT NOT NULL CHECK(action IN ('navigate','click','fill','press','select','type','keyboard','upload','wait','assert','screenshot')),
    status TEXT NOT NULL CHECK(status IN ('running','passed','failed','interrupted')),
    started_at TEXT NOT NULL CHECK(length(started_at) BETWEEN 1 AND 100),finished_at TEXT,
    duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms BETWEEN 0 AND 10000000),
    error_code TEXT CHECK(error_code IS NULL OR error_code IN ('precondition_failed','missing_variable','timeout','approval_denied','revision_conflict','navigation_denied','target_invalid','assertion_failed','action_failed','interrupted')),
    assertion_passed INTEGER CHECK(assertion_passed IS NULL OR assertion_passed IN (0,1)),
    observed_count INTEGER CHECK(observed_count IS NULL OR observed_count BETWEEN 0 AND 100000),
    artifact_ref TEXT CHECK(artifact_ref IS NULL OR length(artifact_ref)<=1000),
    PRIMARY KEY(project_id,run_id,step_id,attempt),UNIQUE(project_id,run_id,ordinal,attempt),FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id)
  );
  INSERT INTO workflow_step_attempts_v18 SELECT * FROM workflow_step_attempts;
  DROP TABLE workflow_step_attempts;
  ALTER TABLE workflow_step_attempts_v18 RENAME TO workflow_step_attempts;
  CREATE INDEX workflow_step_attempts_run_order ON workflow_step_attempts(project_id,run_id,ordinal,attempt);
  CREATE INDEX workflow_step_attempts_test_lookup ON workflow_step_attempts(project_id,action,status);
  CREATE TRIGGER workflow_step_attempts_test_guard BEFORE UPDATE ON workflow_step_attempts WHEN NEW.artifact_ref='blocked' BEGIN SELECT RAISE(ABORT,'blocked artifact'); END;
  DELETE FROM schema_migrations WHERE version=19;`);
}

test('v19 workflow scroll migration preserves populated attempts and rolls back atomically before retry',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-v19-scroll-migrate-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=await Store.open(filename,'v19-project');const run=store.createRun('session','workflow',{backend:'browser'});
    store.createWorkflowStepAttempt({runId:run,stepId:'scroll-step',ordinal:1,attempt:1,action:'click',startedAt:'2026-01-01T00:00:01.000Z'});
    store.finishWorkflowStepAttempt({runId:run,stepId:'scroll-step',attempt:1,status:'failed',finishedAt:'2026-01-01T00:00:02.000Z',durationMs:123,errorCode:'action_failed',assertionPassed:false,observedCount:2,artifactRef:'.umb-managed/scroll-failure.png'});
    store.createWorkflowStepAttempt({runId:run,stepId:'scroll-step',ordinal:1,attempt:2,action:'assert',startedAt:'2026-01-01T00:00:03.000Z'});
    store.finishWorkflowStepAttempt({runId:run,stepId:'scroll-step',attempt:2,status:'passed',finishedAt:'2026-01-01T00:00:04.000Z',durationMs:45,assertionPassed:true,observedCount:1,artifactRef:'.umb-managed/scroll-success.png'});
    store.close();store=undefined;
    const setup=new Database(filename);demoteWorkflowAttemptsToV18(setup);setup.exec("CREATE TRIGGER fail_v19 BEFORE INSERT ON schema_migrations WHEN NEW.version=19 BEGIN SELECT RAISE(ABORT,'forced v19 migration failure'); END");setup.close();
    const expectedRows=[
      ['v19-project',run,'scroll-step',1,1,'click','failed','2026-01-01T00:00:01.000Z','2026-01-01T00:00:02.000Z',123,'action_failed',0,2,'.umb-managed/scroll-failure.png'],
      ['v19-project',run,'scroll-step',1,2,'assert','passed','2026-01-01T00:00:03.000Z','2026-01-01T00:00:04.000Z',45,null,1,1,'.umb-managed/scroll-success.png'],
    ];
    await assert.rejects(Store.open(filename,'v19-project'),/forced v19 migration failure/);
    const failed=new Database(filename);try{
      assert.equal((failed.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version,18);
      assert.deepEqual(failed.prepare('SELECT * FROM workflow_step_attempts ORDER BY attempt').all().map((row:any)=>Object.values(row)),expectedRows);
      assert.equal(failed.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_step_attempts_v19'").get(),undefined);
      assert.ok(failed.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='workflow_step_attempts_run_order'").get());
      assert.ok(failed.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='workflow_step_attempts_test_lookup'").get());
      assert.ok(failed.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='workflow_step_attempts_test_guard'").get());
      assert.deepEqual(failed.pragma('foreign_key_check'),[]);
    }finally{failed.close();}
    const backups=(await readdir(dir)).filter(name=>name.startsWith('memory.sqlite.pre-v19-')&&name.endsWith('.sqlite'));assert.ok(backups.length);
    const backup=new Database(path.join(dir,backups[0]),{readonly:true,fileMustExist:true});try{
      assert.equal((backup.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version,18);
      assert.equal((backup.prepare('SELECT count(*) count FROM workflow_step_attempts').get() as any).count,2);
      assert.match((backup.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_step_attempts'").get() as any).sql,/action IN \([^)]*screenshot[^)]*\)/);
      assert.doesNotMatch((backup.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_step_attempts'").get() as any).sql,/scroll/);
    }finally{backup.close();}
    const retry=new Database(filename);retry.exec('DROP TRIGGER fail_v19');retry.close();
    store=await Store.open(filename,'v19-project');
    assert.equal((store.db.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version,19);
    assert.deepEqual(store.db.prepare('SELECT * FROM workflow_step_attempts ORDER BY attempt').all().map((row:any)=>Object.values(row)),expectedRows);
    assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='workflow_step_attempts_run_order'").get());
    assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='workflow_step_attempts_test_lookup'").get());
    assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='workflow_step_attempts_test_guard'").get());
    assert.deepEqual(store.db.pragma('foreign_key_check'),[]);
    assert.deepEqual((store.getRunReport(run)!.stepAttempts as any[]).map(row=>[row.action,row.artifactRef]),[['click','.umb-managed/scroll-failure.png'],['assert','.umb-managed/scroll-success.png']]);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('populated v1 database upgrades without losing graph or YAML source data', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umb-v1-migrate-'));
  const filename = path.join(dir, 'memory.sqlite');
  let store: Store | undefined;
  try {
    createV1Fixture(filename, 'v1-project');
    store = await Store.open(filename, 'v1-project');
    assert.equal((store.get('v1-app') as any).display_name, 'Legacy app');
    assert.equal((store.get('v1-screen') as any).content_hash, 'screen-hash');
    assert.equal((store.listEdges() as any[]).find(e => e.id === 'v1-edge').relation_type, 'HAS_SCREEN');
    assert.equal((store.db.prepare('SELECT hash FROM yaml_sources WHERE path=?').get('screens/home.yaml') as any).hash, 'source-hash');
      assert.equal((store.db.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version, 19);
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
      const backupName=(await readdir(dir)).find(name=>name.startsWith('memory.sqlite.pre-v19-')&&name.endsWith('.sqlite'));
    assert(backupName,'legacy migration creates a pre-upgrade backup');
    const backup=new Database(path.join(dir,backupName),{readonly:true,fileMustExist:true});
    try{
      assert.equal((backup.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version,1);
      assert.equal((backup.prepare('SELECT id FROM nodes WHERE id=?').get('v1-screen') as any).id,'v1-screen');
      assert.deepEqual(backup.pragma('foreign_key_check'),[]);
    }finally{backup.close();}
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
    store = await Store.open(filename, 'v3-project');
    assert.equal((store.get('v3-screen') as any).display_name, 'Legacy v3 home');
    assert.equal((store.listEdges() as any[]).find(e => e.id === 'v3-edge').relation_type, 'HAS_SCREEN');
    assert.equal((store.readEvidence('v3-screen', 'v3-run') as any[])[0].id, 'v3-evidence');
    assert.equal((store.db.prepare('SELECT hash FROM yaml_ownership WHERE entity_id=?').get('v3-screen') as any).hash, 'v3-source-hash');
       assert.equal((store.db.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version, 19);
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid legacy database fails backup validation before any schema migration', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umb-v3-invalid-'));
  const filename = path.join(dir, 'memory.sqlite');
  try {
    createV3Fixture(filename, 'v3-project', true);
    assert.throws(() => new Store(filename, 'v3-project'), /requires a validated backup/);
    await assert.rejects(Store.open(filename, 'v3-project'), /SQLite foreign_key_check failed/);
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

test('v11 environment migration rolls back atomically and retries without changing legacy identity or provenance', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umb-v11-migrate-'));
  const filename = path.join(dir, 'memory.sqlite');
  try {
    createV3Fixture(filename, 'v11-project');
    const database = new Database(filename);
    database.exec("CREATE TRIGGER fail_v11 BEFORE INSERT ON schema_migrations WHEN NEW.version=11 BEGIN SELECT RAISE(ABORT,'forced v11 migration failure'); END");
    database.close();

    await assert.rejects(Store.open(filename, 'v11-project'), /forced v11 migration failure/);
    const failed = new Database(filename);
    try {
      assert.equal((failed.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version, 10);
      assert.equal((failed.prepare("SELECT count(*) count FROM pragma_table_info('nodes') WHERE name='environment'").get() as any).count, 0);
      assert.equal((failed.prepare("SELECT count(*) count FROM pragma_table_info('runs') WHERE name='memory_environment'").get() as any).count, 0);
      assert.equal((failed.prepare('SELECT id FROM edges WHERE id=?').get('v3-edge') as any).id, 'v3-edge');
    } finally { failed.close(); }

    const retry = new Database(filename);
    retry.exec('DROP TRIGGER fail_v11');
    retry.close();
    const store = await Store.open(filename, 'v11-project');
    try {
      assert.equal((store.db.prepare("SELECT count(*) count FROM nodes WHERE environment<>'legacy'").get() as any).count, 0);
      assert.equal((store.db.prepare("SELECT count(*) count FROM edges WHERE environment<>'legacy'").get() as any).count, 0);
      assert.equal((store.db.prepare("SELECT count(*) count FROM yaml_sources WHERE environment<>'legacy'").get() as any).count, 0);
      assert.equal((store.db.prepare("SELECT count(*) count FROM yaml_ownership WHERE environment<>'legacy'").get() as any).count, 0);
      assert.equal((store.db.prepare("SELECT count(*) count FROM runs WHERE memory_environment<>'legacy'").get() as any).count, 0);
      assert.equal((store.db.prepare('SELECT id FROM edges WHERE id=?').get('v3-edge') as any).id, 'v3-edge');
      assert.equal((store.db.prepare('SELECT hash FROM yaml_sources WHERE path=?').get('screens/home.yaml') as any).hash, 'v3-source-hash');
      assert.equal((store.db.prepare('SELECT entity_id FROM yaml_ownership WHERE entity_key=?').get('home') as any).entity_id, 'v3-screen');
      assert.deepEqual(store.db.pragma('foreign_key_check'), []);
    } finally { store.close(); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('v12 backfill and fingerprint tables migrate atomically behind a validated backup',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-v12-migrate-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=await Store.open(filename,'v12-project');store.close();store=undefined;
        const database=new Database(filename);database.exec("DROP TABLE desktop_finding_events; DROP TABLE desktop_comparison_findings; DROP TABLE desktop_visual_comparisons; DROP TABLE desktop_visual_findings; DROP TABLE desktop_baseline_revisions; DROP INDEX memory_audit_verify_subject_latest; DROP INDEX evidence_assertion_provenance_lookup; DROP INDEX memory_search_edges_from_bounded; DROP INDEX memory_search_edges_to_bounded; DROP TABLE memory_candidate_evidence_refs; DROP TABLE memory_lifecycle_events; DROP TABLE memory_search_tokens; DROP TABLE memory_search_values; DROP TABLE memory_search_df; DROP TABLE memory_search_state; DROP TABLE memory_candidate_observations; DROP TABLE yaml_record_fingerprints; DROP TABLE memory_backfill_items; DROP TABLE memory_backfill_jobs; DELETE FROM schema_migrations WHERE version IN (12,13,14,15,16,17,18,19); CREATE TRIGGER fail_v12 BEFORE INSERT ON schema_migrations WHEN NEW.version=12 BEGIN SELECT RAISE(ABORT,'forced v12 migration failure'); END");database.close();
    await assert.rejects(Store.open(filename,'v12-project'),/forced v12 migration failure/);
    const failed=new Database(filename);try{
      assert.equal((failed.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version,11);
      assert.equal(failed.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='yaml_record_fingerprints'").get(),undefined);
      assert.equal(failed.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_backfill_jobs'").get(),undefined);
    }finally{failed.close();}
    const retry=new Database(filename);retry.exec('DROP TRIGGER fail_v12');retry.close();
    store=await Store.open(filename,'v12-project');
       assert.equal((store.db.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version,19);
    assert.deepEqual(store.db.pragma('foreign_key_check'),[]);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('v15 lifecycle history backfills stale and legacy supersede state; failed migration retries atomically',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-v15-migrate-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=await Store.open(filename,'v15-project');const node=store.applicationSubject()!;store.close();store=undefined;
    const setup=new Database(filename);
     setup.exec('DROP TABLE desktop_finding_events; DROP TABLE desktop_comparison_findings; DROP TABLE desktop_visual_comparisons; DROP TABLE desktop_visual_findings; DROP TABLE desktop_baseline_revisions; DROP INDEX memory_audit_verify_subject_latest; DROP INDEX evidence_assertion_provenance_lookup; DROP INDEX memory_search_edges_from_bounded; DROP INDEX memory_search_edges_to_bounded; DROP TABLE memory_candidate_evidence_refs; DROP TABLE memory_lifecycle_events; DELETE FROM schema_migrations WHERE version IN (15,16,17,18,19)');
    setup.prepare("UPDATE nodes SET verification_status='stale' WHERE project_id=? AND id=?").run('v15-project',node.id);
    setup.prepare('INSERT INTO memory_audit VALUES(?,?,?,?,?,?)').run('legacy-supersede-audit','v15-project',node.id,'supersede','{"newId":"legacy-replacement"}','legacy-time');
    setup.exec("CREATE TRIGGER fail_v15 BEFORE INSERT ON schema_migrations WHEN NEW.version=15 BEGIN SELECT RAISE(ABORT,'forced v15 migration failure'); END");setup.close();
    await assert.rejects(Store.open(filename,'v15-project'),/forced v15 migration failure/);
    const failed=new Database(filename);try{
      assert.equal((failed.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version,14);
      assert.equal(failed.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_lifecycle_events'").get(),undefined);
      assert.equal((failed.prepare("SELECT count(*) count FROM memory_audit WHERE action='supersede'").get() as any).count,1);
    }finally{failed.close();}
    const retry=new Database(filename);retry.exec('DROP TRIGGER fail_v15');retry.close();
    store=await Store.open(filename,'v15-project');
    const legacy=store.db.prepare("SELECT * FROM memory_lifecycle_events WHERE id='legacy-supersede-legacy-supersede-audit'").get() as any;
    assert.equal((store.getInternal(node.id) as any).verification_status,'stale');
    assert.equal(legacy.action,'superseded');assert.equal(legacy.from_state,'verified');assert.equal(legacy.to_state,'stale');assert.equal(legacy.reason_code,'legacy_unknown');assert.equal(legacy.related_entity_id,'legacy-replacement');assert.equal(legacy.created_at,'legacy-time');
    assert.equal((store.db.prepare('SELECT count(*) count FROM memory_lifecycle_events WHERE entity_kind=? AND entity_id=?').get('node',node.id) as any).count,1,'legacy stale state and supersede audit produce one consistent transition');
    assert.equal((store.db.prepare("SELECT count(*) count FROM memory_audit WHERE id='legacy-supersede-audit'").get() as any).count,1);
    assert.deepEqual(store.db.pragma('foreign_key_check'),[]);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
