import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {normalizeLocator} from '../knowledge/locator-proposals.js';
import {hasNlpMetadata, NLP_METADATA_KEY, type YamlReconciliationPlan, type YamlRecordFingerprint} from './learning-types.js';
import {registerStoreWriteOperations, type BackfillEdgeWrite, type BackfillNodeWrite} from './store-internal.js';
import {assertMemoryEnvironment, LEGACY_MEMORY_ENVIRONMENT} from './environment.js';
import {migrateEnvironmentSchema} from './schema-v11.js';
import {commitYamlReconciliation} from './yaml-commit.js';
import {backupSqlite} from './sqlite-backup.js';
import {hashBackfillEdge, hashBackfillNode, withoutNlpMetadata, type BackfillEdgeValue, type BackfillNodeValue} from './content-fingerprint.js';
import type {BackfillEdgeRecord, BackfillNodeRecord, BackfillRecord, BackfillRedactedHash, BackfillSummary} from './backfill-types.js';

type Evidence = { id:string; project_id:string; run_id:string; subject_node_id:string; kind:string; outcome:string; metadata_json:string; artifact_ref:string|null; created_at:string };
export type WorkflowRecallContext={goal:string;currentUrl:string;role?:string;environment?:string;limit?:number};
type RecallNode={id:string;stable_key:string;canonical_key:string;display_name:string;attributes_json:string;origin:string;verification_status:string;confidence:number;conflict_status:string;tombstone:number;updated_at:string};
const WORKFLOW_ACTIONS=new Set(['navigate','click','fill','press','select','type','keyboard','upload','wait','assert','screenshot']);
const WORKFLOW_ERROR_CODES=new Set(['precondition_failed','missing_variable','timeout','approval_denied','revision_conflict','navigation_denied','target_invalid','assertion_failed','action_failed','interrupted']);
const ASSERTION_CAPTURE_CODES=new Set(['quota_exceeded','capture_failed']);
const isWorkflowTimestamp=(value:string)=>value.length<=100&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const SAFE_PRAGMAS=new Set(['foreign_key_check','integrity_check','quick_check','schema_version','user_version']);
const MUTATING_SQL=/\b(?:INSERT|REPLACE|UPDATE|DELETE|CREATE|ALTER|DROP|REINDEX|VACUUM|ATTACH|DETACH)\b/i;
type ReadOnlyDatabase=Pick<Database.Database,'prepare'|'pragma'>;
const MIGRATION_BACKUP_AUTHORIZATION=Symbol('validated-sqlite-migration-backup');

function removeSqlComments(sql:string){return sql.replace(/--[^\n\r]*/g,' ').replace(/\/\*[\s\S]*?\*\//g,' ');}
function assertReadOnlySql(sql:string){
  const statement=removeSqlComments(sql);
  if(MUTATING_SQL.test(statement))throw new Error('Store database access is read-only');
  if(/\b(?:CREATE|ALTER|DROP|REINDEX|VACUUM|ATTACH|DETACH|PRAGMA|LOAD_EXTENSION)\b/i.test(statement))throw new Error('Schema changes must use Store migrations');
}

function readOnlyDatabase(database:Database.Database):ReadOnlyDatabase{
  // Never proxy the Database itself: its prototype and reflection surface must
  // not provide a route back to the mutable native handle.
  const facade=Object.create(null) as Record<PropertyKey,unknown>;
  Object.defineProperties(facade,{
     prepare:{enumerable:true,value:(sql:string)=>{assertReadOnlySql(sql);return database.prepare(sql);}},
     pragma:{enumerable:true,value:(source:string)=>{
       const match=/^[a-z_]+$/i.exec(source.trim()),pragma=match?.[0].toLowerCase();
       if(!pragma||!SAFE_PRAGMAS.has(pragma))throw new Error('Store database access is read-only');
       return database.pragma(pragma);
     }},
  });
  Object.freeze(facade);
  return new Proxy(facade as ReadOnlyDatabase,{
    getPrototypeOf:()=>null,
    set:()=>false,
    defineProperty:()=>false,
    deleteProperty:()=>false,
    setPrototypeOf:()=>false,
  });
}

export const CURRENT_SCHEMA_VERSION=12;
export class Store {
  declare readonly db: ReadOnlyDatabase; declare readonly projectId: string; declare readonly memoryEnvironment: string; #database: Database.Database;
  static async open(filename:string,projectId:string,memoryEnvironment=LEGACY_MEMORY_ENVIRONMENT):Promise<Store>{
    if(Store.requiresMigrationBackup(filename)){
      const backupFilename=`${path.resolve(filename)}.pre-v${CURRENT_SCHEMA_VERSION}-${Date.now()}-${randomUUID()}.sqlite`;
      await backupSqlite(filename,backupFilename);
      process.stderr.write(`Created and validated SQLite migration backup: ${backupFilename}\n`);
      return new Store(filename,projectId,memoryEnvironment,MIGRATION_BACKUP_AUTHORIZATION);
    }
    return new Store(filename,projectId,memoryEnvironment);
  }
  private static requiresMigrationBackup(filename:string):boolean{
    if(filename===':memory:'||!existsSync(filename))return false;
    const database=new Database(filename,{readonly:true,fileMustExist:true});
    try{
      const migrationTable=database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
      if(!migrationTable)return (database.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as {count:number}).count>0;
      const applied=new Set((database.prepare('SELECT version FROM schema_migrations').all() as Array<{version:number}>).map(row=>row.version));
      for(let version=1;version<=CURRENT_SCHEMA_VERSION;version++)if(!applied.has(version))return true;
      return false;
    }finally{database.close();}
  }
  constructor(filename:string, projectId:string, memoryEnvironment=LEGACY_MEMORY_ENVIRONMENT,migrationAuthorization?:symbol) {
    const scope=assertMemoryEnvironment(memoryEnvironment);
    Object.defineProperty(this,'projectId',{value:projectId,enumerable:true,writable:false,configurable:false});
    Object.defineProperty(this,'memoryEnvironment',{value:scope,enumerable:true,writable:false,configurable:false});
    this.#database=new Database(filename);
    try{
      if(Store.requiresMigrationBackup(filename)&&migrationAuthorization!==MIGRATION_BACKUP_AUTHORIZATION)throw new Error('Schema migration requires a validated backup; open the Store with Store.open()');
      const databaseView=readOnlyDatabase(this.#database);
      Object.defineProperty(this,'db',{enumerable:true,configurable:false,get:()=>databaseView});
      this.#database.pragma('journal_mode = WAL'); this.#database.pragma('foreign_keys = ON');
      this.migrate();
      this.#database.prepare('INSERT OR IGNORE INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),projectId,scope,'application',projectId,projectId,projectId,'{}','human','verified',1);
      registerStoreWriteOperations(this,{
        proposedNode:input=>this.#commitProposedNode(input),
      preparedEdge:input=>this.#commitPreparedEdge(input),
      reconciliation:plan=>this.#commitReconciliation(plan),
      backfillNode:input=>this.#commitBackfillNode(input),
      backfillEdge:input=>this.#commitBackfillEdge(input),
      });
    }catch(error){
      try{this.#database.close();}catch{}
      throw error;
    }
  }
  private migrate() {
    this.#database.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
    const has=(v:number)=>!!this.#database.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(v);
    if(!has(1)) this.#database.transaction(()=>{
      this.#database.exec(`CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,type TEXT NOT NULL,stable_key TEXT NOT NULL,display_name TEXT NOT NULL,attributes_json TEXT NOT NULL,origin TEXT NOT NULL,verification_status TEXT NOT NULL,confidence REAL NOT NULL,content_hash TEXT,tombstone INTEGER NOT NULL DEFAULT 0,UNIQUE(project_id,type,stable_key));
      CREATE TABLE IF NOT EXISTS edges(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,from_node_id TEXT NOT NULL REFERENCES nodes(id),to_node_id TEXT NOT NULL REFERENCES nodes(id),relation_type TEXT NOT NULL,attributes_json TEXT NOT NULL,origin TEXT NOT NULL,verification_status TEXT NOT NULL,UNIQUE(project_id,from_node_id,to_node_id,relation_type));
      CREATE TABLE IF NOT EXISTS yaml_sources(project_id TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,imported_at TEXT NOT NULL,PRIMARY KEY(project_id,path));`);
      this.#database.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(new Date().toISOString());
    })();
    if(!has(2)) this.#database.transaction(()=>{
      const invalid=this.#database.prepare('SELECT e.id FROM edges e LEFT JOIN nodes f ON f.id=e.from_node_id AND f.project_id=e.project_id LEFT JOIN nodes t ON t.id=e.to_node_id AND t.project_id=e.project_id WHERE f.id IS NULL OR t.id IS NULL LIMIT 1').get() as {id:string}|undefined;
      if(invalid) throw Error(`Cannot migrate v2: legacy edge ${invalid.id} has missing or cross-project endpoint`);
      this.#database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS nodes_project_id_id ON nodes(project_id,id);
      ALTER TABLE nodes ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE nodes ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE nodes ADD COLUMN superseded_by TEXT;
      UPDATE nodes SET created_at=datetime('now'),updated_at=datetime('now') WHERE created_at='';
      CREATE TABLE edges_v2(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,from_node_id TEXT NOT NULL,to_node_id TEXT NOT NULL,relation_type TEXT NOT NULL,attributes_json TEXT NOT NULL,origin TEXT NOT NULL,verification_status TEXT NOT NULL,UNIQUE(project_id,from_node_id,to_node_id,relation_type),FOREIGN KEY(project_id,from_node_id) REFERENCES nodes(project_id,id),FOREIGN KEY(project_id,to_node_id) REFERENCES nodes(project_id,id));
      INSERT INTO edges_v2 SELECT id,project_id,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status FROM edges;
      DROP TABLE edges; ALTER TABLE edges_v2 RENAME TO edges;
      CREATE TABLE runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT);
      CREATE TABLE evidence(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,subject_node_id TEXT NOT NULL,kind TEXT NOT NULL,outcome TEXT NOT NULL,metadata_json TEXT NOT NULL,artifact_ref TEXT,created_at TEXT NOT NULL,FOREIGN KEY(project_id,subject_node_id) REFERENCES nodes(project_id,id),FOREIGN KEY(run_id) REFERENCES runs(id));
      CREATE INDEX evidence_subject ON evidence(project_id,subject_node_id,run_id);
      CREATE TABLE yaml_ownership(project_id TEXT NOT NULL,source_path TEXT NOT NULL,entity_type TEXT NOT NULL,entity_key TEXT NOT NULL,entity_id TEXT NOT NULL,hash TEXT NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,source_path,entity_type,entity_key));
      CREATE TABLE memory_audit(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,subject_node_id TEXT NOT NULL,action TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX edges_from ON edges(project_id,from_node_id); CREATE INDEX edges_to ON edges(project_id,to_node_id);`);
      this.#database.prepare('INSERT INTO schema_migrations VALUES(2,?)').run(new Date().toISOString());
    })();
    if(!has(3)) this.#database.transaction(()=>{
      const invalid=this.#database.prepare(`SELECT e.id,e.project_id,e.run_id,e.subject_node_id FROM evidence e LEFT JOIN runs r ON r.id=e.run_id LEFT JOIN nodes n ON n.id=e.subject_node_id WHERE r.id IS NULL OR n.id IS NULL OR r.project_id<>e.project_id OR n.project_id<>e.project_id LIMIT 1`).get() as {id:string;project_id:string;run_id:string;subject_node_id:string}|undefined;
      if(invalid) throw Error(`Cannot migrate v3: evidence ${invalid.id} has a run or subject outside project ${invalid.project_id}`);
      this.#database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS runs_project_id_id ON runs(project_id,id);
        CREATE TABLE evidence_v3(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,subject_node_id TEXT NOT NULL,kind TEXT NOT NULL,outcome TEXT NOT NULL,metadata_json TEXT NOT NULL,artifact_ref TEXT,created_at TEXT NOT NULL,FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),FOREIGN KEY(project_id,subject_node_id) REFERENCES nodes(project_id,id));
        INSERT INTO evidence_v3 SELECT id,project_id,run_id,subject_node_id,kind,outcome,metadata_json,artifact_ref,created_at FROM evidence;
        DROP TABLE evidence; ALTER TABLE evidence_v3 RENAME TO evidence;
        CREATE INDEX evidence_subject ON evidence(project_id,subject_node_id,run_id);`);
      this.#database.prepare('INSERT INTO schema_migrations VALUES(3,?)').run(new Date().toISOString());
    })();
    if(!has(4)) this.#database.transaction(()=>{
      const duplicate=this.#database.prepare(`SELECT project_id,entity_type,entity_key,count(*) count FROM yaml_ownership WHERE tombstone=0 GROUP BY project_id,entity_type,entity_key HAVING count(*)>1 LIMIT 1`).get() as {project_id:string;entity_type:string;entity_key:string}|undefined;
      if(duplicate) throw Error(`Cannot migrate v4: duplicate active YAML ownership ${duplicate.project_id}/${duplicate.entity_type}/${duplicate.entity_key}`);
      const edgeCount=(this.#database.prepare('SELECT count(*) count FROM edges').get() as {count:number}).count;
      this.#database.exec(`ALTER TABLE nodes ADD COLUMN canonical_key TEXT NOT NULL DEFAULT '';
        ALTER TABLE nodes ADD COLUMN conflict_status TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE nodes ADD COLUMN conflicting_node_id TEXT;
        UPDATE nodes SET canonical_key=stable_key WHERE canonical_key='';
        ALTER TABLE yaml_sources ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE yaml_ownership ADD COLUMN conflict_status TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE yaml_ownership ADD COLUMN conflicting_entity_id TEXT;
        CREATE UNIQUE INDEX yaml_ownership_active_identity ON yaml_ownership(project_id,entity_type,entity_key) WHERE tombstone=0;
        CREATE TABLE edges_v4(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,from_node_id TEXT NOT NULL,to_node_id TEXT NOT NULL,relation_type TEXT NOT NULL,attributes_json TEXT NOT NULL,origin TEXT NOT NULL,verification_status TEXT NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',conflict_status TEXT NOT NULL DEFAULT 'none',conflicting_edge_id TEXT,UNIQUE(project_id,from_node_id,to_node_id,relation_type,origin),FOREIGN KEY(project_id,from_node_id) REFERENCES nodes(project_id,id),FOREIGN KEY(project_id,to_node_id) REFERENCES nodes(project_id,id));
        INSERT INTO edges_v4(id,project_id,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,created_at,updated_at) SELECT id,project_id,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,datetime('now'),datetime('now') FROM edges;
        DROP TABLE edges; ALTER TABLE edges_v4 RENAME TO edges;
        CREATE INDEX edges_from ON edges(project_id,from_node_id); CREATE INDEX edges_to ON edges(project_id,to_node_id);`);
      const after=(this.#database.prepare('SELECT count(*) count FROM edges').get() as {count:number}).count;
      if(after!==edgeCount) throw Error(`Cannot migrate v4: edge row count changed from ${edgeCount} to ${after}`);
      const fk=this.#database.prepare('PRAGMA foreign_key_check').all(); if(fk.length) throw Error('Cannot migrate v4: edge foreign-key validation failed');
      this.#database.prepare('INSERT INTO schema_migrations VALUES(4,?)').run(new Date().toISOString());
    })();
    if(!has(5)) this.#database.transaction(()=>{
      this.#database.exec(`ALTER TABLE runs ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE runs ADD COLUMN workflow_id TEXT;
        ALTER TABLE runs ADD COLUMN started_at TEXT NOT NULL DEFAULT '';
        ALTER TABLE runs ADD COLUMN environment_json TEXT NOT NULL DEFAULT '{}';
        UPDATE runs SET started_at=created_at WHERE started_at='';`);
      this.#database.prepare('INSERT INTO schema_migrations VALUES(5,?)').run(new Date().toISOString());
    })();
    if(!has(6)) this.#database.transaction(()=>{
      const before=(this.#database.prepare('SELECT count(*) count FROM edges').get() as {count:number}).count;
      this.#database.exec(`CREATE TABLE edges_v6(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,from_node_id TEXT NOT NULL,to_node_id TEXT NOT NULL,relation_type TEXT NOT NULL,attributes_json TEXT NOT NULL,origin TEXT NOT NULL,verification_status TEXT NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',conflict_status TEXT NOT NULL DEFAULT 'none',conflicting_edge_id TEXT,stable_key TEXT NOT NULL,UNIQUE(project_id,origin,stable_key),FOREIGN KEY(project_id,from_node_id) REFERENCES nodes(project_id,id),FOREIGN KEY(project_id,to_node_id) REFERENCES nodes(project_id,id));
        INSERT INTO edges_v6(id,project_id,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,tombstone,created_at,updated_at,conflict_status,conflicting_edge_id,stable_key) SELECT id,project_id,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,tombstone,created_at,updated_at,conflict_status,conflicting_edge_id,'legacy:'||from_node_id||':'||relation_type||':'||to_node_id FROM edges;
        DROP TABLE edges; ALTER TABLE edges_v6 RENAME TO edges; CREATE INDEX edges_from ON edges(project_id,from_node_id); CREATE INDEX edges_to ON edges(project_id,to_node_id);`);
      const after=(this.#database.prepare('SELECT count(*) count FROM edges').get() as {count:number}).count;
      if(after!==before) throw Error(`Cannot migrate v6: edge row count changed from ${before} to ${after}`);
      if(this.#database.prepare('PRAGMA foreign_key_check').all().length) throw Error('Cannot migrate v6: edge foreign-key validation failed');
      this.#database.prepare('INSERT INTO schema_migrations VALUES(6,?)').run(new Date().toISOString());
    })();
    if(!has(7)) this.#database.transaction(()=>{
      const invalid=this.#database.prepare('SELECT e.id FROM edges e LEFT JOIN nodes f ON f.id=e.from_node_id AND f.project_id=e.project_id LEFT JOIN nodes t ON t.id=e.to_node_id AND t.project_id=e.project_id WHERE f.id IS NULL OR t.id IS NULL LIMIT 1').get() as {id:string}|undefined;
      if(invalid) throw Error(`Cannot migrate v7: legacy edge ${invalid.id} has a missing or cross-project endpoint`);
      const before=(this.#database.prepare('SELECT count(*) count FROM edges').get() as {count:number}).count;
      this.#database.exec(`CREATE TABLE edges_v7(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,from_node_id TEXT NOT NULL,to_node_id TEXT NOT NULL,relation_type TEXT NOT NULL,attributes_json TEXT NOT NULL,origin TEXT NOT NULL,verification_status TEXT NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',conflict_status TEXT NOT NULL DEFAULT 'none',conflicting_edge_id TEXT,stable_key TEXT NOT NULL,UNIQUE(project_id,origin,stable_key),FOREIGN KEY(project_id,from_node_id) REFERENCES nodes(project_id,id),FOREIGN KEY(project_id,to_node_id) REFERENCES nodes(project_id,id));
        INSERT INTO edges_v7 SELECT id,project_id,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,tombstone,created_at,updated_at,conflict_status,conflicting_edge_id,'legacy:'||origin||':'||from_node_id||':'||relation_type||':'||to_node_id FROM edges;
        DROP TABLE edges; ALTER TABLE edges_v7 RENAME TO edges; CREATE INDEX edges_from ON edges(project_id,from_node_id); CREATE INDEX edges_to ON edges(project_id,to_node_id);`);
      const after=(this.#database.prepare('SELECT count(*) count FROM edges').get() as {count:number}).count;
      if(after!==before) throw Error(`Cannot migrate v7: edge row count changed from ${before} to ${after}`);
      if(this.#database.prepare('PRAGMA foreign_key_check').all().length) throw Error('Cannot migrate v7: foreign-key validation failed');
      this.#database.prepare('INSERT INTO schema_migrations VALUES(7,?)').run(new Date().toISOString());
    })();
    if(!has(8)) this.#database.transaction(()=>{
      this.#database.exec(`CREATE TABLE workflow_step_attempts(
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
      CREATE INDEX workflow_step_attempts_run_order ON workflow_step_attempts(project_id,run_id,ordinal,attempt);`);
      this.#database.prepare('INSERT INTO schema_migrations VALUES(8,?)').run(new Date().toISOString());
    })();
    if(!has(9)) this.#database.transaction(()=>{
      this.#database.exec(`CREATE TABLE workflow_locator_proposals(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,workflow_node_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL CHECK(length(workflow_id) BETWEEN 1 AND 120),step_id TEXT NOT NULL CHECK(length(step_id) BETWEEN 1 AND 120),
        screen_id TEXT NOT NULL CHECK(length(screen_id) BETWEEN 1 AND 120),element_id TEXT NOT NULL CHECK(length(element_id) BETWEEN 1 AND 120),
        screen_node_id TEXT NOT NULL,element_node_id TEXT NOT NULL,source_path TEXT NOT NULL CHECK(length(source_path) BETWEEN 1 AND 1024),
        source_hash TEXT NOT NULL CHECK(length(source_hash)=64),baseline_hash TEXT NOT NULL CHECK(length(baseline_hash)=64),
        previous_locator_json TEXT NOT NULL CHECK(length(previous_locator_json)<=1500),fallback_history_json TEXT NOT NULL CHECK(length(fallback_history_json)<=12000),
        candidate_locator_json TEXT NOT NULL CHECK(length(candidate_locator_json)<=1500),reason_code TEXT NOT NULL CHECK(reason_code IN ('target_invalid')),
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','stale')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),FOREIGN KEY(project_id,workflow_node_id) REFERENCES nodes(project_id,id),
        FOREIGN KEY(project_id,screen_node_id) REFERENCES nodes(project_id,id),FOREIGN KEY(project_id,element_node_id) REFERENCES nodes(project_id,id)
      );CREATE INDEX workflow_locator_proposals_target ON workflow_locator_proposals(project_id,screen_id,element_id,created_at,id);`);
      this.#database.prepare('INSERT INTO schema_migrations VALUES(9,?)').run(new Date().toISOString());
    })();
    if(!has(10)) this.#database.transaction(()=>{
      this.#database.exec(`ALTER TABLE runs ADD COLUMN workflow_snapshot_hash TEXT;
        CREATE TABLE workflow_export_verifications(
          project_id TEXT NOT NULL,workflow_node_id TEXT NOT NULL,snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
          run_id TEXT NOT NULL,verified_at TEXT NOT NULL,
          PRIMARY KEY(project_id,workflow_node_id,snapshot_hash),
          FOREIGN KEY(project_id,workflow_node_id) REFERENCES nodes(project_id,id),
          FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id)
        );
        CREATE INDEX workflow_export_verifications_run ON workflow_export_verifications(project_id,run_id);`);
      if(this.#database.prepare('PRAGMA foreign_key_check').all().length)throw Error('Cannot migrate v10: foreign-key validation failed');
      this.#database.prepare('INSERT INTO schema_migrations VALUES(10,?)').run(new Date().toISOString());
    })();
    if(!has(11)) migrateEnvironmentSchema(this.#database);
    if(!has(12)) this.#database.transaction(()=>{
      this.#database.exec(`
        CREATE TABLE yaml_record_fingerprints(
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          document_kind TEXT NOT NULL,
          document_id TEXT NOT NULL,
          source_path TEXT NOT NULL,
          raw_hash TEXT NOT NULL CHECK(length(raw_hash)=64),
          redacted_hash TEXT NOT NULL CHECK(length(redacted_hash)=64),
          preparation_key TEXT NOT NULL CHECK(length(preparation_key)=64),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(project_id,environment,document_kind,document_id)
        );
        CREATE TABLE memory_backfill_jobs(
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          pipeline_fingerprint TEXT NOT NULL CHECK(length(pipeline_fingerprint)=64),
          status TEXT NOT NULL CHECK(status IN ('running','interrupted','completed')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE(project_id,environment,pipeline_fingerprint),
          UNIQUE(project_id,environment,id)
        );
        CREATE TABLE memory_backfill_items(
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          job_id TEXT NOT NULL,
          entity_kind TEXT NOT NULL CHECK(entity_kind IN ('node','edge')),
          entity_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
          redacted_hash TEXT CHECK(redacted_hash IS NULL OR length(redacted_hash)=64),
          status TEXT NOT NULL CHECK(status IN ('pending','processed','obsolete')),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(project_id,environment,job_id,entity_kind,entity_id),
          FOREIGN KEY(project_id,environment,job_id) REFERENCES memory_backfill_jobs(project_id,environment,id)
        );
        CREATE INDEX memory_backfill_pending ON memory_backfill_items(project_id,environment,job_id,status,entity_kind,entity_id);
      `);
      this.#database.prepare('INSERT INTO schema_migrations VALUES(12,?)').run(new Date().toISOString());
    })();
  }
  close(){this.#database.close();}
  export(){return{nodes:this.#database.prepare('SELECT * FROM nodes WHERE project_id=? AND environment=? AND tombstone=0').all(this.projectId,this.memoryEnvironment),edges:this.#database.prepare('SELECT * FROM edges WHERE project_id=? AND environment=? AND tombstone=0').all(this.projectId,this.memoryEnvironment)};}
  context(){return this.#database.prepare('SELECT type,canonical_key stable_key,display_name,verification_status FROM nodes WHERE project_id=? AND environment=? AND tombstone=0 ORDER BY type,display_name LIMIT 100').all(this.projectId,this.memoryEnvironment);}
  search(q:string){return this.#database.prepare('SELECT id,type,stable_key,display_name,attributes_json,origin,verification_status,confidence FROM nodes WHERE project_id=? AND environment=? AND tombstone=0 AND (display_name LIKE ? OR attributes_json LIKE ?) LIMIT 50').all(this.projectId,this.memoryEnvironment,`%${q.slice(0,200)}%`,`%${q.slice(0,200)}%`);}
  get(id:string){return this.#database.prepare('SELECT * FROM nodes WHERE project_id=? AND environment=? AND id=? AND tombstone=0').get(this.projectId,this.memoryEnvironment,id)??null;}
  getByTypeKey(type:string,key:string){
    const owned=this.#database.prepare(`SELECT n.* FROM yaml_ownership y JOIN nodes n ON n.project_id=y.project_id AND n.environment=y.environment AND n.id=y.entity_id WHERE y.project_id=? AND y.environment=? AND y.entity_type=? AND y.entity_key=? AND y.tombstone=0 AND n.tombstone=0 ORDER BY y.source_path LIMIT 1`).get(this.projectId,this.memoryEnvironment,type,key);
    return owned??this.#database.prepare('SELECT * FROM nodes WHERE project_id=? AND environment=? AND type=? AND canonical_key=? AND tombstone=0 ORDER BY CASE origin WHEN \'yaml\' THEN 0 ELSE 1 END,id LIMIT 1').get(this.projectId,this.memoryEnvironment,type,key)??null;
  }
    #commitProposedNode(input:{type:string;stable_key:string;display_name:string;attributes:Record<string,unknown>}){
      if(!hasNlpMetadata(input.attributes))throw Error('NLP ingestion is required');
      if(input.stable_key.length>200||input.display_name.length>500)throw Error('Knowledge field too long');
      return this.#database.transaction(()=>{
        const id=randomUUID(),occupied=this.#database.prepare('SELECT * FROM nodes WHERE project_id=? AND environment=? AND type=? AND canonical_key=? AND tombstone=0 LIMIT 1').get(this.projectId,this.memoryEnvironment,input.type,input.stable_key) as {id:string}|undefined;
        let stored=input.stable_key;
        if(occupied){
          stored=`agent:${id}:${input.stable_key}`;
          this.#database.prepare("UPDATE nodes SET conflict_status='conflict',conflicting_node_id=? WHERE project_id=? AND environment=? AND id=?").run(id,this.projectId,this.memoryEnvironment,occupied.id);
        }
        this.#database.prepare('INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence,conflict_status,conflicting_node_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,this.projectId,this.memoryEnvironment,input.type,stored,input.stable_key,input.display_name,JSON.stringify(input.attributes),'agent','proposed',0.5,occupied?'conflict':'none',occupied?.id??null);
        return this.get(id);
      })();
    }
    #commitPreparedEdge(input:{from_id:string;to_id:string;relation:string;attributes:Record<string,unknown>}){
      if(!hasNlpMetadata(input.attributes))throw Error('NLP ingestion is required');
      const id=randomUUID(),stableKey=`${input.from_id}:${input.relation}:${input.to_id}`;
      return this.#database.transaction(()=>{
        const endpoints=this.#database.prepare('SELECT count(*) count FROM nodes WHERE project_id=? AND environment=? AND id IN (?,?) AND tombstone=0').get(this.projectId,this.memoryEnvironment,input.from_id,input.to_id) as {count:number};
        if(endpoints.count!==(input.from_id===input.to_id?1:2))throw Error('Edge endpoints must belong to this project and environment');
        this.#database.prepare('INSERT INTO edges(id,project_id,environment,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,stable_key) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,environment,origin,stable_key) DO UPDATE SET attributes_json=excluded.attributes_json').run(id,this.projectId,this.memoryEnvironment,input.from_id,input.to_id,input.relation,JSON.stringify(input.attributes),'agent','proposed',stableKey);
        return this.#database.prepare('SELECT * FROM edges WHERE project_id=? AND environment=? AND origin=? AND stable_key=?').get(this.projectId,this.memoryEnvironment,'agent',stableKey);
      })();
    }
    #commitReconciliation(plan:YamlReconciliationPlan){return commitYamlReconciliation(this.#database,this.projectId,this.memoryEnvironment,plan);}
  getYamlRecordNormalization(input:Pick<YamlRecordFingerprint,'document_kind'|'document_id'|'raw_hash'|'redacted_hash'|'preparation_key'>):string|null{
    const row=this.#database.prepare(`SELECT n.attributes_json FROM yaml_record_fingerprints f
      JOIN yaml_ownership y ON y.project_id=f.project_id AND y.environment=f.environment AND y.entity_type=f.document_kind AND y.entity_key=f.document_id AND y.source_path=f.source_path AND y.hash=f.raw_hash AND y.tombstone=0
      JOIN nodes n ON n.project_id=y.project_id AND n.environment=y.environment AND n.id=y.entity_id AND n.type=f.document_kind AND n.content_hash=f.raw_hash AND n.origin='yaml' AND n.tombstone=0
      WHERE f.project_id=? AND f.environment=? AND f.document_kind=? AND f.document_id=? AND f.raw_hash=? AND f.redacted_hash=? AND f.preparation_key=? LIMIT 1`).get(this.projectId,this.memoryEnvironment,input.document_kind,input.document_id,input.raw_hash,input.redacted_hash,input.preparation_key) as {attributes_json:string}|undefined;
    if(!row)return null;
    try{
      const attributes=JSON.parse(row.attributes_json) as Record<string,unknown>,metadata=attributes?.[NLP_METADATA_KEY] as any;
      return metadata?.protocol===1&&typeof metadata.normalized==='string'&&metadata.normalized.length<=64*1024?metadata.normalized:null;
    }catch{return null;}
  }
  beginMemoryBackfill(pipelineFingerprint:string):string{
    if(!/^[a-f0-9]{64}$/.test(pipelineFingerprint))throw Error('Invalid backfill pipeline fingerprint');
    return this.#database.transaction(()=>{
      const now=new Date().toISOString();
      let job=this.#database.prepare('SELECT id FROM memory_backfill_jobs WHERE project_id=? AND environment=? AND pipeline_fingerprint=?').get(this.projectId,this.memoryEnvironment,pipelineFingerprint) as {id:string}|undefined;
      if(!job){job={id:randomUUID()};this.#database.prepare("INSERT INTO memory_backfill_jobs(id,project_id,environment,pipeline_fingerprint,status,created_at,updated_at) VALUES(?,?,?,?,'running',?,?)").run(job.id,this.projectId,this.memoryEnvironment,pipelineFingerprint,now,now);}
      this.#syncMemoryBackfillItems(job.id,now);
      return job.id;
    })();
  }
  refreshMemoryBackfill(jobId:string):void{
    this.#database.transaction(()=>{
      if(!this.#database.prepare('SELECT 1 FROM memory_backfill_jobs WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,jobId))throw Error('Backfill job not found in this Store environment');
      this.#syncMemoryBackfillItems(jobId,new Date().toISOString());
    })();
  }
  #syncMemoryBackfillItems(jobId:string,now:string):void{
    const nodes=this.#database.prepare('SELECT id,type,stable_key,display_name,attributes_json FROM nodes WHERE project_id=? AND environment=?').all(this.projectId,this.memoryEnvironment) as Array<{id:string;type:string;stable_key:string;display_name:string;attributes_json:string}>;
    const edges=this.#database.prepare('SELECT id,from_node_id,to_node_id,relation_type,attributes_json FROM edges WHERE project_id=? AND environment=?').all(this.projectId,this.memoryEnvironment) as Array<{id:string;from_node_id:string;to_node_id:string;relation_type:string;attributes_json:string}>;
    const upsert=this.#database.prepare(`INSERT INTO memory_backfill_items(project_id,environment,job_id,entity_kind,entity_id,payload_hash,redacted_hash,status,updated_at) VALUES(?,?,?,?,?,?,NULL,'pending',?)
      ON CONFLICT(project_id,environment,job_id,entity_kind,entity_id) DO UPDATE SET payload_hash=excluded.payload_hash,status=CASE WHEN memory_backfill_items.payload_hash=excluded.payload_hash AND memory_backfill_items.status='processed' THEN 'processed' ELSE 'pending' END,updated_at=excluded.updated_at`);
    for(const row of nodes){const value=this.#backfillNodeValue(row);upsert.run(this.projectId,this.memoryEnvironment,jobId,'node',row.id,hashBackfillNode(value),now);}
    for(const row of edges){const value=this.#backfillEdgeValue(row);upsert.run(this.projectId,this.memoryEnvironment,jobId,'edge',row.id,hashBackfillEdge(value),now);}
    this.#database.prepare("UPDATE memory_backfill_items SET status='obsolete',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='node' AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.project_id=memory_backfill_items.project_id AND n.environment=memory_backfill_items.environment AND n.id=memory_backfill_items.entity_id)").run(now,this.projectId,this.memoryEnvironment,jobId);
    this.#database.prepare("UPDATE memory_backfill_items SET status='obsolete',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='edge' AND NOT EXISTS(SELECT 1 FROM edges e WHERE e.project_id=memory_backfill_items.project_id AND e.environment=memory_backfill_items.environment AND e.id=memory_backfill_items.entity_id)").run(now,this.projectId,this.memoryEnvironment,jobId);
    this.#database.prepare("UPDATE memory_backfill_jobs SET status='running',updated_at=?,completed_at=NULL WHERE project_id=? AND environment=? AND id=?").run(now,this.projectId,this.memoryEnvironment,jobId);
  }
  #backfillNodeValue(row:{type:string;stable_key:string;display_name:string;attributes_json:string}):BackfillNodeValue{
    let attributes:unknown;try{attributes=JSON.parse(row.attributes_json);}catch{throw Error('Stored memory record is invalid');}
    return{type:row.type,stable_key:row.stable_key,display_name:row.display_name,attributes:withoutNlpMetadata(attributes)};
  }
  #backfillEdgeValue(row:{from_node_id:string;to_node_id:string;relation_type:string;attributes_json:string}):BackfillEdgeValue{
    let attributes:unknown;try{attributes=JSON.parse(row.attributes_json);}catch{throw Error('Stored memory record is invalid');}
    return{from_id:row.from_node_id,to_id:row.to_node_id,relation:row.relation_type,attributes:withoutNlpMetadata(attributes)};
  }
  setMemoryBackfillRedactedHashes(jobId:string,hashes:BackfillRedactedHash[]):void{
    const update=this.#database.prepare(`UPDATE memory_backfill_items SET status=CASE WHEN status='processed' AND (redacted_hash IS NULL OR redacted_hash<>?) THEN 'pending' ELSE status END,redacted_hash=?,updated_at=?
      WHERE project_id=? AND environment=? AND job_id=? AND entity_kind=? AND entity_id=?`),now=new Date().toISOString();
    this.#database.transaction(()=>{for(const item of hashes){if(!/^[a-f0-9]{64}$/.test(item.redactedHash))throw Error('Invalid redacted backfill fingerprint');update.run(item.redactedHash,item.redactedHash,now,this.projectId,this.memoryEnvironment,jobId,item.entityKind,item.entityId);}})();
  }
  memoryBackfillBatch(jobId:string,limit=10):BackfillRecord[]{
    const cap=Math.max(1,Math.min(50,Math.trunc(limit)));
    if(!this.#database.prepare('SELECT 1 FROM memory_backfill_jobs WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,jobId))throw Error('Backfill job not found in this Store environment');
    const items=this.#database.prepare("SELECT entity_kind,entity_id,payload_hash,redacted_hash FROM memory_backfill_items WHERE project_id=? AND environment=? AND job_id=? AND status='pending' ORDER BY entity_kind,entity_id LIMIT ?").all(this.projectId,this.memoryEnvironment,jobId,cap) as Array<{entity_kind:'node'|'edge';entity_id:string;payload_hash:string;redacted_hash:string|null}>;
    const out:BackfillRecord[]=[];
    for(const item of items){
      if(item.entity_kind==='node'){
        const row=this.#database.prepare('SELECT id,type,stable_key,display_name,attributes_json FROM nodes WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,item.entity_id) as {id:string;type:string;stable_key:string;display_name:string;attributes_json:string}|undefined;
        if(!row){this.#database.prepare("UPDATE memory_backfill_items SET status='obsolete',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='node' AND entity_id=?").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,jobId,item.entity_id);continue;}
        out.push({kind:'node',record:{...this.#backfillNodeValue(row),id:row.id,payloadHash:item.payload_hash,redactedHash:item.redacted_hash??''}});
      }else{
        const row=this.#database.prepare('SELECT id,from_node_id,to_node_id,relation_type,attributes_json FROM edges WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,item.entity_id) as {id:string;from_node_id:string;to_node_id:string;relation_type:string;attributes_json:string}|undefined;
        if(!row){this.#database.prepare("UPDATE memory_backfill_items SET status='obsolete',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='edge' AND entity_id=?").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,jobId,item.entity_id);continue;}
        out.push({kind:'edge',record:{...this.#backfillEdgeValue(row),id:row.id,payloadHash:item.payload_hash,redactedHash:item.redacted_hash??''}});
      }
    }
    return out;
  }
  memoryBackfillRecords(jobId:string,offset=0,limit=50):BackfillRecord[]{
    const cap=Math.max(1,Math.min(50,Math.trunc(limit))),skip=Math.max(0,Math.trunc(offset));
    if(!this.#database.prepare('SELECT 1 FROM memory_backfill_jobs WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,jobId))throw Error('Backfill job not found in this Store environment');
    const items=this.#database.prepare("SELECT entity_kind,entity_id,payload_hash,redacted_hash FROM memory_backfill_items WHERE project_id=? AND environment=? AND job_id=? AND status<>'obsolete' ORDER BY entity_kind,entity_id LIMIT ? OFFSET ?").all(this.projectId,this.memoryEnvironment,jobId,cap,skip) as Array<{entity_kind:'node'|'edge';entity_id:string;payload_hash:string;redacted_hash:string|null}>;
    const out:BackfillRecord[]=[];
    for(const item of items){
      if(item.entity_kind==='node'){
        const row=this.#database.prepare('SELECT id,type,stable_key,display_name,attributes_json FROM nodes WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,item.entity_id) as {id:string;type:string;stable_key:string;display_name:string;attributes_json:string}|undefined;
        if(row)out.push({kind:'node',record:{...this.#backfillNodeValue(row),id:row.id,payloadHash:item.payload_hash,redactedHash:item.redacted_hash??''}});
      }else{
        const row=this.#database.prepare('SELECT id,from_node_id,to_node_id,relation_type,attributes_json FROM edges WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,item.entity_id) as {id:string;from_node_id:string;to_node_id:string;relation_type:string;attributes_json:string}|undefined;
        if(row)out.push({kind:'edge',record:{...this.#backfillEdgeValue(row),id:row.id,payloadHash:item.payload_hash,redactedHash:item.redacted_hash??''}});
      }
    }
    return out;
  }
  finishMemoryBackfill(jobId:string):BackfillSummary{
    const pending=(this.#database.prepare("SELECT count(*) count FROM memory_backfill_items WHERE project_id=? AND environment=? AND job_id=? AND status='pending'").get(this.projectId,this.memoryEnvironment,jobId) as {count:number}).count;
    if(pending===0)this.#database.prepare("UPDATE memory_backfill_jobs SET status='completed',completed_at=COALESCE(completed_at,?),updated_at=? WHERE project_id=? AND environment=? AND id=?").run(new Date().toISOString(),new Date().toISOString(),this.projectId,this.memoryEnvironment,jobId);
    else this.#database.prepare("UPDATE memory_backfill_jobs SET status='running',completed_at=NULL,updated_at=? WHERE project_id=? AND environment=? AND id=?").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,jobId);
    return this.memoryBackfillSummary(jobId);
  }
  interruptMemoryBackfill(jobId:string):void{this.#database.prepare("UPDATE memory_backfill_jobs SET status='interrupted',updated_at=? WHERE project_id=? AND environment=? AND id=? AND status<>'completed'").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,jobId);}
  memoryBackfillSummary(jobId:string):BackfillSummary{
    const job=this.#database.prepare('SELECT id,environment,status FROM memory_backfill_jobs WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,jobId) as {id:string;environment:string;status:BackfillSummary['status']}|undefined;
    if(!job)throw Error('Backfill job not found in this Store environment');
    const counts=this.#database.prepare("SELECT count(*) total,sum(status='processed') processed,sum(status='pending') pending,sum(status='obsolete') obsolete FROM memory_backfill_items WHERE project_id=? AND environment=? AND job_id=?").get(this.projectId,this.memoryEnvironment,jobId) as {total:number;processed:number|null;pending:number|null;obsolete:number|null};
    return{jobId:job.id,environment:job.environment,status:job.status,total:counts.total,processed:counts.processed??0,pending:counts.pending??0,obsolete:counts.obsolete??0};
  }
  #commitBackfillNode(input:BackfillNodeWrite):boolean{
    if(!hasNlpMetadata(input.attributes))throw Error('NLP ingestion is required');
    return this.#database.transaction(()=>{
      const row=this.#database.prepare('SELECT id,type,stable_key,display_name,attributes_json FROM nodes WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,input.id) as {id:string;type:string;stable_key:string;display_name:string;attributes_json:string}|undefined;
      if(!row){this.#database.prepare("UPDATE memory_backfill_items SET status='obsolete',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='node' AND entity_id=?").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,input.jobId,input.id);return false;}
      const currentHash=hashBackfillNode(this.#backfillNodeValue(row));
      if(currentHash!==input.payloadHash){this.#database.prepare("UPDATE memory_backfill_items SET payload_hash=?,status='pending',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='node' AND entity_id=?").run(currentHash,new Date().toISOString(),this.projectId,this.memoryEnvironment,input.jobId,input.id);return false;}
      if(row.type!==input.type||row.stable_key!==input.stable_key)throw Error('Backfill cannot change node identity');
      const safeValue={type:input.type,stable_key:input.stable_key,display_name:input.display_name,attributes:withoutNlpMetadata(input.attributes)},nextHash=hashBackfillNode(safeValue),json=JSON.stringify(input.attributes),now=new Date().toISOString();
      if(nextHash!==input.redactedHash){this.#database.prepare("UPDATE memory_backfill_items SET redacted_hash=?,status='pending',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='node' AND entity_id=?").run(nextHash,now,this.projectId,this.memoryEnvironment,input.jobId,input.id);return false;}
      this.#database.prepare('UPDATE nodes SET display_name=?,attributes_json=?,updated_at=? WHERE project_id=? AND environment=? AND id=?').run(input.display_name,json,now,this.projectId,this.memoryEnvironment,input.id);
      const changed=this.#database.prepare("UPDATE memory_backfill_items SET payload_hash=?,redacted_hash=?,status='processed',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='node' AND entity_id=?").run(nextHash,nextHash,now,this.projectId,this.memoryEnvironment,input.jobId,input.id).changes;
      if(changed!==1)throw Error('Backfill checkpoint was lost');
      return true;
    })();
  }
  #commitBackfillEdge(input:BackfillEdgeWrite):boolean{
    if(!hasNlpMetadata(input.attributes))throw Error('NLP ingestion is required');
    return this.#database.transaction(()=>{
      const row=this.#database.prepare('SELECT id,from_node_id,to_node_id,relation_type,attributes_json FROM edges WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,input.id) as {id:string;from_node_id:string;to_node_id:string;relation_type:string;attributes_json:string}|undefined;
      if(!row){this.#database.prepare("UPDATE memory_backfill_items SET status='obsolete',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='edge' AND entity_id=?").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,input.jobId,input.id);return false;}
      const currentHash=hashBackfillEdge(this.#backfillEdgeValue(row));
      if(currentHash!==input.payloadHash){this.#database.prepare("UPDATE memory_backfill_items SET payload_hash=?,status='pending',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='edge' AND entity_id=?").run(currentHash,new Date().toISOString(),this.projectId,this.memoryEnvironment,input.jobId,input.id);return false;}
      if(row.from_node_id!==input.from_id||row.to_node_id!==input.to_id||row.relation_type!==input.relation)throw Error('Backfill cannot change edge identity');
      const safeValue={from_id:input.from_id,to_id:input.to_id,relation:input.relation,attributes:withoutNlpMetadata(input.attributes)},nextHash=hashBackfillEdge(safeValue),json=JSON.stringify(input.attributes),now=new Date().toISOString();
      if(nextHash!==input.redactedHash){this.#database.prepare("UPDATE memory_backfill_items SET redacted_hash=?,status='pending',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='edge' AND entity_id=?").run(nextHash,now,this.projectId,this.memoryEnvironment,input.jobId,input.id);return false;}
      this.#database.prepare('UPDATE edges SET attributes_json=?,updated_at=? WHERE project_id=? AND environment=? AND id=?').run(json,now,this.projectId,this.memoryEnvironment,input.id);
      const changed=this.#database.prepare("UPDATE memory_backfill_items SET payload_hash=?,redacted_hash=?,status='processed',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='edge' AND entity_id=?").run(nextHash,nextHash,now,this.projectId,this.memoryEnvironment,input.jobId,input.id).changes;
      if(changed!==1)throw Error('Backfill checkpoint was lost');
      return true;
    })();
  }
    listEdges(nodeId?:string){return nodeId?this.#database.prepare('SELECT * FROM edges WHERE project_id=? AND environment=? AND tombstone=0 AND (from_node_id=? OR to_node_id=?)').all(this.projectId,this.memoryEnvironment,nodeId,nodeId):this.#database.prepare('SELECT * FROM edges WHERE project_id=? AND environment=? AND tombstone=0').all(this.projectId,this.memoryEnvironment);}
  neighbors(nodeId:string,limit=50){return this.#database.prepare('SELECT n.* FROM edges e JOIN nodes n ON n.project_id=e.project_id AND n.environment=e.environment AND n.id=CASE WHEN e.from_node_id=? THEN e.to_node_id ELSE e.from_node_id END WHERE e.project_id=? AND e.environment=? AND e.tombstone=0 AND (e.from_node_id=? OR e.to_node_id=?) AND n.tombstone=0 LIMIT ?').all(nodeId,this.projectId,this.memoryEnvironment,nodeId,nodeId,Math.max(0,Math.min(200,limit)));}
  listConflicts(){return this.#database.prepare(`SELECT 'node' kind,id,canonical_key entity_key,conflict_status FROM nodes WHERE project_id=? AND environment=? AND conflict_status<>'none' UNION ALL SELECT 'edge',id,relation_type,conflict_status FROM edges WHERE project_id=? AND environment=? AND conflict_status<>'none' UNION ALL SELECT 'yaml',entity_id,entity_key,conflict_status FROM yaml_ownership WHERE project_id=? AND environment=? AND conflict_status<>'none'`).all(this.projectId,this.memoryEnvironment,this.projectId,this.memoryEnvironment,this.projectId,this.memoryEnvironment);}
  tombstoneEdge(id:string){return this.#database.prepare('UPDATE edges SET tombstone=1,updated_at=? WHERE project_id=? AND environment=? AND id=?').run(new Date().toISOString(),this.projectId,this.memoryEnvironment,id).changes>0;}
  path(from:string,to:string,maxDepth=5){if(!this.get(from)||!this.get(to))return null;const cap=Math.max(0,Math.min(10,maxDepth));const q:{id:string;path:string[]}[]=[{id:from,path:[from]}];const seen=new Set([from]);while(q.length){const cur=q.shift()!;if(cur.id===to)return cur.path;if(cur.path.length>cap)continue;for(const n of this.neighbors(cur.id,200) as {id:string}[])if(!seen.has(n.id)){seen.add(n.id);q.push({id:n.id,path:[...cur.path,n.id]});}}return null;}
    applicationSubject(){return this.#database.prepare("SELECT id FROM nodes WHERE project_id=? AND environment=? AND type='application' AND tombstone=0 ORDER BY id LIMIT 1").get(this.projectId,this.memoryEnvironment) as {id:string}|undefined;}
    createRun(sessionId='',workflowId:string|null=null,environment:unknown={},workflowSnapshotHash?:string){
    if(workflowSnapshotHash!==undefined&&!/^[a-f0-9]{64}$/.test(workflowSnapshotHash))throw Error('Invalid workflow snapshot hash');
    const id=randomUUID(),now=new Date().toISOString(),env=JSON.stringify(environment);
    if(env.length>1024)throw Error('Run environment too large');
    this.#database.prepare('INSERT INTO runs(id,project_id,status,created_at,finished_at,session_id,workflow_id,started_at,environment_json,workflow_snapshot_hash,memory_environment) VALUES(?,?,?, ?,NULL,?,?,?,?,?,?)').run(id,this.projectId,'running',now,sessionId.slice(0,200),workflowId,now,env,workflowSnapshotHash??null,this.memoryEnvironment);
    return id;
  }
  currentYamlWorkflow(workflowId:string){
    return this.#database.prepare(`SELECT n.id,n.display_name,n.attributes_json,n.content_hash,n.conflict_status,n.origin,n.verification_status,y.source_path,y.hash source_hash,ys.hash source_row_hash FROM nodes n JOIN yaml_ownership y ON y.project_id=n.project_id AND y.environment=n.environment AND y.entity_id=n.id AND y.entity_type='workflow' AND y.entity_key=? AND y.tombstone=0 JOIN yaml_sources ys ON ys.project_id=y.project_id AND ys.environment=y.environment AND ys.path=y.source_path AND ys.active=1 WHERE n.project_id=? AND n.environment=? AND n.type='workflow' AND n.origin='yaml' AND n.tombstone=0 AND n.conflict_status='none' AND y.conflict_status='none' AND n.content_hash IS NOT NULL LIMIT 1`).get(workflowId,this.projectId,this.memoryEnvironment) as any??null;
  }
  workflowSnapshotHash(workflowId:string){
    const node=this.currentYamlWorkflow(workflowId);
    if(!node||!/^[a-f0-9]{64}$/.test(node.content_hash)||node.source_hash!==node.content_hash||node.source_row_hash!==node.content_hash)return null;
    const rows=this.#database.prepare('SELECT path,hash FROM yaml_sources WHERE project_id=? AND environment=? AND active=1 ORDER BY path COLLATE BINARY').all(this.projectId,this.memoryEnvironment) as Array<{path:string;hash:string}>;
    if(!rows.length||!rows.some(row=>row.path===node.source_path&&row.hash===node.content_hash)||rows.some(row=>typeof row.path!=='string'||!row.path||typeof row.hash!=='string'||!/^[a-f0-9]{64}$/.test(row.hash)))return null;
    return createHash('sha256').update(JSON.stringify(rows.map(row=>[row.path,row.hash]))).digest('hex');
  }
  workflowExportEligibility(workflowId:string,runId:string){
    const node=this.currentYamlWorkflow(workflowId),snapshotHash=this.workflowSnapshotHash(workflowId);
    if(!node||!snapshotHash)return null;
    const run=this.#database.prepare('SELECT id,status,workflow_id,workflow_snapshot_hash FROM runs WHERE project_id=? AND memory_environment=? AND id=?').get(this.projectId,this.memoryEnvironment,runId) as any;
    if(!run||run.workflow_id!==node.id||run.status!=='passed'||run.workflow_snapshot_hash!==snapshotHash)return null;
    const evidence=this.#database.prepare("SELECT 1 FROM evidence WHERE project_id=? AND run_id=? AND subject_node_id=? AND kind='workflow' AND outcome='passed' LIMIT 1").get(this.projectId,runId,node.id);
    return evidence?{workflowId:node.id,name:node.display_name,snapshotHash,contentHash:snapshotHash,runId:run.id}:null;
  }
  verifyWorkflowExport(workflowId:string,runId:string){return this.#database.transaction(()=>{const eligible=this.workflowExportEligibility(workflowId,runId);if(!eligible)return false;this.#database.prepare('INSERT INTO workflow_export_verifications(project_id,workflow_node_id,snapshot_hash,run_id,verified_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id,workflow_node_id,snapshot_hash) DO UPDATE SET run_id=excluded.run_id,verified_at=excluded.verified_at').run(this.projectId,eligible.workflowId,eligible.snapshotHash,eligible.runId,new Date().toISOString());return true;})();}
    hasWorkflowExportVerification(workflowId:string){const node=this.currentYamlWorkflow(workflowId),snapshotHash=this.workflowSnapshotHash(workflowId);if(!node||!snapshotHash)return false;return Boolean(this.#database.prepare(`SELECT 1 FROM workflow_export_verifications v JOIN runs r ON r.project_id=v.project_id AND r.id=v.run_id WHERE v.project_id=? AND v.workflow_node_id=? AND v.snapshot_hash=? AND r.memory_environment=? AND r.workflow_id=v.workflow_node_id AND r.workflow_snapshot_hash=v.snapshot_hash AND r.status='passed' AND EXISTS(SELECT 1 FROM evidence e WHERE e.project_id=v.project_id AND e.run_id=v.run_id AND e.subject_node_id=v.workflow_node_id AND e.kind='workflow' AND e.outcome='passed')`).get(this.projectId,node.id,snapshotHash,this.memoryEnvironment));}
  finishRun(id:string,status='finished'){return this.#database.prepare('UPDATE runs SET status=?,finished_at=? WHERE id=? AND project_id=? AND memory_environment=?').run(status,new Date().toISOString(),id,this.projectId,this.memoryEnvironment).changes>0;}
   addEvidence(input:{run_id:string;subject_node_id:string;kind:string;outcome:string;metadata?:unknown;artifact_ref?:string}){
    const id=randomUUID(),metadata=JSON.stringify(input.metadata??{});
    if(metadata.length>4096||input.kind.length>100||input.outcome.length>100||input.artifact_ref&&input.artifact_ref.length>1000)throw Error('Evidence field too long');
    const run=this.#database.prepare('SELECT 1 FROM runs WHERE project_id=? AND memory_environment=? AND id=?').get(this.projectId,this.memoryEnvironment,input.run_id),subject=this.#database.prepare('SELECT 1 FROM nodes WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,input.subject_node_id);
    if(!run||!subject)throw Error('Evidence run and subject must belong to this Store environment');
    this.#database.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?)').run(id,this.projectId,input.run_id,input.subject_node_id,input.kind,input.outcome,metadata,input.artifact_ref??null,new Date().toISOString());
    return this.#database.prepare('SELECT * FROM evidence WHERE id=?').get(id) as Evidence;
  }
  recordAssertion(input:{session_id:string;subject_node_id:string;passed:boolean;observed_count:number;artifact_ref?:string|null;actions?:unknown}){return this.#database.transaction(()=>{if(!this.get(input.subject_node_id))throw Error('Assertion subject must belong to this Store environment');const id=this.createRun(input.session_id),metadata=JSON.stringify({observed_count:input.observed_count,actions:input.actions??[]});if(metadata.length>4096)throw Error('Evidence metadata too large');const evidenceId=randomUUID(),now=new Date().toISOString();this.#database.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?)').run(evidenceId,this.projectId,id,input.subject_node_id,'assertion',input.passed?'passed':'failed',metadata,input.artifact_ref??null,now);this.finishRun(id,input.passed?'passed':'failed');return{id,evidence:this.#database.prepare('SELECT * FROM evidence WHERE id=?').get(evidenceId)};})();}
    addAssertionDiagnostics(input:{runId:string;evidenceId:string;roleCounts:Record<string,number>;capture:{status:'captured'|'failed';code?:string}}){
      if(!input||typeof input.runId!=='string'||!input.runId||typeof input.evidenceId!=='string'||!input.evidenceId)throw Error('Invalid assertion evidence identity');
      if(!input.capture||!['captured','failed'].includes(input.capture.status)||input.capture.status==='captured'&&(input.capture.code!==undefined||Object.keys(input.capture).some(key=>key!=='status'))||input.capture.status==='failed'&&(Object.keys(input.capture).some(key=>key!=='status'&&key!=='code')||!ASSERTION_CAPTURE_CODES.has(input.capture.code??'')))throw Error('Invalid assertion capture diagnostics');
      if(!input.roleCounts||typeof input.roleCounts!=='object'||Array.isArray(input.roleCounts)||Object.keys(input.roleCounts).length>30)throw Error('Invalid assertion role diagnostics');
      const roleCounts:Record<string,number>={};for(const [role,count] of Object.entries(input.roleCounts)){if(!/^[a-z_-]{1,30}$/i.test(role)||!Number.isInteger(count)||count<0||count>10000)throw Error('Invalid assertion role diagnostics');roleCounts[role]=count;}
       return this.#database.transaction(()=>{const row=this.#database.prepare("SELECT e.metadata_json FROM evidence e JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id WHERE e.project_id=? AND r.memory_environment=? AND e.run_id=? AND e.id=? AND e.kind='assertion' AND e.outcome='failed'").get(this.projectId,this.memoryEnvironment,input.runId,input.evidenceId) as {metadata_json:string}|undefined;if(!row)throw Error('Failed assertion evidence not found in this project and run');const metadata=this.safeReportMetadata('assertion',row.metadata_json);if(!metadata)throw Error('Invalid assertion evidence metadata');const augmented={...metadata,role_counts:roleCounts,capture:input.capture};const json=JSON.stringify(augmented);if(json.length>4096)throw Error('Evidence metadata too large');const changed=this.#database.prepare("UPDATE evidence SET metadata_json=? WHERE project_id=? AND run_id=? AND id=? AND kind='assertion' AND outcome='failed' AND EXISTS(SELECT 1 FROM runs r WHERE r.project_id=evidence.project_id AND r.id=evidence.run_id AND r.memory_environment=?)").run(json,this.projectId,input.runId,input.evidenceId,this.memoryEnvironment).changes;if(changed!==1)throw Error('Failed assertion evidence not found in this project and run');return this.#database.prepare('SELECT * FROM evidence WHERE project_id=? AND run_id=? AND id=?').get(this.projectId,input.runId,input.evidenceId);})();
    }
    createWorkflowStepAttempt(input:{runId:string;stepId:string;ordinal:number;attempt:number;action:string;startedAt?:string}){if(typeof input.stepId!=='string'||input.stepId.length<1||input.stepId.length>100)throw Error('Invalid workflow step id');if(!Number.isInteger(input.ordinal)||input.ordinal<0||input.ordinal>101)throw Error('Invalid workflow step ordinal');if(!Number.isInteger(input.attempt)||input.attempt<1||input.attempt>3)throw Error('Invalid workflow attempt');if(!WORKFLOW_ACTIONS.has(input.action))throw Error('Invalid workflow action');const startedAt=input.startedAt??new Date().toISOString();if(typeof startedAt!=='string'||!isWorkflowTimestamp(startedAt))throw Error('Invalid workflow start timestamp');return this.#database.transaction(()=>{this.requireRunningRun(input.runId);this.#database.prepare("INSERT INTO workflow_step_attempts(project_id,run_id,step_id,ordinal,attempt,action,status,started_at) VALUES(?,?,?,?,?,?,'running',?)").run(this.projectId,input.runId,input.stepId,input.ordinal,input.attempt,input.action,startedAt);return this.#database.prepare('SELECT * FROM workflow_step_attempts WHERE project_id=? AND run_id=? AND step_id=? AND attempt=?').get(this.projectId,input.runId,input.stepId,input.attempt);})();}
    createWorkflowLocatorProposal(input:{runId:string;workflowNodeId:string;workflowId:string;stepId:string;screenId:string;elementId:string;screenNodeId:string;elementNodeId:string;sourcePath:string;sourceHash:string;baselineHash:string;previousLocator:unknown;fallbackHistory:unknown[];candidateLocator:unknown;reasonCode:'target_invalid'}){
    const id=randomUUID(),now=new Date().toISOString();
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(input.workflowId)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(input.stepId)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(input.screenId)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(input.elementId))throw Error('Invalid workflow proposal identity');
    if(!input.sourcePath||input.sourcePath.length>1024||path.isAbsolute(input.sourcePath)||path.win32.isAbsolute(input.sourcePath)||input.sourcePath.split(/[\\/]/).some(part=>!part||part==='..'))throw Error('Invalid workflow proposal source path');
    if(!/^[a-f0-9]{64}$/.test(input.sourceHash)||!/^[a-f0-9]{64}$/.test(input.baselineHash)||input.reasonCode!=='target_invalid')throw Error('Invalid workflow proposal provenance');
    const previous=JSON.stringify(normalizeLocator(input.previousLocator)),candidate=JSON.stringify(normalizeLocator(input.candidateLocator));
    if(!Array.isArray(input.fallbackHistory)||input.fallbackHistory.length>8)throw Error('Invalid workflow fallback history');
    const history=JSON.stringify(input.fallbackHistory.map(normalizeLocator));
    if(previous.length>1500||candidate.length>1500||history.length>12000)throw Error('Workflow locator proposal is too large');
    return this.#database.transaction(()=>{
      this.requireRunningRun(input.runId);
      const expectedCanonical:{workflow:string;screen:string;element:string}={workflow:input.workflowId,screen:input.screenId,element:`screen:${input.screenId}/${input.elementId}`};
      for(const [nodeId,type,canonical] of [[input.workflowNodeId,'workflow',expectedCanonical.workflow],[input.screenNodeId,'screen',expectedCanonical.screen],[input.elementNodeId,'ui_element',expectedCanonical.element]] as const){
        const node=this.#database.prepare('SELECT type,origin,canonical_key FROM nodes WHERE project_id=? AND environment=? AND id=? AND tombstone=0').get(this.projectId,this.memoryEnvironment,nodeId) as any;
        if(!node||node.type!==type||node.origin!=='yaml'||node.canonical_key!==canonical)throw Error('Workflow proposal nodes must match active YAML identities in this environment');
      }
      const owner=this.#database.prepare("SELECT source_path,hash FROM yaml_ownership WHERE project_id=? AND environment=? AND entity_id=? AND entity_type='ui_element' AND tombstone=0 ORDER BY source_path LIMIT 1").get(this.projectId,this.memoryEnvironment,input.elementNodeId) as any;
      if(!owner||owner.source_path!==input.sourcePath||owner.hash!==input.sourceHash)throw Error('Workflow proposal source ownership changed');
      this.#database.prepare(`INSERT INTO workflow_locator_proposals(id,project_id,run_id,workflow_node_id,workflow_id,step_id,screen_id,element_id,screen_node_id,element_node_id,source_path,source_hash,baseline_hash,previous_locator_json,fallback_history_json,candidate_locator_json,reason_code,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'target_invalid','pending',?,?)`).run(id,this.projectId,input.runId,input.workflowNodeId,input.workflowId,input.stepId,input.screenId,input.elementId,input.screenNodeId,input.elementNodeId,input.sourcePath,input.sourceHash,input.baselineHash,previous,history,candidate,now,now);
      return this.getWorkflowLocatorProposal(id);
    })();
  }
    getWorkflowLocatorProposal(id:string){return this.#database.prepare('SELECT p.* FROM workflow_locator_proposals p JOIN runs r ON r.project_id=p.project_id AND r.id=p.run_id WHERE p.project_id=? AND r.memory_environment=? AND p.id=?').get(this.projectId,this.memoryEnvironment,id)??null;}
  listWorkflowLocatorProposals(status?:'pending'|'accepted'|'rejected'|'stale'){
    return status
      ?this.#database.prepare('SELECT p.* FROM workflow_locator_proposals p JOIN runs r ON r.project_id=p.project_id AND r.id=p.run_id WHERE p.project_id=? AND r.memory_environment=? AND p.status=? ORDER BY p.created_at DESC,p.id DESC LIMIT 200').all(this.projectId,this.memoryEnvironment,status)
      :this.#database.prepare('SELECT p.* FROM workflow_locator_proposals p JOIN runs r ON r.project_id=p.project_id AND r.id=p.run_id WHERE p.project_id=? AND r.memory_environment=? ORDER BY p.created_at DESC,p.id DESC LIMIT 200').all(this.projectId,this.memoryEnvironment);
  }
  setWorkflowLocatorProposalStatus(id:string,status:'accepted'|'rejected'|'stale'){
    if(!['accepted','rejected','stale'].includes(status))throw Error('Invalid workflow proposal status');
    const changed=this.#database.prepare("UPDATE workflow_locator_proposals SET status=?,updated_at=? WHERE project_id=? AND id=? AND status='pending' AND EXISTS(SELECT 1 FROM runs r WHERE r.project_id=workflow_locator_proposals.project_id AND r.id=workflow_locator_proposals.run_id AND r.memory_environment=?)").run(status,new Date().toISOString(),this.projectId,id,this.memoryEnvironment).changes;
    if(!changed){const row=this.getWorkflowLocatorProposal(id) as any;if(row?.status===status)return row;throw Error('Workflow proposal is not pending in this Store environment');}
    return this.getWorkflowLocatorProposal(id);
  }
  inactiveWorkflowLocator(input:{screenId:string;elementId:string;currentLocator:unknown}){
    let candidate:string;try{candidate=JSON.stringify(normalizeLocator(input.currentLocator));}catch{return undefined;}
    const row=this.#database.prepare('SELECT p.status,p.previous_locator_json FROM workflow_locator_proposals p JOIN runs r ON r.project_id=p.project_id AND r.id=p.run_id WHERE p.project_id=? AND r.memory_environment=? AND p.screen_id=? AND p.element_id=? AND p.candidate_locator_json=? ORDER BY p.created_at DESC,p.id DESC LIMIT 1').get(this.projectId,this.memoryEnvironment,input.screenId,input.elementId,candidate) as {status:string;previous_locator_json:string}|undefined;
    if(!row||!['pending','rejected','stale'].includes(row.status))return undefined;
    try{return normalizeLocator(JSON.parse(row.previous_locator_json));}catch{return undefined;}
  }
  finishWorkflowStepAttempt(input:{runId:string;stepId:string;attempt:number;status:'passed'|'failed'|'interrupted';finishedAt?:string;durationMs:number;errorCode?:string;assertionPassed?:boolean;observedCount?:number;artifactRef?:string|null}){if(typeof input.stepId!=='string'||input.stepId.length<1||input.stepId.length>100)throw Error('Invalid workflow step id');if(!Number.isInteger(input.attempt)||input.attempt<1||input.attempt>3)throw Error('Invalid workflow attempt');if(!['passed','failed','interrupted'].includes(input.status))throw Error('Invalid workflow terminal status');if(!Number.isInteger(input.durationMs)||input.durationMs<0||input.durationMs>10000000)throw Error('Invalid workflow duration');if(input.errorCode!==undefined&&!WORKFLOW_ERROR_CODES.has(input.errorCode))throw Error('Invalid workflow error code');if(input.assertionPassed!==undefined&&typeof input.assertionPassed!=='boolean')throw Error('Invalid workflow assertion result');if(input.observedCount!==undefined&&(!Number.isInteger(input.observedCount)||input.observedCount<0||input.observedCount>100000))throw Error('Invalid workflow observed count');if(input.artifactRef!==undefined&&input.artifactRef!==null&&(typeof input.artifactRef!=='string'||input.artifactRef.length>1000))throw Error('Invalid workflow artifact reference');const finishedAt=input.finishedAt??new Date().toISOString();if(typeof finishedAt!=='string'||!isWorkflowTimestamp(finishedAt))throw Error('Invalid workflow finish timestamp');return this.#database.transaction(()=>{this.requireRunningRun(input.runId);const result=this.#database.prepare("UPDATE workflow_step_attempts SET status=?,finished_at=?,duration_ms=?,error_code=?,assertion_passed=?,observed_count=?,artifact_ref=? WHERE project_id=? AND run_id=? AND step_id=? AND attempt=? AND status='running'").run(input.status,finishedAt,input.durationMs,input.errorCode??null,input.assertionPassed===undefined?null:Number(input.assertionPassed),input.observedCount??null,input.artifactRef??null,this.projectId,input.runId,input.stepId,input.attempt);if(result.changes!==1)throw Error('Workflow step attempt is not running');return this.#database.prepare('SELECT * FROM workflow_step_attempts WHERE project_id=? AND run_id=? AND step_id=? AND attempt=?').get(this.projectId,input.runId,input.stepId,input.attempt);})();}
    private requireRunningRun(runId:string){if(typeof runId!=='string'||!runId)throw Error('Invalid run id');if(!this.#database.prepare("SELECT 1 FROM runs WHERE project_id=? AND memory_environment=? AND id=? AND status='running'").get(this.projectId,this.memoryEnvironment,runId))throw Error('Run is not running in this Store environment');}
     getRunReport(id:string){
    const run=this.#database.prepare('SELECT id,project_id,status,session_id,workflow_id,started_at,created_at,finished_at,memory_environment FROM runs WHERE project_id=? AND memory_environment=? AND id=?').get(this.projectId,this.memoryEnvironment,id);
    if(!run)return null;
    const rows=this.#database.prepare('SELECT id,subject_node_id,kind,outcome,metadata_json,artifact_ref,created_at FROM evidence WHERE project_id=? AND run_id=?').all(this.projectId,id) as Array<{kind:string;metadata_json:string;[key:string]:unknown}>;
    const evidence=rows.map(({metadata_json,...entry})=>({...entry,...(this.safeReportMetadata(entry.kind,metadata_json)?{metadata:this.safeReportMetadata(entry.kind,metadata_json)}:{})}));
    const stepAttempts=this.#database.prepare('SELECT step_id stepId,ordinal,attempt,action,status,started_at startedAt,finished_at finishedAt,duration_ms durationMs,error_code errorCode,assertion_passed assertionPassed,observed_count observedCount,artifact_ref artifactRef FROM workflow_step_attempts WHERE project_id=? AND run_id=? ORDER BY ordinal,attempt LIMIT 302').all(this.projectId,id);
    return{run,evidence,stepAttempts};
  }
  private safeReportMetadata(kind:string,json:string):Record<string,unknown>|null{let value:unknown;try{value=JSON.parse(json);}catch{return null;}if(!value||typeof value!=='object'||Array.isArray(value))return null;const m=value as Record<string,unknown>;const boundedInt=(v:unknown,min=0,max=10000000):v is number=>Number.isInteger(v)&&Number(v)>=min&&Number(v)<=max;if(kind==='outcome'){const out:Record<string,unknown>={};if(['local','staging','production'].includes(String(m.environment)))out.environment=m.environment;if(['chromium','firefox','webkit'].includes(String(m.browser)))out.browser=m.browser;if(boundedInt(m.duration_ms))out.duration_ms=m.duration_ms;if(boundedInt(m.attempt,1,100))out.attempt=m.attempt;return out;}if(kind!=='assertion')return null;const out:Record<string,unknown>={};if(boundedInt(m.observed_count))out.observed_count=m.observed_count;if(Array.isArray(m.actions))out.actions=m.actions.slice(0,30).flatMap((item)=>{if(!item||typeof item!=='object'||Array.isArray(item))return[];const a=item as Record<string,unknown>;if(typeof a.action!=='string'||a.action.length>50||!boundedInt(a.at))return[];const clean:Record<string,unknown>={action:a.action,at:a.at};if(['role','label','text','placeholder','testid','css'].includes(String(a.target_by)))clean.target_by=a.target_by;if(boundedInt(a.revision))clean.revision=a.revision;return[clean];});if(m.role_counts&&typeof m.role_counts==='object'&&!Array.isArray(m.role_counts)){const counts:Record<string,number>={};for(const [role,count] of Object.entries(m.role_counts as Record<string,unknown>).slice(0,30))if(/^[a-z_-]{1,30}$/i.test(role)&&boundedInt(count,0,10000))counts[role]=count;out.role_counts=counts;}return out;}
  readEvidence(nodeId:string,runId?:string){
    return runId
      ?this.#database.prepare('SELECT e.* FROM evidence e JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id JOIN nodes n ON n.project_id=e.project_id AND n.id=e.subject_node_id WHERE e.project_id=? AND r.memory_environment=? AND n.environment=? AND e.subject_node_id=? AND e.run_id=?').all(this.projectId,this.memoryEnvironment,this.memoryEnvironment,nodeId,runId)
      :this.#database.prepare('SELECT e.* FROM evidence e JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id JOIN nodes n ON n.project_id=e.project_id AND n.id=e.subject_node_id WHERE e.project_id=? AND r.memory_environment=? AND n.environment=? AND e.subject_node_id=?').all(this.projectId,this.memoryEnvironment,this.memoryEnvironment,nodeId);
  }
  verify(id:string,runId:string){
    return this.#database.transaction(()=>{
      const ev=this.#database.prepare("SELECT 1 FROM evidence e JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id JOIN nodes n ON n.project_id=e.project_id AND n.id=e.subject_node_id WHERE e.project_id=? AND r.memory_environment=? AND n.environment=? AND e.subject_node_id=? AND e.run_id=? AND e.kind='assertion' AND e.outcome='passed' LIMIT 1").get(this.projectId,this.memoryEnvironment,this.memoryEnvironment,id,runId);
      if(!ev)return false;
      const changed=this.#database.prepare("UPDATE nodes SET verification_status='verified',confidence=1,updated_at=? WHERE project_id=? AND environment=? AND id=? AND origin='agent' AND verification_status='proposed'").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,id).changes;
      if(changed)this.#database.prepare('INSERT INTO memory_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),this.projectId,id,'verify',JSON.stringify({runId}),new Date().toISOString());
      return changed>0;
    })();
  }
  supersede(oldId:string,newId:string){
    return this.#database.transaction(()=>{
      if(!this.get(newId))throw Error('Replacement node must belong to this Store environment');
      const changed=this.#database.prepare('UPDATE nodes SET tombstone=1,superseded_by=?,updated_at=? WHERE project_id=? AND environment=? AND id=? AND id<>?').run(newId,new Date().toISOString(),this.projectId,this.memoryEnvironment,oldId,newId).changes;
      if(changed)this.#database.prepare('INSERT INTO memory_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),this.projectId,oldId,'supersede',JSON.stringify({newId}),new Date().toISOString());
      return changed>0;
    })();
  }
  recallWorkflowCandidates(context:WorkflowRecallContext){
     const cap=Math.max(1,Math.min(3,Math.trunc(context.limit??3))),goalTokens=new Set((context.goal.slice(0,500).toLowerCase().match(/[a-z0-9_-]+/g)??[]));
     let pathname='/';try{pathname=new URL(context.currentUrl).pathname.replace(/\/$/,'')||'/';}catch{}
     type Screen={id:string;canonical_key:string;stable_key:string;display_name:string;attributes_json:string;tombstone:number};
      const screens=this.#database.prepare("SELECT id,canonical_key,stable_key,display_name,attributes_json,tombstone FROM nodes WHERE project_id=? AND environment=? AND type='screen' AND tombstone=0 AND conflict_status='none' AND verification_status<>'stale'").all(this.projectId,this.memoryEnvironment) as Screen[];
     const byRef=new Map<string,Screen>();for(const screen of screens)for(const key of [screen.id,screen.canonical_key,screen.stable_key,`screen:${screen.canonical_key}`,`screen:${screen.stable_key}`])byRef.set(key,screen);
     const resolve=(key:unknown):Screen|undefined=>typeof key==='string'?byRef.get(key)??byRef.get(key.replace(/^screen:/,'')):undefined;
     const routes:Array<{path:string;screen:Screen}>=[];
     for(const screen of screens){let attrs:any={};try{attrs=JSON.parse(screen.attributes_json);}catch{}if(typeof attrs.route==='string'&&attrs.route.startsWith('/'))routes.push({path:attrs.route,screen});}
      const app=this.#database.prepare("SELECT attributes_json FROM nodes WHERE project_id=? AND environment=? AND type='application' AND tombstone=0 ORDER BY id LIMIT 1").get(this.projectId,this.memoryEnvironment) as {attributes_json:string}|undefined;
     try{for(const route of JSON.parse(app?.attributes_json??'{}').route_patterns??[]){const screen=resolve(route.screen);if(screen&&typeof route.path==='string'&&route.path.startsWith('/'))routes.push({path:route.path,screen});}}catch{}
     const matches=(pattern:string)=>{const re=pattern.split('/').map(x=>x.startsWith(':')?'[^/]+':x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('/');return new RegExp(`^${re}/?$`).test(pathname);};
     const route=routes.filter(x=>matches(x.path)).sort((a,b)=>b.path.length-a.path.length||a.screen.canonical_key.localeCompare(b.screen.canonical_key))[0];
     const current=route?.screen;
      const rows=this.#database.prepare(`SELECT e.from_node_id,e.to_node_id,f.type from_type,t.type to_type FROM edges e JOIN nodes f ON f.project_id=e.project_id AND f.environment=e.environment AND f.id=e.from_node_id JOIN nodes t ON t.project_id=e.project_id AND t.environment=e.environment AND t.id=e.to_node_id WHERE e.project_id=? AND e.environment=? AND e.tombstone=0 AND e.conflict_status='none' AND e.verification_status<>'stale' AND f.tombstone=0 AND t.tombstone=0 AND f.conflict_status='none' AND t.conflict_status='none' AND ((e.relation_type='TRIGGERED_BY' AND f.type='screen' AND t.type='action') OR (e.relation_type='NAVIGATES_TO' AND ((f.type='action' AND t.type='screen') OR (f.type='screen' AND t.type='screen')))) ORDER BY e.from_node_id,e.relation_type,e.to_node_id,e.id`).all(this.projectId,this.memoryEnvironment) as Array<{from_node_id:string;to_node_id:string;from_type:string;to_type:string}>;
      const adjacency=new Map<string,Array<{id:string;type:string}>>();for(const edge of rows){const list=adjacency.get(edge.from_node_id)??[];list.push({id:edge.to_node_id,type:edge.to_type});adjacency.set(edge.from_node_id,list);}
      const findPath=(from:string,to:string)=>{if(from===to)return{screens:[from],actions:[] as string[],length:0};const queue:Array<{id:string;screens:string[];actions:string[];depth:number}>=[{id:from,screens:[from],actions:[],depth:0}],seen=new Set([from]);let visited=0;while(queue.length&&visited<500){const cur=queue.shift()!;visited++;if(cur.depth>=5)continue;for(const next of adjacency.get(cur.id)??[]){if(++visited>500)return null;if(next.type==='screen'){if(seen.has(next.id))continue;const screenPath=[...cur.screens,next.id],depth=cur.depth+1;if(next.id===to)return{screens:screenPath,actions:cur.actions,length:depth};seen.add(next.id);queue.push({id:next.id,screens:screenPath,actions:cur.actions,depth});continue;}if(next.type!=='action')continue;for(const dest of adjacency.get(next.id)??[]){if(++visited>500)return null;if(dest.type!=='screen'||seen.has(dest.id))continue;const screensPath=[...cur.screens,dest.id],actionsPath=[...cur.actions,next.id],depth=cur.depth+1;if(dest.id===to)return{screens:screensPath,actions:actionsPath,length:depth};seen.add(dest.id);queue.push({id:dest.id,screens:screensPath,actions:actionsPath,depth});}}}return null;};
      const rowsW=this.#database.prepare("SELECT n.*,y.source_path FROM nodes n JOIN yaml_ownership y ON y.project_id=n.project_id AND y.environment=n.environment AND y.entity_id=n.id AND y.entity_type='workflow' AND y.tombstone=0 JOIN yaml_sources ys ON ys.project_id=y.project_id AND ys.environment=y.environment AND ys.path=y.source_path AND ys.active=1 WHERE n.project_id=? AND n.environment=? AND n.type='workflow' AND n.origin='yaml' AND n.tombstone=0 AND n.conflict_status='none' AND n.verification_status<>'stale' ORDER BY n.id LIMIT 500").all(this.projectId,this.memoryEnvironment) as Array<RecallNode&{source_path:string}>;
     const candidates:any[]=[];
     for(const node of rowsW){let wf:any;try{wf=JSON.parse(node.attributes_json);}catch{continue;}if(!Array.isArray(wf.steps))continue;
        const reqRole=wf.requires?.role,envs:Array<string>=Array.isArray(wf.requires?.environment)?wf.requires.environment:[],normalizeRole=(value:string)=>value.replace(/^role:/,'');if(reqRole&&context.role&&normalizeRole(reqRole)!==normalizeRole(context.role))continue;if(context.environment&&envs.length&&!envs.includes(context.environment))continue;
       const start=resolve(wf.start_screen),end=resolve(wf.end_screen),pathInfo=current&&start?findPath(current.id,start.id):null;
       const tokens=new Set<string>([String(wf.id??node.canonical_key),String(wf.name??node.display_name)].flatMap(x=>x.toLowerCase().match(/[a-z0-9_-]+/g)??[]));
       const addScreenTerms=(screen:Screen|undefined)=>{if(screen){tokens.add(screen.canonical_key.toLowerCase());tokens.add(screen.display_name.toLowerCase());}};addScreenTerms(start);addScreenTerms(end);
       const steps=wf.steps.slice(0,100).map((step:any)=>{if(typeof step?.id==='string')tokens.add(step.id.toLowerCase());if(typeof step?.action==='string')tokens.add(step.action.toLowerCase());let screenId:string|undefined,elementId:string|undefined,locatorKind:string|undefined;if(step?.target?.screen){const targetScreen=resolve(step.target.screen);screenId=targetScreen?.canonical_key??String(step.target.screen).replace(/^screen:/,'');addScreenTerms(targetScreen);if(step.target.element)elementId=String(step.target.element);}else if(step?.target?.by)locatorKind=String(step.target.by);return{step_id:String(step?.id??'').slice(0,120),action:String(step?.action??'unknown').slice(0,30),...(screenId?{screen_id:screenId}:{}),...(elementId?{element_id:elementId}:{}),...(locatorKind?{locator_kind:locatorKind}:{})};});
       const goalHits=[...goalTokens].filter(token=>[...tokens].some(t=>t.includes(token))).length,roleWeight=reqRole?(context.role?1:.5):1,envWeight=envs.length?(context.environment?1:.5):1;
       const outcomes={passed:0,failed:0,other:0};const citations:Array<{run_id:string;evidence_id:string;status:string}>=[];
        const runs=this.#database.prepare('SELECT id,status FROM runs WHERE project_id=? AND memory_environment=? AND workflow_id IN (?,?) ORDER BY COALESCE(finished_at,created_at) DESC,id DESC LIMIT 20').all(this.projectId,this.memoryEnvironment,node.id,String(wf.id??node.canonical_key)) as Array<{id:string;status:string}>;
       for(const run of runs){if(run.status==='passed')outcomes.passed++;else if(run.status==='failed')outcomes.failed++;else outcomes.other++;const ev=this.#database.prepare("SELECT id,outcome FROM evidence WHERE project_id=? AND run_id=? AND subject_node_id=? ORDER BY created_at DESC,id LIMIT 1").get(this.projectId,run.id,node.id) as {id:string;outcome:string}|undefined;if(ev&&citations.length<5)citations.push({run_id:run.id,evidence_id:ev.id,status:ev.outcome});}
        const directStart=Boolean(current&&start&&current.id===start.id),hasRouteEvidence=Boolean(directStart||pathInfo);const reasons:string[]=[];if(directStart)reasons.push('current_screen_is_start');else if(pathInfo)reasons.push('directed_path_to_start');else reasons.push(current?'no_directed_path':'current_screen_unknown');if(goalHits)reasons.push('safe_goal_match');if(reqRole)reasons.push(context.role?'role_match':'role_context_missing');if(envs.length)reasons.push(context.environment?'environment_match':'environment_context_missing');
        const contextMissing=Boolean(reqRole&&!context.role||envs.length&&!context.environment),uncertainty:'low'|'medium'|'high'=contextMissing||!hasRouteEvidence?'high':outcomes.passed===0||node.verification_status!=='verified'?'medium':'low';
        const ageMs=Date.now()-Date.parse(node.updated_at||''),ageBuckets=Number.isFinite(ageMs)?Math.floor(Math.max(0,ageMs)/(30*86_400_000)):2,freshness=Math.max(0,2-ageBuckets);
       const score=goalHits*12+(current&&start&&current.id===start.id?20:0)+(pathInfo?Math.max(0,12-pathInfo.length*2):0)+roleWeight*4+envWeight*4+(node.verification_status==='verified'?3:0)+Math.min(1,node.confidence)+freshness+Math.min(5,outcomes.passed)-Math.min(5,outcomes.failed)*.5;
        const actionIds=pathInfo?.actions.map(id=>{const a=this.#database.prepare('SELECT canonical_key FROM nodes WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,id) as {canonical_key:string}|undefined;return(a?.canonical_key??'').split(':').at(-1)??'';})??[];
        candidates.push({workflow_id:String(wf.id??node.canonical_key),name:node.display_name,source:'yaml',verification_status:node.verification_status,start_screen_id:start?.canonical_key??null,end_screen_id:end?.canonical_key??null,score,confidence:node.confidence,uncertainty,reason_codes:reasons,step_count:wf.steps.length,steps,directed_path:pathInfo?{screen_ids:pathInfo.screens.map(id=>(screens.find(s=>s.id===id)?.canonical_key??'').replace(/^screen:/,'')),action_ids:actionIds}:null,current_route_pattern:route?.path??null,current_screen_id:current?.canonical_key??null,outcome_counts:outcomes,citations});
     }
     candidates.sort((a,b)=>b.score-a.score||a.workflow_id.localeCompare(b.workflow_id));return candidates.slice(0,cap);
   }
    stats(){return this.#database.prepare('SELECT (SELECT count(*) FROM nodes WHERE project_id=? AND environment=? AND tombstone=0) nodes,(SELECT count(*) FROM edges WHERE project_id=? AND environment=? AND tombstone=0) edges,(SELECT count(*) FROM evidence e JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id WHERE e.project_id=? AND r.memory_environment=?) evidence').get(this.projectId,this.memoryEnvironment,this.projectId,this.memoryEnvironment,this.projectId,this.memoryEnvironment);}
}
