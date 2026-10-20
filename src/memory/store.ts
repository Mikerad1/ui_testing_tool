import Database from 'better-sqlite3';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {normalizeLocator} from '../knowledge/locator-proposals.js';
import {hasNlpMetadata, NLP_METADATA_KEY, type YamlReconciliationPlan, type YamlRecordFingerprint} from './learning-types.js';
import {assertMcpGraphNodeType, assertMcpRelationSignature, attachPendingGraphMutationFinalizers, finalizeGraphMutation, registerPrimaryGraphMutationFinalizer, registerStoreWriteOperations, type BackfillEdgeWrite, type BackfillNodeWrite, type EvidenceReference, type McpEdgeWrite, type McpNodeWrite} from './store-internal.js';
import {clearGraphMutationCapture, installGraphMutationCapture, readGraphMutationWriteSet} from './graph-mutation.js';
import {createSearchIndexFinalizer,migrateSearchIndexV14,rebuildSearchIndexIfVersionChanged} from './search-index.js';
import {assertMemoryEnvironment, LEGACY_MEMORY_ENVIRONMENT} from './environment.js';
import {migrateEnvironmentSchema} from './schema-v11.js';
import {migrateCandidateObservations} from './schema-v13.js';
import {appendLifecycleEvent,migrateLifecycleEventsV15} from './schema-v15.js';
import {migrateEvidenceAssociationsV16} from './schema-v16.js';
import {migrateProvenanceIndexesV17} from './schema-v17.js';
import {normalizeSearchText, SEARCH_NORMALIZER_VERSION, SEARCH_RANKER_VERSION} from './search-index.js';
import {commitYamlReconciliation} from './yaml-commit.js';
import {backupSqlite} from './sqlite-backup.js';
import {hashBackfillEdge, hashBackfillNode, stableJson, withoutNlpMetadata, type BackfillEdgeValue, type BackfillNodeValue} from './content-fingerprint.js';
import type {BackfillEdgeRecord, BackfillNodeRecord, BackfillRecord, BackfillRedactedHash, BackfillSummary, BackfillCursor} from './backfill-types.js';

type Evidence = { id:string; project_id:string; run_id:string; subject_node_id:string; kind:string; outcome:string; metadata_json:string; artifact_ref:string|null; created_at:string };
export class BackfillRecordReadError extends Error { constructor(){super('Stored memory record is invalid');this.name='BackfillRecordReadError';} }
export type WorkflowRecallContext={goal:string;currentUrl:string;role?:string;environment?:string;limit?:number;trustYamlSeeds?:boolean};
export type MemoryReadOptions={trustYamlSeeds?:boolean};
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

const CANDIDATE_SOURCE_KINDS=new Set<CandidateObservationSourceKind>(['mcp_node','mcp_edge','yaml_document','backfill_node','backfill_edge']);
const CANDIDATE_STATUSES=new Set<CandidateObservationStatus>(['proposed','conflict','stale','superseded','rejected']);
function canonicalJson(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson((value as Record<string,unknown>)[key])}`).join(',')}}`;
  const result=JSON.stringify(value);
  if(result===undefined)throw new Error('Candidate observation payload must be JSON serializable');
  return result;
}
function boundedString(value:unknown,name:string,max:number,allowEmpty=false):string{
  if(typeof value!=='string'||(!allowEmpty&&value.length===0)||Buffer.byteLength(value,'utf8')>max)throw new Error(`Invalid candidate observation ${name}`);
  return value;
}
function candidateJson(value:unknown,name:string,max:number):string{
  const json=canonicalJson(value);
  if(Buffer.byteLength(json,'utf8')>max)throw new Error(`Candidate observation ${name} is too large`);
  return json;
}
function semanticAttributesJson(value:string|Record<string,unknown>):string{
  if(typeof value!=='string')return canonicalJson(withoutNlpMetadata(value));
  try{return canonicalJson(withoutNlpMetadata(JSON.parse(value)));}catch{
    // Legacy YAML edge attributes may contain JS `undefined` emitted by the
    // existing canonicalizer. Treat those omitted fields as absent for claim comparison.
    const repaired=value.replace(/,"[^"\\]+":undefined/g,'').replace(/"[^"\\]+":undefined,/g,'');
    try{return canonicalJson(withoutNlpMetadata(JSON.parse(repaired)));}catch{return `invalid:${value}`;}
  }
}

export const CURRENT_SCHEMA_VERSION=17;

export type CandidateObservationSourceKind='mcp_node'|'mcp_edge'|'yaml_document'|'backfill_node'|'backfill_edge';
export type CandidateObservationStatus='proposed'|'conflict'|'stale'|'superseded'|'rejected';
export type VerificationApproval={readonly approved:true;readonly source:'local_approver'};
export type CandidateObservationInput={
  source_kind:CandidateObservationSourceKind; source_key:string; source_revision_hash:string; pipeline_fingerprint:string;
  nlp_protocol_version:number; python_version:string; spacy_version:string; model_name:string; model_version:string;
  rules_version:string; patterns_schema_version:number; patterns_digest:string; redaction_policy_fingerprint:string; extraction_ready:boolean;
  redacted_source_text?:string|null; entities:unknown; relations:unknown; links:unknown;
  status:CandidateObservationStatus; supersedes_observation_id?:string|null; created_at?:string;
};
export type CandidateObservation=Omit<CandidateObservationInput,'entities'|'relations'|'links'|'created_at'> & {
  id:string; project_id:string; environment:string; entities:unknown; relations:unknown; links:unknown; created_at:string; updated_at:string;
};
export class Store {
  declare readonly db: ReadOnlyDatabase; declare readonly projectId: string; declare readonly memoryEnvironment: string; #database: Database.Database; #graphMutationDepth=0; #searchCursorKey=randomBytes(32); #searchCursorKeyId=randomBytes(12).toString('base64url');
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
        rebuildSearchIndexIfVersionChanged(this.#database);
        installGraphMutationCapture(this.#database);
        attachPendingGraphMutationFinalizers(this);
        registerPrimaryGraphMutationFinalizer(this,createSearchIndexFinalizer(this.#database));
       this.#withGraphMutation(()=>this.#database.prepare('INSERT OR IGNORE INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),projectId,scope,'application',projectId,projectId,projectId,'{}','human','verified',1));
      registerStoreWriteOperations(this,{
        proposedNode:input=>this.#commitProposedNode(input),
      preparedEdge:input=>this.#commitPreparedEdge(input),
      reconciliation:plan=>this.#commitReconciliation(plan),
      backfillNode:input=>this.#commitBackfillNode(input),
       backfillEdge:input=>this.#commitBackfillEdge(input),
        mcpNode:input=>this.#commitMcpNode(input),
        mcpEdge:input=>this.#commitMcpEdge(input),
      });
    }catch(error){
      try{this.#database.close();}catch{}
      throw error;
    }
  }
  #withGraphMutation<T>(operation:()=>T):T{
    if(this.#graphMutationDepth>0)return operation();
    return this.#database.transaction(()=>{
      clearGraphMutationCapture(this.#database);
      this.#graphMutationDepth++;
      try{
        const result=operation(),writeSet=readGraphMutationWriteSet(this.#database);
        finalizeGraphMutation(this,writeSet);
        clearGraphMutationCapture(this.#database);
        return result;
      }finally{this.#graphMutationDepth--;}
    })();
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
    if(!has(13))migrateCandidateObservations(this.#database);
    if(!has(14))this.#database.transaction(()=>migrateSearchIndexV14(this.#database))();
     if(!has(15))migrateLifecycleEventsV15(this.#database);
      if(!has(16))migrateEvidenceAssociationsV16(this.#database);
      if(!has(17))migrateProvenanceIndexesV17(this.#database);
  }
  close(){this.#database.close();}
  #yamlNodeOwnedSql(alias:string):string{return `EXISTS(SELECT 1 FROM yaml_ownership y JOIN yaml_sources ys ON ys.project_id=y.project_id AND ys.environment=y.environment AND ys.path=y.source_path WHERE y.project_id=${alias}.project_id AND y.environment=${alias}.environment AND y.entity_id=${alias}.id AND y.entity_type=${alias}.type AND y.entity_key=${alias}.canonical_key AND y.tombstone=0 AND y.conflict_status='none' AND y.hash=${alias}.content_hash AND ys.active=1 AND ys.hash=y.hash)`;}
  #yamlEdgeOwnedSql(alias:string):string{return `EXISTS(SELECT 1 FROM yaml_ownership y JOIN yaml_sources ys ON ys.project_id=y.project_id AND ys.environment=y.environment AND ys.path=y.source_path WHERE y.project_id=${alias}.project_id AND y.environment=${alias}.environment AND y.entity_id=${alias}.id AND y.entity_type='edge' AND y.tombstone=0 AND y.conflict_status='none' AND ys.active=1)`;}
  #trustedNodeSql(alias:string,trustYamlSeeds:boolean):string{return `(${alias}.tombstone=0 AND ${alias}.superseded_by IS NULL AND ${alias}.verification_status NOT IN ('stale','superseded') AND ${alias}.conflict_status='none' AND (( ${alias}.verification_status='verified' AND (${alias}.origin<>'yaml' OR ${this.#yamlNodeOwnedSql(alias)}))${trustYamlSeeds?` OR (${alias}.origin='yaml' AND ${this.#yamlNodeOwnedSql(alias)})`:''}))`;}
  #trustedEdgeSql(alias:string,trustYamlSeeds:boolean):string{return `(${alias}.tombstone=0 AND ${alias}.verification_status NOT IN ('stale','superseded') AND ${alias}.conflict_status='none' AND ((${alias}.verification_status='verified' AND (${alias}.origin<>'yaml' OR ${this.#yamlEdgeOwnedSql(alias)}))${trustYamlSeeds?` OR (${alias}.origin='yaml' AND ${this.#yamlEdgeOwnedSql(alias)})`:''}))`;}
  #nodeTrustBasisSql(alias:string,trustYamlSeeds:boolean):string{return `CASE WHEN ${alias}.verification_status='verified' THEN 'verified_fact' ELSE 'trusted_seed' END`;}
  #edgeTrustBasisSql(alias:string,trustYamlSeeds:boolean):string{return `CASE WHEN ${alias}.verification_status='verified' THEN 'verified_fact' ELSE 'trusted_seed' END`;}
  #authoredYamlNodes(){return this.#database.prepare(`SELECT n.id,n.type,n.canonical_key stable_key,n.display_name,n.origin,n.verification_status,n.conflict_status,'authored_unverified' trust_basis FROM nodes n WHERE n.project_id=? AND n.environment=? AND n.origin='yaml' AND n.tombstone=0 AND n.superseded_by IS NULL AND n.verification_status NOT IN ('verified','stale','superseded') AND n.conflict_status='none' AND ${this.#yamlNodeOwnedSql('n')} ORDER BY n.type,n.display_name LIMIT 100`).all(this.projectId,this.memoryEnvironment);}
  export(options:MemoryReadOptions={}){
    const nodes=this.#database.prepare(`SELECT n.*,${this.#nodeTrustBasisSql('n',options.trustYamlSeeds===true)} trust_basis FROM nodes n WHERE n.project_id=? AND n.environment=? AND ${this.#trustedNodeSql('n',options.trustYamlSeeds===true)} ORDER BY n.id LIMIT 500`).all(this.projectId,this.memoryEnvironment);
    const edges=this.#database.prepare(`SELECT e.*,${this.#edgeTrustBasisSql('e',options.trustYamlSeeds===true)} trust_basis FROM edges e JOIN nodes f ON f.project_id=e.project_id AND f.environment=e.environment AND f.id=e.from_node_id JOIN nodes t ON t.project_id=e.project_id AND t.environment=e.environment AND t.id=e.to_node_id WHERE e.project_id=? AND e.environment=? AND ${this.#trustedEdgeSql('e',options.trustYamlSeeds===true)} AND ${this.#trustedNodeSql('f',options.trustYamlSeeds===true)} AND ${this.#trustedNodeSql('t',options.trustYamlSeeds===true)} ORDER BY e.id LIMIT 1000`).all(this.projectId,this.memoryEnvironment);
    const nodeIds=new Set((nodes as Array<{id:string}>).map(node=>node.id));
    return{nodes,edges:(edges as Array<{from_node_id:string;to_node_id:string}>).filter(edge=>nodeIds.has(edge.from_node_id)&&nodeIds.has(edge.to_node_id))};
  }
  context(options:MemoryReadOptions={}){
    const trusted=this.#database.prepare(`SELECT n.id,n.type,n.canonical_key stable_key,n.display_name,n.origin,n.verification_status,n.conflict_status,${this.#nodeTrustBasisSql('n',options.trustYamlSeeds===true)} trust_basis FROM nodes n WHERE n.project_id=? AND n.environment=? AND ${this.#trustedNodeSql('n',options.trustYamlSeeds===true)} ORDER BY n.type,n.display_name LIMIT 100`).all(this.projectId,this.memoryEnvironment);
    const authored=options.trustYamlSeeds?[]:this.#authoredYamlNodes();
    return{trusted_facts:trusted,authored_guidance:authored.length?{label:'authored_unverified',warning:'YAML-authored guidance is unverified; revalidate against the current application before acting.',items:authored}:null};
  }
  search(q:string,options:MemoryReadOptions&{mode?:'auto'|'exact'|'prose';page_size?:number;cursor?:string}={}):any{return options.mode!==undefined||options.page_size!==undefined||options.cursor!==undefined?this.searchPage(q,options):this.searchPage(q,options).data;}
  #searchProvenance(nodeId:string):Record<string,unknown>|undefined{
    const yaml=this.#database.prepare(`SELECT y.hash source_revision_hash FROM nodes n
      JOIN yaml_ownership y ON y.project_id=n.project_id AND y.environment=n.environment AND y.entity_id=n.id AND y.entity_type=n.type AND y.entity_key=n.canonical_key
      JOIN yaml_sources ys ON ys.project_id=y.project_id AND ys.environment=y.environment AND ys.path=y.source_path
      WHERE n.project_id=? AND n.environment=? AND n.id=? AND n.origin='yaml' AND y.tombstone=0 AND y.conflict_status='none'
        AND y.hash=n.content_hash AND ys.active=1 AND ys.hash=y.hash LIMIT 1`).get(this.projectId,this.memoryEnvironment,nodeId) as {source_revision_hash:string}|undefined;
    if(yaml&&/^[a-f0-9]{64}$/.test(yaml.source_revision_hash))return{provenance:{source_kind:'yaml_document',source_revision_hash:yaml.source_revision_hash,status:'source_provenance_only'}};
    const node=this.#database.prepare("SELECT origin,verification_status FROM nodes WHERE project_id=? AND environment=? AND id=?").get(this.projectId,this.memoryEnvironment,nodeId) as {origin:string;verification_status:string}|undefined;
    if(node?.origin!=='agent'||node.verification_status!=='verified')return undefined;
    const unavailable={provenance:{status:'unavailable',evidence:[]}};
    const audit=this.#database.prepare("SELECT detail_json FROM memory_audit WHERE project_id=? AND subject_node_id=? AND action='verify' ORDER BY created_at DESC,id DESC LIMIT 1").get(this.projectId,nodeId) as {detail_json:string}|undefined;
    if(!audit)return unavailable;
    let detail:unknown;try{detail=JSON.parse(audit.detail_json);}catch{return unavailable;}
    if(!detail||typeof detail!=='object'||Array.isArray(detail))return unavailable;
    const runId=(detail as Record<string,unknown>).runId;
    const safeId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value);
    const safeTimestamp=(value:unknown):value is string=>typeof value==='string'&&value.length<=100&&Number.isFinite(Date.parse(value))&&!/[\u0000-\u001f\u007f]/.test(value);
    if(!safeId(runId)||!safeId(nodeId))return unavailable;
    const run=this.#database.prepare("SELECT id,status,created_at FROM runs WHERE project_id=? AND memory_environment=? AND id=? AND status='passed'").get(this.projectId,this.memoryEnvironment,runId) as {id:string;status:string;created_at:string}|undefined;
    if(!run||!safeId(run.id)||!safeTimestamp(run.created_at))return unavailable;
    const evidence=this.#database.prepare("SELECT e.id,e.subject_node_id,e.kind,e.outcome,e.metadata_json,e.created_at FROM evidence e WHERE e.project_id=? AND e.subject_node_id=? AND e.run_id=? AND e.kind='assertion' AND e.outcome='passed' ORDER BY e.created_at DESC,e.id DESC LIMIT 4").all(this.projectId,nodeId,run.id) as Array<{id:string;subject_node_id:string;kind:string;outcome:string;metadata_json:string;created_at:string}>;
    const refs=evidence.slice(0,3).flatMap(row=>{
      if(!safeId(row.id)||row.subject_node_id!==nodeId||!safeTimestamp(row.created_at))return[];
      const metadata=this.safeReportMetadata('assertion',row.metadata_json),ref:Record<string,unknown>={evidence_id:row.id,run_id:run.id,subject_node_id:nodeId,kind:'assertion',outcome:'passed',run_status:'passed',run_created_at:run.created_at,evidence_created_at:row.created_at};
      if(typeof metadata?.observed_count==='number')ref.observed_count=metadata.observed_count;
      if(Array.isArray(metadata?.actions))ref.action_count=metadata.actions.length;
      return[ref];
    });
    return refs.length?{provenance:{status:'provenance_only',evidence:refs}}:unavailable;
  }
  searchPage(q:string,options:MemoryReadOptions&{mode?:'auto'|'exact'|'prose';page_size?:number;cursor?:string}={}):{data:Array<Record<string,unknown>>;pagination:Record<string,unknown>}{
    const invalid=(status:'invalid_cursor'|'cursor_expired')=>({data:[],pagination:{status,page_size:pageSize}});
    const mode=options.mode??'auto',pageSize=options.page_size??50,view=options.trustYamlSeeds===true?1:0;
    if(!['auto','exact','prose'].includes(mode))throw new Error('Invalid search mode');
    if(!Number.isInteger(pageSize)||pageSize<1||pageSize>50)throw new Error('page_size must be an integer from 1 to 50');
     const rawBytes=Buffer.from(q,'utf8');if(rawBytes.length>512||[...q].length>200)throw new Error('Search query exceeds 200 Unicode code points or 512 UTF-8 bytes');
    const normalized=normalizeSearchText(q),tokens=normalized.match(/[\p{L}\p{N}\p{M}]+/gu)??[];
     if(mode!=='exact'&&(Buffer.byteLength(normalized,'utf8')>512||[...normalized].length>200||tokens.length>32))throw new Error('Normalized search query exceeds limits');
    if(mode==='prose'&&!tokens.length)throw new Error('Prose search requires at least one token');
     const state=this.#database.prepare('SELECT normalizer_version,ranker_version,generation FROM memory_search_state WHERE project_id=? AND environment=?').get(this.projectId,this.memoryEnvironment) as {normalizer_version:string;ranker_version:string;generation:number}|undefined;
     const rawDigest=createHash('sha256').update(rawBytes).digest('hex');
      const scopeHash=createHash('sha256').update('umb-search-cursor-scope\0v1\0');for(const part of [this.projectId,this.memoryEnvironment]){const bytes=Buffer.from(part,'utf8'),length=Buffer.allocUnsafe(4);length.writeUInt32BE(bytes.length);scopeHash.update(length).update(bytes);}
      const bind={digest:rawDigest,mode,page_size:pageSize,scope:scopeHash.digest('hex'),view,normalizer:SEARCH_NORMALIZER_VERSION,ranker:SEARCH_RANKER_VERSION,generation:state?.generation??0,key_id:this.#searchCursorKeyId};
    const sign=(payload:string)=>createHmac('sha256',this.#searchCursorKey).update(payload).digest('base64url');
    let offset=0;
    if(options.cursor!==undefined){
      try{
        if(options.cursor.length>2048||!/^[A-Za-z0-9_.-]+$/.test(options.cursor))return invalid('invalid_cursor');
         const parts=options.cursor.split('.');if(parts.length!==2)return invalid('invalid_cursor');
         const encoded=parts[0]!;
         const payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
         if(Buffer.from(JSON.stringify(payload)).toString('base64url')!==encoded||!Number.isSafeInteger(payload.offset)||payload.offset<0)return invalid('invalid_cursor');
         const {offset:cursorOffset,...cursorBind}=payload;
         if(cursorBind.scope!==bind.scope||cursorBind.digest!==bind.digest||cursorBind.mode!==bind.mode||cursorBind.page_size!==bind.page_size||cursorBind.view!==bind.view)return invalid('invalid_cursor');
          if(cursorBind.key_id!==bind.key_id)return invalid('invalid_cursor');
         const signatureText=parts[1]!,signature=Buffer.from(signatureText,'base64url'),expected=Buffer.from(sign(encoded),'base64url');
         if(signature.toString('base64url')!==signatureText)return invalid('invalid_cursor');
         if(signature.length!==expected.length||!timingSafeEqual(signature,expected))return invalid('invalid_cursor');
         if(cursorBind.normalizer!==bind.normalizer||cursorBind.ranker!==bind.ranker||cursorBind.generation!==bind.generation)return invalid('cursor_expired');
        offset=cursorOffset;
      }catch{return invalid('invalid_cursor');}
    }
      const ranked=new Map<string,{row:any;trust:number;exact:boolean;score:number;graphEdges:Set<string>;graphSourceTerms:Set<string>;graphNeighborTerms:Set<string>;graphRelationTerms:Set<string>;coverage:number;paths:Set<string>;graph_matches:any[];graph_matches_truncated:boolean;recency:string}>();let work=0,tooBroad=false;
    const budget=1000;
    // The raw-value index bounds exact candidate enumeration before node dedupe.
    const exactHash=(type:string,path:string)=>{const hash=createHash('sha256').update('umb-search-exact\0v1\0');for(const part of [this.projectId,this.memoryEnvironment,type,path,q]){const bytes=Buffer.from(part,'utf8'),length=Buffer.allocUnsafe(4);length.writeUInt32BE(bytes.length);hash.update(length).update(bytes);}return hash.digest('hex');};
      const add=(hit:any,exact:boolean,score=0,path?:string,coverage=0,graphMatch?:any,graphTerms?:{source:Set<string>;neighbor:Set<string>;relation:Set<string>;recency:string})=>{let item=ranked.get(hit.id);if(!item){item={row:hit,trust:hit.verification_status==='verified'?0:1,exact,score,graphEdges:new Set(),graphSourceTerms:new Set(),graphNeighborTerms:new Set(),graphRelationTerms:new Set(),coverage,paths:new Set(),graph_matches:[],graph_matches_truncated:false,recency:String(hit.updated_at??'')};ranked.set(hit.id,item);}else{item.exact ||= exact;item.score=Math.max(item.score,score);item.coverage=Math.max(item.coverage,coverage);}if(path)item.paths.add(path);if(graphMatch&&!item.graph_matches.some((match:any)=>match.edge_id===graphMatch.edge_id)){item.graphEdges.add(graphMatch.edge_id);if(item.graph_matches.length<3)item.graph_matches.push(graphMatch);else item.graph_matches_truncated=true;}if(graphTerms){for(const term of graphTerms.source)item.graphSourceTerms.add(term);for(const term of graphTerms.neighbor)item.graphNeighborTerms.add(term);for(const term of graphTerms.relation)item.graphRelationTerms.add(term);const current=Date.parse(item.recency),incoming=Date.parse(graphTerms.recency);if(Number.isFinite(incoming)&&( !Number.isFinite(current)||incoming>current))item.recency=graphTerms.recency;}};
    if(mode!=='prose'){
      const remaining=budget-work;
      const exactHits=this.#database.prepare(`SELECT v.raw_value,v.path,v.value_hash,n.id,n.type,n.canonical_key stable_key,n.display_name,n.verification_status,n.updated_at
        FROM memory_search_values v JOIN nodes n ON n.project_id=v.project_id AND n.environment=v.environment AND n.id=v.node_id
        WHERE v.project_id=? AND v.environment=? AND v.trust_view=? AND v.kind='exact' AND v.raw_value COLLATE BINARY=?
          AND ${this.#trustedNodeSql('n',view===1)} ORDER BY v.node_id,v.value_id LIMIT ?`).all(this.projectId,this.memoryEnvironment,view,q,remaining+1) as any[];
      if(exactHits.length>remaining)tooBroad=true;
      else for(const hit of exactHits){work++;if(!Buffer.from(hit.raw_value,'utf8').equals(rawBytes))continue;if(hit.value_hash!==exactHash(hit.type,hit.path))continue;add(hit,true,0,hit.path);}
    }
    if(!tooBroad&&mode!=='exact'&&tokens.length){
       const uniqueTokens=[...new Set(tokens)];
       const df=(token:string)=>Number((this.#database.prepare('SELECT document_frequency FROM memory_search_df WHERE project_id=? AND environment=? AND trust_view=? AND token=?').get(this.projectId,this.memoryEnvironment,view,token) as any)?.document_frequency??0);
       const rarest=[...uniqueTokens].sort((a,b)=>df(a)-df(b)||Buffer.compare(Buffer.from(a),Buffer.from(b)))[0]!;
       const candidateLimit=budget-work,candidates=this.#database.prepare('SELECT DISTINCT node_id FROM memory_search_tokens WHERE project_id=? AND environment=? AND trust_view=? AND token=? ORDER BY node_id LIMIT ?').all(this.projectId,this.memoryEnvironment,view,rarest,candidateLimit+1) as Array<{node_id:string}>;
       if(candidates.length>candidateLimit)tooBroad=true;
       else work+=candidates.length;
       const postingsFor=(nodeId:string,limit:number)=>this.#database.prepare(`SELECT token,path,path_weight FROM memory_search_tokens WHERE project_id=? AND environment=? AND trust_view=? AND node_id=? AND token IN (${uniqueTokens.map(()=>'?').join(',')}) ORDER BY token,path LIMIT ?`).all(this.projectId,this.memoryEnvironment,view,nodeId,...uniqueTokens,limit) as Array<{token:string;path:string;path_weight:number}>;
       if(!tooBroad)for(const candidate of candidates){
         const sourceId=candidate.node_id,remainingWork=budget-work,sourcePostings=postingsFor(sourceId,remainingWork+1);work+=sourcePostings.length;if(sourcePostings.length>remainingWork){tooBroad=true;break;}
         const sourceTerms=new Set(sourcePostings.map(item=>item.token));
         const node=this.#database.prepare(`SELECT n.id,n.type,n.canonical_key stable_key,n.display_name,n.verification_status,n.updated_at FROM nodes n WHERE n.project_id=? AND n.environment=? AND n.id=? AND ${this.#trustedNodeSql('n',view===1)}`).get(this.projectId,this.memoryEnvironment,sourceId) as any;if(!node)continue;
         const scoreFor=(postings:Array<{token:string;path:string;path_weight:number}>)=>{let score=0;for(const token of new Set(postings.map(x=>x.token))){score+=Math.max(1,Math.floor(1_000_000/(df(token)+1)))*Math.max(...postings.filter(x=>x.token===token).map(x=>x.path_weight));}return score;};
         if(sourceTerms.size===uniqueTokens.length)for(const posting of sourcePostings)add({...node},false,scoreFor(sourcePostings),posting.path,sourceTerms.size);
         if(uniqueTokens.length===1)continue;
         const rawEdgeSql=`SELECT e.id edge_id,e.from_node_id,e.to_node_id,e.relation_type,e.origin edge_origin,e.verification_status edge_verification_status,e.conflict_status edge_conflict_status,e.tombstone edge_tombstone,e.updated_at edge_updated_at,
             f.id from_id,f.type from_type,f.verification_status from_verification_status,f.origin from_origin,f.conflict_status from_conflict_status,f.tombstone from_tombstone,f.superseded_by from_superseded_by,f.content_hash from_content_hash,f.canonical_key from_canonical_key,
             t.id to_id,t.type to_type,t.verification_status to_verification_status,t.origin to_origin,t.conflict_status to_conflict_status,t.tombstone to_tombstone,t.superseded_by to_superseded_by,t.content_hash to_content_hash,t.canonical_key to_canonical_key
           FROM edges e JOIN nodes f ON f.project_id=e.project_id AND f.environment=e.environment AND f.id=e.from_node_id
           JOIN nodes t ON t.project_id=e.project_id AND t.environment=e.environment AND t.id=e.to_node_id
           WHERE e.project_id=? AND e.environment=? AND `;
         const outgoing=this.#database.prepare(`${rawEdgeSql}e.from_node_id=? ORDER BY e.id LIMIT 4`).all(this.projectId,this.memoryEnvironment,sourceId) as any[];
         const incoming=this.#database.prepare(`${rawEdgeSql}e.to_node_id=? ORDER BY e.id LIMIT 4`).all(this.projectId,this.memoryEnvironment,sourceId) as any[];
         const inspectedEdges=[...outgoing,...incoming],rawEdges=[...new Map(inspectedEdges.map(edge=>[edge.edge_id,edge])).values()].sort((a,b)=>Buffer.compare(Buffer.from(a.edge_id),Buffer.from(b.edge_id)));work+=inspectedEdges.length;
         if(outgoing.length>3||incoming.length>3||rawEdges.length>3||work>budget){tooBroad=true;break;}
         const edgeIsTrusted=(edge:any)=>edge.edge_tombstone===0&&edge.edge_conflict_status==='none'&&!['stale','superseded'].includes(edge.edge_verification_status)&&((edge.edge_verification_status==='verified'&&(edge.edge_origin!=='yaml'||this.#database.prepare(`SELECT 1 FROM yaml_ownership y JOIN yaml_sources s ON s.project_id=y.project_id AND s.environment=y.environment AND s.path=y.source_path WHERE y.project_id=? AND y.environment=? AND y.entity_id=? AND y.entity_type='edge' AND y.tombstone=0 AND y.conflict_status='none' AND s.active=1 LIMIT 1`).get(this.projectId,this.memoryEnvironment,edge.edge_id)))||(view===1&&edge.edge_origin==='yaml'&&this.#database.prepare(`SELECT 1 FROM yaml_ownership y JOIN yaml_sources s ON s.project_id=y.project_id AND s.environment=y.environment AND s.path=y.source_path WHERE y.project_id=? AND y.environment=? AND y.entity_id=? AND y.entity_type='edge' AND y.tombstone=0 AND y.conflict_status='none' AND s.active=1 LIMIT 1`).get(this.projectId,this.memoryEnvironment,edge.edge_id)));
         for(const edge of rawEdges){
           if(!edgeIsTrusted(edge))continue;
           const neighborId=edge.from_node_id===sourceId?edge.to_id:edge.from_id,neighborType=edge.from_node_id===sourceId?edge.to_type:edge.from_type;
           const trustedNeighbor=this.#database.prepare(`SELECT n.id,n.type,n.verification_status,n.updated_at FROM nodes n WHERE n.project_id=? AND n.environment=? AND n.id=? AND ${this.#trustedNodeSql('n',view===1)}`).get(this.projectId,this.memoryEnvironment,neighborId) as any;if(!trustedNeighbor)continue;
           const neighborRows=postingsFor(neighborId,budget-work+1);work+=neighborRows.length;if(work>budget){tooBroad=true;break;}
           const relationTokens=new Set((normalizeSearchText(edge.relation_type.replace(/_/g,' ')).match(/[\p{L}\p{N}\p{M}]+/gu)??[]).filter(token=>uniqueTokens.includes(token))),neighborTerms=new Set(neighborRows.map(item=>item.token));
           const allTerms=new Set([...sourceTerms,...neighborTerms,...relationTokens]);if(!uniqueTokens.every(token=>allTerms.has(token)))continue;
           const neighborOnly=new Set([...neighborTerms].filter(token=>!sourceTerms.has(token)));
           const graphMatch={node_id:sourceId,node_type:node.type,candidate_paths:[...new Set(sourcePostings.filter(row=>uniqueTokens.includes(row.token)).map(row=>row.path))].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),edge_id:edge.edge_id,relation_type:edge.relation_type,from_node_id:edge.from_node_id,to_node_id:edge.to_node_id,neighbor_id:neighborId,neighbor_type:neighborType,neighbor_paths:[...new Set(neighborRows.map(row=>row.path))].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),path:'one_hop',trust_basis:node.verification_status==='verified'?'verified_fact':'trusted_seed',edge_trust_basis:edge.edge_verification_status==='verified'?'verified_fact':'trusted_seed',neighbor_trust_basis:trustedNeighbor.verification_status==='verified'?'verified_fact':'trusted_seed'};
           const recency=[node.updated_at,trustedNeighbor.updated_at,edge.edge_updated_at].map(String).sort((a,b)=>Buffer.compare(Buffer.from(b),Buffer.from(a)))[0]!;
           const graphTerms={source:sourceTerms,neighbor:neighborOnly,relation:relationTokens,recency};
           add({...node},false,scoreFor(sourcePostings)+scoreFor(neighborRows),undefined,uniqueTokens.length,graphMatch,graphTerms);
         }
         if(tooBroad)break;
       }
    }
    if(tooBroad)return{data:[],pagination:{status:'too_broad',page_size:pageSize}};
     const utf8=(a:string,b:string)=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'));
     const recencyOrder=(a:string,b:string)=>{const left=Date.parse(a),right=Date.parse(b);return Number.isFinite(left)&&Number.isFinite(right)?left-right:utf8(a,b);};
     const graphScore=(item:any)=>1000*Math.min(3,item.graphEdges.size)+100*Math.min(32,item.graphNeighborTerms.size)+[...item.graphRelationTerms].filter(term=>!item.graphSourceTerms.has(term)&&!item.graphNeighborTerms.has(term)).length;
     const ordered=[...ranked.values()].sort((a,b)=>a.trust-b.trust||Number(b.exact)-Number(a.exact)||b.coverage-a.coverage||(graphScore(b)-graphScore(a))||b.score-a.score||recencyOrder(b.recency,a.recency)||utf8(a.row.type,b.row.type)||utf8(a.row.stable_key,b.row.stable_key)||utf8(a.row.id,b.row.id));
     const projections=ordered.map(item=>{const projection={id:item.row.id,type:item.row.type,stable_key:item.row.stable_key,display_name:item.row.display_name,trust_basis:item.trust?'trusted_seed':'verified_fact',matched_paths:[...item.paths].sort(utf8),...(item.graph_matches.length?{graph_matches:item.graph_matches,...(item.graph_matches_truncated?{graph_matches_truncated:true}:{})}: {})};while(Buffer.byteLength(JSON.stringify(projection),'utf8')>2*1024&&projection.matched_paths.length)projection.matched_paths.pop();return projection;});
    if(projections.some(projection=>Buffer.byteLength(JSON.stringify({...projection,matched_paths:[]}),'utf8')>2*1024))return{data:[],pagination:{status:'too_broad',page_size:pageSize}};
    const cursorFor=(at:number)=>{const payload=Buffer.from(JSON.stringify({...bind,offset:at})).toString('base64url');return `${payload}.${sign(payload)}`;};
    const data:typeof projections=[];let omitted=0,index=offset;
     while(index<projections.length&&data.length<pageSize){const base=projections[index]!,provenance=this.#searchProvenance(String(base.id)),row={...base,...provenance};if(Buffer.byteLength(JSON.stringify(row),'utf8')>2*1024)return{data:[],pagination:{status:'too_broad',page_size:pageSize}};if(Buffer.byteLength(JSON.stringify([...data,row]),'utf8')>14*1024){omitted=projections.length-index;break;}data.push(row);index++;}
    const hasMore=index<projections.length,pagination:Record<string,unknown>={status:hasMore?'has_more':'complete',page_size:pageSize,...(hasMore?{next_cursor:cursorFor(index)}:{}),...(omitted?{omitted_count:omitted}:{})};
    while(data.length&&Buffer.byteLength(JSON.stringify({data,pagination}),'utf8')>16*1024){data.pop();index--;omitted++;pagination.status='has_more';pagination.next_cursor=cursorFor(index);pagination.omitted_count=omitted;}
    return{data,pagination};
  }
  getInternal(id:string){return this.#database.prepare('SELECT * FROM nodes WHERE project_id=? AND environment=? AND id=? AND tombstone=0').get(this.projectId,this.memoryEnvironment,id)??null;}
  /** Compatibility for existing internal workflow/assertion consumers; public MCP uses getTrustedNode. */
  get(id:string){return this.getInternal(id);}
  getTrustedNode(id:string,options:MemoryReadOptions={}){return this.#database.prepare(`SELECT n.*,${this.#nodeTrustBasisSql('n',options.trustYamlSeeds===true)} trust_basis FROM nodes n WHERE n.project_id=? AND n.environment=? AND n.id=? AND ${this.#trustedNodeSql('n',options.trustYamlSeeds===true)}`).get(this.projectId,this.memoryEnvironment,id)??null;}
  validateMcpEdgeSignature(fromId:string,toId:string,relation:string):void{
    const endpoints=this.#database.prepare('SELECT id,type FROM nodes WHERE project_id=? AND environment=? AND id IN (?,?) AND tombstone=0').all(this.projectId,this.memoryEnvironment,fromId,toId) as Array<{id:string;type:string}>;
    if(endpoints.length!==(fromId===toId?1:2))throw new Error('Edge endpoints must belong to this project and environment');
    assertMcpRelationSignature(relation,endpoints.find(node=>node.id===fromId)!.type,endpoints.find(node=>node.id===toId)!.type);
  }
  /** Internal ledger append; all application callers must supply LearningWriter-prepared observations. */
  #appendCandidateObservation(input:CandidateObservationInput):CandidateObservation{
    if(!input||!CANDIDATE_SOURCE_KINDS.has(input.source_kind))throw new Error('Invalid candidate observation source kind');
    if(!CANDIDATE_STATUSES.has(input.status))throw new Error('Invalid candidate observation status');
    const sourceKey=boundedString(input.source_key,'source key',1024),revision=boundedString(input.source_revision_hash,'source revision hash',64),pipeline=boundedString(input.pipeline_fingerprint,'pipeline fingerprint',64);
    const hashPattern=/^[a-f0-9]{64}$/;
    if(!hashPattern.test(revision)||!hashPattern.test(pipeline))throw new Error('Invalid candidate observation fingerprint');
    const protocol=input.nlp_protocol_version,patternVersion=input.patterns_schema_version;
    if(!Number.isSafeInteger(protocol)||protocol<1||protocol>100||!Number.isSafeInteger(patternVersion)||patternVersion<0||patternVersion>100)throw new Error('Invalid candidate observation version');
    const python=boundedString(input.python_version,'Python version',100,true),spacy=boundedString(input.spacy_version,'spaCy version',100,true),model=boundedString(input.model_name,'model name',200,true),modelVersion=boundedString(input.model_version,'model version',100,true),rules=boundedString(input.rules_version,'rules version',200,true),patternsDigest=boundedString(input.patterns_digest,'patterns digest',64),redaction=boundedString(input.redaction_policy_fingerprint,'redaction fingerprint',64);
    if(!hashPattern.test(patternsDigest)||!hashPattern.test(redaction))throw new Error('Invalid candidate observation fingerprint');
    if(typeof input.extraction_ready!=='boolean')throw new Error('Invalid candidate extraction readiness');
    const text=input.redacted_source_text==null?null:boundedString(input.redacted_source_text,'redacted source text',65536,true);
    const entities=candidateJson(input.entities,'entities',262144),relations=candidateJson(input.relations,'relations',262144),links=candidateJson(input.links,'links',65536);
    const supersedes=input.supersedes_observation_id==null?null:boundedString(input.supersedes_observation_id,'supersedes id',64);
    if(supersedes!==null&&!hashPattern.test(supersedes))throw new Error('Invalid superseded observation id');
    const identity=JSON.stringify([this.projectId,this.memoryEnvironment,input.source_kind,sourceKey,revision,pipeline]);
    const id=createHash('sha256').update(identity).digest('hex'),now=input.created_at??new Date().toISOString();
    if(!Number.isFinite(Date.parse(now)))throw new Error('Invalid candidate observation timestamp');
    const payload=[input.source_kind,sourceKey,revision,pipeline,protocol,python,spacy,model,modelVersion,rules,patternVersion,patternsDigest,redaction,input.extraction_ready?1:0,text,entities,relations,links,input.status,supersedes];
    const insert=()=>{
      const existing=this.#database.prepare('SELECT * FROM memory_candidate_observations WHERE project_id=? AND environment=? AND source_kind=? AND source_key=? AND source_revision_hash=? AND pipeline_fingerprint=?').get(this.projectId,this.memoryEnvironment,input.source_kind,sourceKey,revision,pipeline) as Record<string,unknown>|undefined;
      if(existing){
        const previous=[existing.source_kind,existing.source_key,existing.source_revision_hash,existing.pipeline_fingerprint,existing.nlp_protocol_version,existing.python_version,existing.spacy_version,existing.model_name,existing.model_version,existing.rules_version,existing.patterns_schema_version,existing.patterns_digest,existing.redaction_policy_fingerprint,existing.extraction_ready,existing.redacted_source_text,existing.entities_json,existing.relations_json,existing.links_json,existing.status,existing.supersedes_observation_id];
        if(canonicalJson(previous)!==canonicalJson(payload))throw new Error('Candidate observation identity already exists with different payload');
        return this.#decodeCandidateObservation(existing);
      }
      this.#database.prepare(`INSERT INTO memory_candidate_observations(id,project_id,environment,source_kind,source_key,source_revision_hash,pipeline_fingerprint,nlp_protocol_version,python_version,spacy_version,model_name,model_version,rules_version,patterns_schema_version,patterns_digest,redaction_policy_fingerprint,extraction_ready,redacted_source_text,entities_json,relations_json,links_json,status,supersedes_observation_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,this.projectId,this.memoryEnvironment,input.source_kind,sourceKey,revision,pipeline,protocol,python,spacy,model,modelVersion,rules,patternVersion,patternsDigest,redaction,input.extraction_ready?1:0,text,entities,relations,links,input.status,supersedes,now,now);
      return this.#decodeCandidateObservation(this.#database.prepare('SELECT * FROM memory_candidate_observations WHERE id=?').get(id) as Record<string,unknown>);
    };
    return this.#database.inTransaction?insert():this.#database.transaction(insert)();
  }
  listCandidateObservations(options:{source_kind?:CandidateObservationSourceKind;source_key?:string;limit?:number}={}):CandidateObservation[]{
    if(options.source_kind!==undefined&&!CANDIDATE_SOURCE_KINDS.has(options.source_kind))throw new Error('Invalid candidate observation source kind');
    const limit=Math.max(1,Math.min(500,Math.trunc(options.limit??100)));
    const rows=options.source_kind!==undefined
      ?this.#database.prepare('SELECT * FROM memory_candidate_observations WHERE project_id=? AND environment=? AND source_kind=? AND (? IS NULL OR source_key=?) ORDER BY created_at,id LIMIT ?').all(this.projectId,this.memoryEnvironment,options.source_kind,options.source_key??null,options.source_key??null,limit)
      :this.#database.prepare('SELECT * FROM memory_candidate_observations WHERE project_id=? AND environment=? AND (? IS NULL OR source_key=?) ORDER BY created_at,id LIMIT ?').all(this.projectId,this.memoryEnvironment,options.source_key??null,options.source_key??null,limit);
    return (rows as Array<Record<string,unknown>>).map(row=>this.#decodeCandidateObservation(row));
  }
  listCandidateObservationPage(options:{source_kind?:CandidateObservationSourceKind;source_key?:string;stored_status?:CandidateObservationStatus;limit?:number;cursor?:string;include_redacted_source?:boolean}={}):{items:Array<Record<string,unknown>>;next_cursor:string|null;notice:string;truncated:boolean;omitted_count:number}{
    if(options.source_kind!==undefined&&!CANDIDATE_SOURCE_KINDS.has(options.source_kind))throw new Error('Invalid candidate observation source kind');
    if(options.stored_status!==undefined&&!CANDIDATE_STATUSES.has(options.stored_status))throw new Error('Invalid stored candidate observation status');
    const requested=options.limit===undefined?50:Math.trunc(options.limit),limit=Number.isFinite(requested)?Math.max(1,Math.min(100,requested)):50;
    if(options.source_key!==undefined)boundedString(options.source_key,'source key',1024);
    let after:{created_at:string;id:string}|undefined;
    if(options.cursor!==undefined){
      if(options.cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(options.cursor))throw new Error('Invalid candidate cursor');
      try{const decoded=Buffer.from(options.cursor,'base64url').toString('utf8'),parsed=JSON.parse(decoded);if(!Array.isArray(parsed)||parsed.length!==2||typeof parsed[0]!=='string'||!Number.isFinite(Date.parse(parsed[0]))||typeof parsed[1]!=='string'||!/^[a-f0-9]{64}$/.test(parsed[1])||Buffer.from(decoded).toString('base64url')!==options.cursor)throw Error();after={created_at:parsed[0],id:parsed[1]};}catch{throw new Error('Invalid candidate cursor');}
    }
    const rows=this.#database.prepare(`SELECT * FROM memory_candidate_observations WHERE project_id=? AND environment=? AND (? IS NULL OR source_kind=?) AND (? IS NULL OR source_key=?) AND (? IS NULL OR status=?) AND (? IS NULL OR created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?`).all(this.projectId,this.memoryEnvironment,options.source_kind??null,options.source_kind??null,options.source_key??null,options.source_key??null,options.stored_status??null,options.stored_status??null,after?.created_at??null,after?.created_at??null,after?.created_at??null,after?.id??null,limit+1) as Array<Record<string,unknown>>;
    const page=rows.slice(0,limit),items=page.map(row=>this.#candidateReviewRecord(row,options.include_redacted_source===true)),notice='NLP-extracted candidates are unverified proposals. Graph links identify only the submitted graph record and do not prove that extracted candidates created or describe it.';
    let emitted=items.length,truncated=false,omitted_count=0;
    const cursorFor=(n:number)=>n>0?Buffer.from(JSON.stringify([page[n-1]!.created_at,page[n-1]!.id])).toString('base64url'):null;
    const response=()=>({items:items.slice(0,emitted),next_cursor:emitted<page.length||rows.length>page.length?cursorFor(emitted):null,notice,truncated,omitted_count});
    const size=()=>Buffer.byteLength(JSON.stringify(response()),'utf8');
    // MCP returns both structuredContent and a serialized text content block.
    // Keep this payload well below half the hard 48 KiB wire budget.
    const budget=20*1024;
     for(let i=emitted-1;size()>budget&&i>=0;i--){const item=items[i]!;for(const field of ['redacted_source','relations','entities','links','evidence_refs'] as const){if(size()<=budget)break;if(field in item){delete item[field];const omitted=(item.omitted_fields as string[]|undefined)??[];item.omitted_fields=[...omitted,field];item.truncated=true;truncated=true;}}}
    while(emitted>0&&size()>budget){emitted--;omitted_count++;truncated=true;}
    return response();
  }
  #candidateReviewRecord(row:Record<string,unknown>,includeRedacted:boolean):Record<string,unknown>{
    const observation=this.#decodeCandidateObservation(row),links=observation.links as unknown;
    let sourceCurrent:'current'|'stale'|'unknown'|'not_linked'='not_linked',currentStatus:string;
    const graphStates:string[]=[];
    if(Array.isArray(links))for(const link of links){if(!link||typeof link!=='object'||Array.isArray(link))continue;const value=link as Record<string,unknown>;if(!['node','edge'].includes(String(value.kind))||typeof value.id!=='string')continue;
      const table=value.kind==='node'?'nodes':'edges',rowState=this.#database.prepare(`SELECT tombstone,verification_status,conflict_status${table==='nodes'?',superseded_by':''} FROM ${table} WHERE project_id=? AND environment=? AND id=?`).get(this.projectId,this.memoryEnvironment,value.id) as Record<string,unknown>|undefined;
      if(!rowState){graphStates.push('missing');continue;}if(Number(rowState.tombstone))graphStates.push('tombstone');else if(rowState.superseded_by)graphStates.push('superseded');else if(rowState.conflict_status!=='none')graphStates.push('conflict');else if(rowState.verification_status==='stale')graphStates.push('stale');else graphStates.push(String(rowState.verification_status));
    }
    if(graphStates.length){sourceCurrent=graphStates.some(state=>['missing','tombstone','superseded','stale'].includes(state))?'stale':'current';currentStatus=graphStates.includes('conflict')?'conflict':graphStates.includes('stale')?'stale':graphStates.includes('tombstone')?'tombstoned':graphStates.includes('superseded')?'superseded':graphStates.includes('verified')?'verified':'proposed';}
    else if(observation.source_kind==='backfill_node'&&observation.source_key.startsWith('node:')){const id=observation.source_key.slice(5),rowState=this.#database.prepare('SELECT tombstone,verification_status,conflict_status,superseded_by FROM nodes WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,id) as any;sourceCurrent=!rowState||rowState.tombstone||rowState.superseded_by?'stale':'current';currentStatus=!rowState?'not_linked':rowState.tombstone?'tombstoned':rowState.superseded_by?'superseded':rowState.conflict_status!=='none'?'conflict':rowState.verification_status==='stale'?'stale':rowState.verification_status;}
    else if(observation.source_kind==='backfill_edge'&&observation.source_key.startsWith('edge:')){const id=observation.source_key.slice(5),rowState=this.#database.prepare('SELECT tombstone,verification_status,conflict_status FROM edges WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,id) as any;sourceCurrent=!rowState||rowState.tombstone?'stale':'current';currentStatus=!rowState?'not_linked':rowState.tombstone?'tombstoned':rowState.conflict_status!=='none'?'conflict':rowState.verification_status==='stale'?'stale':rowState.verification_status;}
     else if(observation.source_kind==='yaml_document'){
       const separator=observation.source_key.indexOf(':'),kind=separator<0?'':observation.source_key.slice(0,separator),documentId=separator<0?'':observation.source_key.slice(separator+1);
       const fingerprint=kind&&documentId?this.#database.prepare(`SELECT f.source_path,f.raw_hash,f.redacted_hash,y.tombstone,y.conflict_status,ys.active,ys.hash source_hash
         FROM yaml_record_fingerprints f LEFT JOIN yaml_ownership y ON y.project_id=f.project_id AND y.environment=f.environment AND y.entity_type=f.document_kind AND y.entity_key=f.document_id AND y.source_path=f.source_path
         LEFT JOIN yaml_sources ys ON ys.project_id=f.project_id AND ys.environment=f.environment AND ys.path=f.source_path
         WHERE f.project_id=? AND f.environment=? AND f.document_kind=? AND f.document_id=? LIMIT 1`).get(this.projectId,this.memoryEnvironment,kind,documentId) as any:undefined;
       if(!fingerprint){sourceCurrent='unknown';currentStatus='unknown';}
       else if(fingerprint.redacted_hash!==observation.source_revision_hash||fingerprint.tombstone!==0||fingerprint.conflict_status!=='none'||fingerprint.active!==1||fingerprint.source_hash!==fingerprint.raw_hash){sourceCurrent='stale';currentStatus='stale';}
       else{sourceCurrent='current';currentStatus='current';}
     }
    else currentStatus='not_linked';
     const {redacted_source_text,...safe}=observation;
     const mcpSource=observation.source_kind==='mcp_node'||observation.source_kind==='mcp_edge';
     const evidenceRefs=mcpSource?this.listCandidateEvidenceReferences(String(row.id)):[];
     return{...safe,stored_status:observation.status,current_status:currentStatus,source_current:sourceCurrent,
       evidence_link_status:mcpSource?(evidenceRefs.length?'provenance_only':'missing'):'not_required',evidence_refs:evidenceRefs,
       ...(includeRedacted?{redacted_source:{label:'redacted_untrusted',text:redacted_source_text??null}}:{})};
  }
  #decodeCandidateObservation(row:Record<string,unknown>):CandidateObservation{
    const {entities_json,relations_json,links_json,...fields}=row;
    return{...fields,extraction_ready:Boolean(fields.extraction_ready),entities:JSON.parse(entities_json as string),relations:JSON.parse(relations_json as string),links:JSON.parse(links_json as string)} as CandidateObservation;
  }
  #candidateGraphIdentity(input:CandidateObservationInput):string{
    return createHash('sha256').update(JSON.stringify([this.projectId,this.memoryEnvironment,input.source_kind,input.source_key])).digest('hex');
  }
  #priorMcpGraphLink(input:CandidateObservationInput):string|undefined{
    const row=this.#database.prepare('SELECT links_json FROM memory_candidate_observations WHERE project_id=? AND environment=? AND source_kind=? AND source_key=? AND source_revision_hash=? ORDER BY created_at DESC,id DESC LIMIT 1').get(this.projectId,this.memoryEnvironment,input.source_kind,input.source_key,input.source_revision_hash) as {links_json:string}|undefined;
    if(!row)return undefined;
    try{const links=JSON.parse(row.links_json);return Array.isArray(links)&&typeof links[0]?.id==='string'?links[0].id:undefined;}catch{return undefined;}
  }
  #canonicalEvidenceRefs(value:unknown):EvidenceReference[]{
    if(!Array.isArray(value)||value.length<1||value.length>5)throw new Error('Evidence references must contain 1 to 5 items');
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const seen=new Set<string>();
    const refs=value.map(item=>{
      if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('Invalid evidence reference');
      const ref=item as Record<string,unknown>;
      if(Object.keys(ref).sort().join(',')!=='evidence_id,run_id,subject_node_id')throw new Error('Invalid evidence reference fields');
      const evidence_id=boundedString(ref.evidence_id,'evidence id',36),run_id=boundedString(ref.run_id,'run id',36),subject_node_id=boundedString(ref.subject_node_id,'subject node id',64);
      if(!uuid.test(evidence_id)||!uuid.test(run_id)||!/^[A-Za-z0-9._:-]{1,64}$/.test(subject_node_id))throw new Error('Invalid evidence reference identifier');
      const canonical={evidence_id:evidence_id.toLowerCase(),run_id:run_id.toLowerCase(),subject_node_id};
      if(seen.has(canonical.evidence_id))throw new Error('Evidence references must be unique');
      seen.add(canonical.evidence_id);
      return canonical;
    });
    const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
    return refs.sort((a,b)=>compare(a.evidence_id,b.evidence_id)||compare(a.run_id,b.run_id)||compare(a.subject_node_id,b.subject_node_id));
  }
  #validateEvidenceRefs(refs:EvidenceReference[],endpoints?:readonly string[]):void{
    if(endpoints&&(!refs.some(ref=>endpoints.includes(ref.subject_node_id))||refs.some(ref=>!endpoints.includes(ref.subject_node_id))))throw new Error('Edge evidence subjects must be proposal endpoints');
    const check=this.#database.prepare(`SELECT 1 FROM evidence e JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id
      JOIN nodes n ON n.project_id=e.project_id AND n.environment=? AND n.id=e.subject_node_id
      WHERE e.project_id=? AND e.id=? AND e.run_id=? AND e.subject_node_id=? AND e.kind='assertion' AND e.outcome='passed'
        AND r.memory_environment=? AND r.status='passed' AND n.tombstone=0 AND n.superseded_by IS NULL
        AND n.verification_status NOT IN ('stale','superseded') AND n.conflict_status='none'`);
    for(const ref of refs)if(!check.get(this.memoryEnvironment,this.projectId,ref.evidence_id,ref.run_id,ref.subject_node_id,this.memoryEnvironment))throw new Error('Evidence reference is not a passed assertion for a live subject in this project and environment');
  }
  #priorEvidenceRefs(input:CandidateObservationInput):{observationIds:Set<string>;refs:EvidenceReference[]}|undefined{
    const rows=this.#database.prepare('SELECT id FROM memory_candidate_observations WHERE project_id=? AND environment=? AND source_kind=? AND source_key=? ORDER BY id').all(this.projectId,this.memoryEnvironment,input.source_kind,input.source_key) as Array<{id:string}>;
    if(!rows.length)return undefined;
    const refsByObservation=rows.map(row=>this.#database.prepare('SELECT evidence_id,run_id,subject_node_id FROM memory_candidate_evidence_refs WHERE project_id=? AND environment=? AND observation_id=? ORDER BY evidence_id').all(this.projectId,this.memoryEnvironment,row.id) as EvidenceReference[]);
    if(refsByObservation.some(refs=>!refs.length))throw new Error('Legacy candidate observations cannot be linked retroactively; use a fresh observation_id');
    const canonical=canonicalJson(refsByObservation[0]);
    if(refsByObservation.some(refs=>canonicalJson(refs)!==canonical))throw new Error('Candidate observation has inconsistent evidence references across pipeline versions');
    return{observationIds:new Set(rows.map(row=>row.id)),refs:refsByObservation[0]!};
  }
  #storeEvidenceRefs(observationId:string,refs:EvidenceReference[]):void{
    const insert=this.#database.prepare('INSERT INTO memory_candidate_evidence_refs(project_id,environment,observation_id,evidence_id,run_id,subject_node_id,created_at) VALUES(?,?,?,?,?,?,?)');
    for(const ref of refs)insert.run(this.projectId,this.memoryEnvironment,observationId,ref.evidence_id,ref.run_id,ref.subject_node_id,new Date().toISOString());
  }
  #exactMcpReplay(input:CandidateObservationInput,refs:EvidenceReference[],kind:'node'|'edge'){
    const row=this.#database.prepare('SELECT id,links_json FROM memory_candidate_observations WHERE project_id=? AND environment=? AND source_kind=? AND source_key=? AND source_revision_hash=? AND pipeline_fingerprint=?').get(this.projectId,this.memoryEnvironment,input.source_kind,input.source_key,input.source_revision_hash,input.pipeline_fingerprint) as {id:string;links_json:string}|undefined;
    if(!row)return undefined;
    const stored=this.#database.prepare('SELECT evidence_id,run_id,subject_node_id FROM memory_candidate_evidence_refs WHERE project_id=? AND environment=? AND observation_id=? ORDER BY evidence_id').all(this.projectId,this.memoryEnvironment,row.id) as EvidenceReference[];
    if(!stored.length)throw new Error('Legacy candidate observations cannot be linked retroactively; use a fresh observation_id');
    if(canonicalJson(stored)!==canonicalJson(refs))throw new Error('Candidate observation already exists with different evidence references');
    try{
      const links=JSON.parse(row.links_json);
      if(!Array.isArray(links))return undefined;
      const link=links.find((entry:any)=>entry?.kind===kind&&typeof entry.id==='string');
      if(!link)return undefined;
      return this.#database.prepare(`SELECT * FROM ${kind==='node'?'nodes':'edges'} WHERE project_id=? AND environment=? AND id=?`).get(this.projectId,this.memoryEnvironment,link.id);
    }catch{return undefined;}
  }
  listCandidateEvidenceReferences(observationId:string):Array<EvidenceReference&{valid:boolean;status:'current'|'invalid'}>{
    if(!/^[a-f0-9]{64}$/.test(observationId))throw new Error('Invalid candidate observation id');
    const rows=this.#database.prepare('SELECT evidence_id,run_id,subject_node_id FROM memory_candidate_evidence_refs WHERE project_id=? AND environment=? AND observation_id=? ORDER BY evidence_id LIMIT 5').all(this.projectId,this.memoryEnvironment,observationId) as EvidenceReference[];
    const check=this.#database.prepare(`SELECT 1 FROM evidence e JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id JOIN nodes n ON n.project_id=e.project_id AND n.environment=? AND n.id=e.subject_node_id WHERE e.project_id=? AND e.id=? AND e.run_id=? AND e.subject_node_id=? AND e.kind='assertion' AND e.outcome='passed' AND r.memory_environment=? AND r.status='passed' AND n.tombstone=0 AND n.superseded_by IS NULL AND n.verification_status NOT IN ('stale','superseded') AND n.conflict_status='none'`);
    return rows.map(ref=>{const valid=Boolean(check.get(this.memoryEnvironment,this.projectId,ref.evidence_id,ref.run_id,ref.subject_node_id,this.memoryEnvironment));return{...ref,valid,status:valid?'current' as const:'invalid' as const};});
  }
  #commitMcpNode(input:McpNodeWrite){
    assertMcpGraphNodeType(input.type);
    if(!hasNlpMetadata(input.attributes))throw Error('NLP ingestion is required');
    if(!input.stable_key||input.stable_key.length>200||!input.display_name||input.display_name.length>500)throw Error('Knowledge field too long');
    const refs=this.#canonicalEvidenceRefs(input.evidence_refs);
    return this.#withGraphMutation(()=>this.#database.transaction(()=>{
       const observationId=this.#candidateGraphIdentity(input.observation),deterministicNodeId=createHash('sha256').update(`mcp-node:${observationId}`).digest('hex');
       this.#assertMcpSourceRevision(input.observation);
       const replay=this.#exactMcpReplay(input.observation,refs,'node');if(replay)return replay;
       this.#validateEvidenceRefs(refs);
      const priorEvidence=this.#priorEvidenceRefs(input.observation);
      if(priorEvidence&&canonicalJson(priorEvidence.refs)!==canonicalJson(refs))throw new Error('Candidate observation already exists with different evidence references');
      const priorLink=this.#priorMcpGraphLink(input.observation);
      const existingByIdentity=this.#database.prepare('SELECT * FROM nodes WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,priorLink??deterministicNodeId) as any;
      const candidates=this.#database.prepare('SELECT * FROM nodes WHERE project_id=? AND environment=? AND type=? AND canonical_key=? AND tombstone=0 ORDER BY id').all(this.projectId,this.memoryEnvironment,input.type,input.stable_key) as Array<{id:string;display_name:string;attributes_json:string;conflict_status:string}>;
      const matching=candidates.find(node=>node.display_name===input.display_name&&semanticAttributesJson(node.attributes_json)===semanticAttributesJson(input.attributes));
      const occupied=candidates.find(node=>node.id!==matching?.id&&node.id!==existingByIdentity?.id);
      const nodeId=priorLink??matching?.id??existingByIdentity?.id??deterministicNodeId;
      const priorObservation=this.#database.prepare('SELECT status FROM memory_candidate_observations WHERE project_id=? AND environment=? AND source_kind=? AND source_key=? AND source_revision_hash=? AND pipeline_fingerprint=?').get(this.projectId,this.memoryEnvironment,input.observation.source_kind,input.observation.source_key,input.observation.source_revision_hash,input.observation.pipeline_fingerprint) as {status:string}|undefined;
      const status=(priorObservation?.status??(matching?.conflict_status==='conflict'||(!matching&&occupied)?'conflict':'proposed')) as CandidateObservationStatus;
      const obs={...input.observation,status,links:[{kind:'node',id:nodeId}]};
         const storedObservation=this.#appendCandidateObservation(obs);
       if(existingByIdentity||matching){if(!priorEvidence?.observationIds.has(storedObservation.id))this.#storeEvidenceRefs(storedObservation.id,refs);return existingByIdentity??this.get(nodeId);}
      const stored=occupied||existingByIdentity?`agent:${observationId}:${input.stable_key}`:input.stable_key;
       if(occupied)this.#database.prepare("UPDATE nodes SET conflict_status='conflict',conflicting_node_id=? WHERE project_id=? AND environment=? AND id=?").run(nodeId,this.projectId,this.memoryEnvironment,occupied.id);
       this.#database.prepare('INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence,conflict_status,conflicting_node_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(nodeId,this.projectId,this.memoryEnvironment,input.type,stored,input.stable_key,input.display_name,JSON.stringify(input.attributes),'agent','proposed',0.5,occupied?'conflict':'none',occupied?.id??null);
       if(!priorEvidence?.observationIds.has(storedObservation.id))this.#storeEvidenceRefs(storedObservation.id,refs);
       return this.get(nodeId);
    })());
  }
  #commitMcpEdge(input:McpEdgeWrite){
    if(!hasNlpMetadata(input.attributes))throw Error('NLP ingestion is required');
    const refs=this.#canonicalEvidenceRefs(input.evidence_refs);
    return this.#withGraphMutation(()=>this.#database.transaction(()=>{
       const observationId=this.#candidateGraphIdentity(input.observation),deterministicId=createHash('sha256').update(`mcp-edge:${observationId}`).digest('hex'),stableKey=`mcp:${observationId}:${input.from_id}:${input.relation}:${input.to_id}`;
       this.#assertMcpSourceRevision(input.observation);
       const replay=this.#exactMcpReplay(input.observation,refs,'edge');if(replay)return replay;
       this.validateMcpEdgeSignature(input.from_id,input.to_id,input.relation);
       this.#validateEvidenceRefs(refs,[input.from_id,input.to_id]);
      const priorEvidence=this.#priorEvidenceRefs(input.observation);
      if(priorEvidence&&canonicalJson(priorEvidence.refs)!==canonicalJson(refs))throw new Error('Candidate observation already exists with different evidence references');
      const semanticAttrs=semanticAttributesJson(input.attributes),otherEdges=this.#database.prepare('SELECT id,attributes_json,conflict_status FROM edges WHERE project_id=? AND environment=? AND from_node_id=? AND to_node_id=? AND relation_type=? AND tombstone=0 ORDER BY id').all(this.projectId,this.memoryEnvironment,input.from_id,input.to_id,input.relation) as Array<{id:string;attributes_json:string;conflict_status:string}>;
      const matching=otherEdges.find(edge=>semanticAttributesJson(edge.attributes_json)===semanticAttrs);
      const conflictEdges=otherEdges.filter(edge=>!matching&&semanticAttributesJson(edge.attributes_json)!==semanticAttrs);
      const priorLink=this.#priorMcpGraphLink(input.observation),id=priorLink??matching?.id??deterministicId;
      const existing=this.#database.prepare('SELECT * FROM edges WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,id);
      const priorObservation=this.#database.prepare('SELECT status FROM memory_candidate_observations WHERE project_id=? AND environment=? AND source_kind=? AND source_key=? AND source_revision_hash=? AND pipeline_fingerprint=?').get(this.projectId,this.memoryEnvironment,input.observation.source_kind,input.observation.source_key,input.observation.source_revision_hash,input.observation.pipeline_fingerprint) as {status:string}|undefined;
      const obs={...input.observation,status:(priorObservation?.status??(matching?.conflict_status==='conflict'||conflictEdges.length?'conflict':'proposed')) as CandidateObservationStatus,links:[{kind:'edge',id}]};
       const storedObservation=this.#appendCandidateObservation(obs);
       if(existing||matching){if(!priorEvidence?.observationIds.has(storedObservation.id))this.#storeEvidenceRefs(storedObservation.id,refs);return existing??matching;}
      for(const edge of conflictEdges)this.#database.prepare("UPDATE edges SET conflict_status='conflict',conflicting_edge_id=? WHERE project_id=? AND environment=? AND id=?").run(id,this.projectId,this.memoryEnvironment,edge.id);
       this.#database.prepare('INSERT INTO edges(id,project_id,environment,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,stable_key) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,this.projectId,this.memoryEnvironment,input.from_id,input.to_id,input.relation,JSON.stringify(input.attributes),'agent','proposed',stableKey);
       if(conflictEdges.length)this.#database.prepare("UPDATE edges SET conflict_status='conflict',conflicting_edge_id=? WHERE project_id=? AND environment=? AND id=?").run(conflictEdges[0]!.id,this.projectId,this.memoryEnvironment,id);
       if(!priorEvidence?.observationIds.has(storedObservation.id))this.#storeEvidenceRefs(storedObservation.id,refs);
       return this.#database.prepare('SELECT * FROM edges WHERE id=?').get(id);
    })());
  }
  #assertMcpSourceRevision(input:CandidateObservationInput):void{
    const source=this.#database.prepare('SELECT source_revision_hash FROM memory_candidate_observations WHERE project_id=? AND environment=? AND source_kind=? AND source_key=? ORDER BY created_at LIMIT 1').get(this.projectId,this.memoryEnvironment,input.source_kind,input.source_key) as {source_revision_hash:string}|undefined;
    if(source&&source.source_revision_hash!==input.source_revision_hash)throw new Error('observation_id was already used for different redacted source; use a fresh observation_id');
  }
  getByTypeKey(type:string,key:string){
    const owned=this.#database.prepare(`SELECT n.* FROM yaml_ownership y JOIN nodes n ON n.project_id=y.project_id AND n.environment=y.environment AND n.id=y.entity_id WHERE y.project_id=? AND y.environment=? AND y.entity_type=? AND y.entity_key=? AND y.tombstone=0 AND n.tombstone=0 ORDER BY y.source_path LIMIT 1`).get(this.projectId,this.memoryEnvironment,type,key);
    return owned??this.#database.prepare('SELECT * FROM nodes WHERE project_id=? AND environment=? AND type=? AND canonical_key=? AND tombstone=0 ORDER BY CASE origin WHEN \'yaml\' THEN 0 ELSE 1 END,id LIMIT 1').get(this.projectId,this.memoryEnvironment,type,key)??null;
  }
    #commitProposedNode(input:{type:string;stable_key:string;display_name:string;attributes:Record<string,unknown>}){
      assertMcpGraphNodeType(input.type);
      if(!hasNlpMetadata(input.attributes))throw Error('NLP ingestion is required');
      if(input.stable_key.length>200||input.display_name.length>500)throw Error('Knowledge field too long');
      return this.#withGraphMutation(()=>this.#database.transaction(()=>{
        const id=randomUUID(),occupied=this.#database.prepare('SELECT * FROM nodes WHERE project_id=? AND environment=? AND type=? AND canonical_key=? AND tombstone=0 LIMIT 1').get(this.projectId,this.memoryEnvironment,input.type,input.stable_key) as {id:string}|undefined;
        let stored=input.stable_key;
        if(occupied){
          stored=`agent:${id}:${input.stable_key}`;
          this.#database.prepare("UPDATE nodes SET conflict_status='conflict',conflicting_node_id=? WHERE project_id=? AND environment=? AND id=?").run(id,this.projectId,this.memoryEnvironment,occupied.id);
        }
        this.#database.prepare('INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence,conflict_status,conflicting_node_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,this.projectId,this.memoryEnvironment,input.type,stored,input.stable_key,input.display_name,JSON.stringify(input.attributes),'agent','proposed',0.5,occupied?'conflict':'none',occupied?.id??null);
        return this.get(id);
      })());
    }
    #commitPreparedEdge(input:{from_id:string;to_id:string;relation:string;attributes:Record<string,unknown>}){
      if(!hasNlpMetadata(input.attributes))throw Error('NLP ingestion is required');
      const id=randomUUID(),stableKey=`${input.from_id}:${input.relation}:${input.to_id}`;
      return this.#withGraphMutation(()=>this.#database.transaction(()=>{
        this.validateMcpEdgeSignature(input.from_id,input.to_id,input.relation);
        this.#database.prepare('INSERT INTO edges(id,project_id,environment,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,stable_key) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,environment,origin,stable_key) DO UPDATE SET attributes_json=excluded.attributes_json').run(id,this.projectId,this.memoryEnvironment,input.from_id,input.to_id,input.relation,JSON.stringify(input.attributes),'agent','proposed',stableKey);
        return this.#database.prepare('SELECT * FROM edges WHERE project_id=? AND environment=? AND origin=? AND stable_key=?').get(this.projectId,this.memoryEnvironment,'agent',stableKey);
      })());
    }
     #commitReconciliation(plan:YamlReconciliationPlan){return this.#withGraphMutation(()=>commitYamlReconciliation(this.#database,this.projectId,this.memoryEnvironment,plan,input=>this.#appendCandidateObservation(input)));}
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
  hasYamlCandidateObservation(input:{source_key:string;source_revision_hash:string;pipeline_fingerprint:string}):boolean{
    return this.#database.prepare(`SELECT 1 FROM memory_candidate_observations
      WHERE project_id=? AND environment=? AND source_kind='yaml_document' AND source_key=? AND source_revision_hash=? AND pipeline_fingerprint=? LIMIT 1`)
      .get(this.projectId,this.memoryEnvironment,input.source_key,input.source_revision_hash,input.pipeline_fingerprint)!==undefined;
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
  markMemoryBackfillPending(jobId:string,item:{entityKind:'node'|'edge';entityId:string}):void{
    this.#database.prepare("UPDATE memory_backfill_items SET status='pending',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind=? AND entity_id=? AND status<>'obsolete'").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,jobId,item.entityKind,item.entityId);
  }
  memoryBackfillBatch(jobId:string,limit=10,after?:BackfillCursor):BackfillRecord[]{
    const cap=Math.max(1,Math.min(50,Math.trunc(limit)));
    if(!this.#database.prepare('SELECT 1 FROM memory_backfill_jobs WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,jobId))throw Error('Backfill job not found in this Store environment');
    const items=(after
      ?this.#database.prepare("SELECT entity_kind,entity_id,payload_hash,redacted_hash FROM memory_backfill_items WHERE project_id=? AND environment=? AND job_id=? AND status='pending' AND (entity_kind>? OR (entity_kind=? AND entity_id>?)) ORDER BY entity_kind,entity_id LIMIT ?").all(this.projectId,this.memoryEnvironment,jobId,after.entityKind,after.entityKind,after.entityId,cap)
      :this.#database.prepare("SELECT entity_kind,entity_id,payload_hash,redacted_hash FROM memory_backfill_items WHERE project_id=? AND environment=? AND job_id=? AND status='pending' ORDER BY entity_kind,entity_id LIMIT ?").all(this.projectId,this.memoryEnvironment,jobId,cap)) as Array<{entity_kind:'node'|'edge';entity_id:string;payload_hash:string;redacted_hash:string|null}>;
    const out:BackfillRecord[]=[];
    for(const item of items){
      if(item.entity_kind==='node'){
        const row=this.#database.prepare('SELECT id,type,stable_key,display_name,attributes_json FROM nodes WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,item.entity_id) as {id:string;type:string;stable_key:string;display_name:string;attributes_json:string}|undefined;
        if(!row){this.#database.prepare("UPDATE memory_backfill_items SET status='obsolete',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='node' AND entity_id=?").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,jobId,item.entity_id);continue;}
         try{out.push({kind:'node',record:{...this.#backfillNodeValue(row),id:row.id,payloadHash:item.payload_hash,redactedHash:item.redacted_hash??''},backfillStatus:'pending'});}catch{throw new BackfillRecordReadError();}
      }else{
        const row=this.#database.prepare('SELECT id,from_node_id,to_node_id,relation_type,attributes_json FROM edges WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,item.entity_id) as {id:string;from_node_id:string;to_node_id:string;relation_type:string;attributes_json:string}|undefined;
        if(!row){this.#database.prepare("UPDATE memory_backfill_items SET status='obsolete',updated_at=? WHERE project_id=? AND environment=? AND job_id=? AND entity_kind='edge' AND entity_id=?").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,jobId,item.entity_id);continue;}
         try{out.push({kind:'edge',record:{...this.#backfillEdgeValue(row),id:row.id,payloadHash:item.payload_hash,redactedHash:item.redacted_hash??''},backfillStatus:'pending'});}catch{throw new BackfillRecordReadError();}
      }
    }
    return out;
  }
  memoryBackfillRecords(jobId:string,offset=0,limit=50):BackfillRecord[]{
    const cap=Math.max(1,Math.min(50,Math.trunc(limit))),skip=Math.max(0,Math.trunc(offset));
    if(!this.#database.prepare('SELECT 1 FROM memory_backfill_jobs WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,jobId))throw Error('Backfill job not found in this Store environment');
    const items=this.#database.prepare("SELECT entity_kind,entity_id,payload_hash,redacted_hash,status FROM memory_backfill_items WHERE project_id=? AND environment=? AND job_id=? AND status<>'obsolete' ORDER BY entity_kind,entity_id LIMIT ? OFFSET ?").all(this.projectId,this.memoryEnvironment,jobId,cap,skip) as Array<{entity_kind:'node'|'edge';entity_id:string;payload_hash:string;redacted_hash:string|null;status:'pending'|'processed'}>;
    const out:BackfillRecord[]=[];
    for(const item of items){
      if(item.entity_kind==='node'){
        const row=this.#database.prepare('SELECT id,type,stable_key,display_name,attributes_json FROM nodes WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,item.entity_id) as {id:string;type:string;stable_key:string;display_name:string;attributes_json:string}|undefined;
         if(row)try{out.push({kind:'node',record:{...this.#backfillNodeValue(row),id:row.id,payloadHash:item.payload_hash,redactedHash:item.redacted_hash??''},backfillStatus:item.status});}catch{throw new BackfillRecordReadError();}
      }else{
        const row=this.#database.prepare('SELECT id,from_node_id,to_node_id,relation_type,attributes_json FROM edges WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,item.entity_id) as {id:string;from_node_id:string;to_node_id:string;relation_type:string;attributes_json:string}|undefined;
         if(row)try{out.push({kind:'edge',record:{...this.#backfillEdgeValue(row),id:row.id,payloadHash:item.payload_hash,redactedHash:item.redacted_hash??''},backfillStatus:item.status});}catch{throw new BackfillRecordReadError();}
      }
    }
    return out;
  }
  finishMemoryBackfill(jobId:string,invocation:BackfillSummary['invocation']={scanned:0,migrated:0,merged:0,rejected:0,stale:0,failed:0,unchanged:0}):BackfillSummary{
    const pending=(this.#database.prepare("SELECT count(*) count FROM memory_backfill_items WHERE project_id=? AND environment=? AND job_id=? AND status='pending'").get(this.projectId,this.memoryEnvironment,jobId) as {count:number}).count;
    if(pending===0)this.#database.prepare("UPDATE memory_backfill_jobs SET status='completed',completed_at=COALESCE(completed_at,?),updated_at=? WHERE project_id=? AND environment=? AND id=?").run(new Date().toISOString(),new Date().toISOString(),this.projectId,this.memoryEnvironment,jobId);
    else this.#database.prepare("UPDATE memory_backfill_jobs SET status='running',completed_at=NULL,updated_at=? WHERE project_id=? AND environment=? AND id=?").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,jobId);
    return this.memoryBackfillSummary(jobId,invocation);
  }
  interruptMemoryBackfill(jobId:string):void{this.#database.prepare("UPDATE memory_backfill_jobs SET status='interrupted',updated_at=? WHERE project_id=? AND environment=? AND id=? AND status<>'completed'").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,jobId);}
  memoryBackfillSummary(jobId:string,invocation:BackfillSummary['invocation']={scanned:0,migrated:0,merged:0,rejected:0,stale:0,failed:0,unchanged:0}):BackfillSummary{
    const job=this.#database.prepare('SELECT id,environment,status FROM memory_backfill_jobs WHERE project_id=? AND environment=? AND id=?').get(this.projectId,this.memoryEnvironment,jobId) as {id:string;environment:string;status:BackfillSummary['status']}|undefined;
    if(!job)throw Error('Backfill job not found in this Store environment');
    const counts=this.#database.prepare("SELECT count(*) total,sum(status='processed') processed,sum(status='pending') pending,sum(status='obsolete') obsolete FROM memory_backfill_items WHERE project_id=? AND environment=? AND job_id=?").get(this.projectId,this.memoryEnvironment,jobId) as {total:number;processed:number|null;pending:number|null;obsolete:number|null};
    return{jobId:job.id,environment:job.environment,status:job.status,total:counts.total,processed:counts.processed??0,pending:counts.pending??0,obsolete:counts.obsolete??0,invocation};
  }
  #commitBackfillNode(input:BackfillNodeWrite):boolean{
    if(!hasNlpMetadata(input.attributes))throw Error('NLP ingestion is required');
    const source={type:input.type,stable_key:input.stable_key,display_name:input.display_name,attributes:withoutNlpMetadata(input.attributes)};
    if(input.observation.source_kind!=='backfill_node'||input.observation.source_key!==`node:${input.id}`||input.observation.source_revision_hash!==input.redactedHash
      ||input.observation.status!=='proposed'||!Array.isArray(input.observation.links)||input.observation.links.length!==0||input.observation.redacted_source_text!==stableJson(source))throw Error('Invalid backfill observation provenance');
    return this.#withGraphMutation(()=>this.#database.transaction(()=>{
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
        this.#appendCandidateObservation(input.observation);
       return true;
    })());
  }
  #commitBackfillEdge(input:BackfillEdgeWrite):boolean{
    if(!hasNlpMetadata(input.attributes))throw Error('NLP ingestion is required');
    const source={from_id:input.from_id,to_id:input.to_id,relation:input.relation,attributes:withoutNlpMetadata(input.attributes)};
    if(input.observation.source_kind!=='backfill_edge'||input.observation.source_key!==`edge:${input.id}`||input.observation.source_revision_hash!==input.redactedHash
      ||input.observation.status!=='proposed'||!Array.isArray(input.observation.links)||input.observation.links.length!==0||input.observation.redacted_source_text!==stableJson(source))throw Error('Invalid backfill observation provenance');
      return this.#withGraphMutation(()=>this.#database.transaction(()=>{
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
        this.#appendCandidateObservation(input.observation);
       return true;
      })());
  }
    listEdges(nodeId?:string){return nodeId?this.#database.prepare('SELECT * FROM edges WHERE project_id=? AND environment=? AND tombstone=0 AND (from_node_id=? OR to_node_id=?)').all(this.projectId,this.memoryEnvironment,nodeId,nodeId):this.#database.prepare('SELECT * FROM edges WHERE project_id=? AND environment=? AND tombstone=0').all(this.projectId,this.memoryEnvironment);}
  neighbors(nodeId:string,limit=50,options:MemoryReadOptions={}){
    const trust=options.trustYamlSeeds===true;if(!this.getTrustedNode(nodeId,options))return[];
    const rows=this.#database.prepare(`SELECT n.id,n.type,n.canonical_key stable_key,n.display_name,n.origin,n.verification_status,n.conflict_status,
      ${this.#nodeTrustBasisSql('n',trust)} neighbor_trust_basis,e.id edge_id,e.relation_type relation,e.from_node_id,e.to_node_id,e.origin edge_origin,e.verification_status edge_verification_status,e.conflict_status edge_conflict_status,
      ${this.#edgeTrustBasisSql('e',trust)} edge_trust_basis,CASE WHEN e.from_node_id=? THEN 'outgoing' ELSE 'incoming' END direction
      FROM edges e JOIN nodes f ON f.project_id=e.project_id AND f.environment=e.environment AND f.id=e.from_node_id
      JOIN nodes t ON t.project_id=e.project_id AND t.environment=e.environment AND t.id=e.to_node_id
      JOIN nodes n ON n.project_id=e.project_id AND n.environment=e.environment AND n.id=CASE WHEN e.from_node_id=? THEN e.to_node_id ELSE e.from_node_id END
      WHERE e.project_id=? AND e.environment=? AND (e.from_node_id=? OR e.to_node_id=?) AND ${this.#trustedEdgeSql('e',trust)}
      AND ${this.#trustedNodeSql('f',trust)} AND ${this.#trustedNodeSql('t',trust)} ORDER BY e.id LIMIT ?`).all(nodeId,nodeId,this.projectId,this.memoryEnvironment,nodeId,nodeId,Math.max(0,Math.min(200,limit))) as Array<Record<string,any>>;
    return rows.map(row=>({neighbor:{id:row.id,type:row.type,stable_key:row.stable_key,display_name:row.display_name,origin:row.origin,verification_status:row.verification_status,conflict_status:row.conflict_status,trust_basis:row.neighbor_trust_basis},edge:{id:row.edge_id,relation:row.relation,from_id:row.from_node_id,to_id:row.to_node_id,direction:row.direction,origin:row.edge_origin,verification_status:row.edge_verification_status,conflict_status:row.edge_conflict_status,trust_basis:row.edge_trust_basis}}));
  }
  listConflicts(){return this.#database.prepare(`SELECT 'node' kind,id,canonical_key entity_key,conflict_status FROM nodes WHERE project_id=? AND environment=? AND conflict_status<>'none' UNION ALL SELECT 'edge',id,relation_type,conflict_status FROM edges WHERE project_id=? AND environment=? AND conflict_status<>'none' UNION ALL SELECT 'yaml',entity_id,entity_key,conflict_status FROM yaml_ownership WHERE project_id=? AND environment=? AND conflict_status<>'none'`).all(this.projectId,this.memoryEnvironment,this.projectId,this.memoryEnvironment,this.projectId,this.memoryEnvironment);}
   tombstoneEdge(id:string){return this.#withGraphMutation(()=>this.#database.prepare('UPDATE edges SET tombstone=1,updated_at=? WHERE project_id=? AND environment=? AND id=?').run(new Date().toISOString(),this.projectId,this.memoryEnvironment,id).changes>0);}
  path(from:string,to:string,maxDepth=5,options:MemoryReadOptions={}){
    if(!this.getTrustedNode(from,options)||!this.getTrustedNode(to,options))return null;
    const cap=Math.max(0,Math.min(10,Math.trunc(maxDepth)));if(from===to)return{node_ids:[from],edges:[]};if(cap===0)return null;
    const trust=options.trustYamlSeeds===true,rows=this.#database.prepare(`SELECT e.id edge_id,e.from_node_id,e.to_node_id,e.relation_type relation,e.origin,e.verification_status,e.conflict_status,${this.#edgeTrustBasisSql('e',trust)} trust_basis
      FROM edges e JOIN nodes f ON f.project_id=e.project_id AND f.environment=e.environment AND f.id=e.from_node_id
      JOIN nodes t ON t.project_id=e.project_id AND t.environment=e.environment AND t.id=e.to_node_id
      WHERE e.project_id=? AND e.environment=? AND e.relation_type='NAVIGATES_TO' AND ((f.type='screen' AND t.type='screen') OR (f.type='action' AND t.type='screen'))
      AND ${this.#trustedEdgeSql('e',trust)} AND ${this.#trustedNodeSql('f',trust)} AND ${this.#trustedNodeSql('t',trust)} ORDER BY e.id LIMIT 5000`).all(this.projectId,this.memoryEnvironment) as Array<Record<string,any>>;
    const adjacency=new Map<string,Array<Record<string,any>>>();for(const row of rows){const list=adjacency.get(row.from_node_id)??[];list.push(row);adjacency.set(row.from_node_id,list);}
    const queue=[from],seen=new Set([from]),previous=new Map<string,{from:string;edge:Record<string,any>}>();let visits=0;
    while(queue.length&&visits++<2000){const current=queue.shift()!,depth=this.#pathDepth(current,from,previous);if(depth>=cap)continue;for(const edge of adjacency.get(current)??[]){if(seen.has(edge.to_node_id))continue;seen.add(edge.to_node_id);previous.set(edge.to_node_id,{from:current,edge});if(edge.to_node_id===to){const nodeIds=[to],pathEdges:Record<string,any>[]=[];let cursor=to;while(cursor!==from){const step=previous.get(cursor)!;pathEdges.push(step.edge);cursor=step.from;nodeIds.push(cursor);}nodeIds.reverse();pathEdges.reverse();return{node_ids:nodeIds,edges:pathEdges.map(item=>({id:item.edge_id,relation:item.relation,from_id:item.from_node_id,to_id:item.to_node_id,origin:item.origin,verification_status:item.verification_status,conflict_status:item.conflict_status,trust_basis:item.trust_basis}))};}queue.push(edge.to_node_id);}}
    return null;
  }
  #pathDepth(node:string,start:string,previous:Map<string,{from:string;edge:Record<string,any>}>):number{let depth=0,current=node;while(current!==start){const step=previous.get(current);if(!step)return Number.MAX_SAFE_INTEGER;current=step.from;depth++;}return depth;}
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
  verificationReview(id:string,runId:string){
    const node=this.#database.prepare("SELECT id,type,canonical_key,display_name FROM nodes n WHERE n.project_id=? AND n.environment=? AND n.id=? AND n.origin='agent' AND n.verification_status='proposed' AND n.conflict_status='none' AND n.tombstone=0 AND n.superseded_by IS NULL AND NOT EXISTS(SELECT 1 FROM yaml_ownership y WHERE y.project_id=n.project_id AND y.environment=n.environment AND y.entity_id=n.id AND y.tombstone=0)").get(this.projectId,this.memoryEnvironment,id) as {id:string;type:string;canonical_key:string;display_name:string}|undefined;
    if(!node)return null;
    const run=this.#database.prepare('SELECT id FROM runs WHERE project_id=? AND memory_environment=? AND id=?').get(this.projectId,this.memoryEnvironment,runId);if(!run)return null;
    const assertions=this.#database.prepare("SELECT e.id,e.created_at,e.metadata_json FROM evidence e WHERE e.project_id=? AND e.run_id=? AND e.subject_node_id=? AND e.kind='assertion' AND e.outcome='passed' ORDER BY e.created_at,e.id LIMIT 50").all(this.projectId,runId,id) as Array<{id:string;created_at:string;metadata_json:string}>;
    if(!assertions.length)return null;
    return{node,run_id:runId,passing_assertions:assertions.map(({id:evidenceId,created_at,metadata_json})=>{const meta=this.safeReportMetadata('assertion',metadata_json);return{id:evidenceId,created_at,...(typeof meta?.observed_count==='number'?{observed_count:meta.observed_count}:{}),...(Array.isArray(meta?.actions)?{action_count:meta.actions.length}:{})};})};
  }
  verify(id:string,runId:string,approval?:VerificationApproval){
    if(approval?.approved!==true||approval.source!=='local_approver')return false;
     return this.#withGraphMutation(()=>this.#database.transaction(()=>{
      const ev=this.#database.prepare("SELECT 1 FROM evidence e JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id JOIN nodes n ON n.project_id=e.project_id AND n.id=e.subject_node_id WHERE e.project_id=? AND r.memory_environment=? AND n.environment=? AND e.subject_node_id=? AND e.run_id=? AND e.kind='assertion' AND e.outcome='passed' AND n.origin='agent' AND n.tombstone=0 AND n.superseded_by IS NULL AND n.verification_status='proposed' AND n.conflict_status='none' AND NOT EXISTS(SELECT 1 FROM yaml_ownership y WHERE y.project_id=n.project_id AND y.environment=n.environment AND y.entity_id=n.id AND y.tombstone=0) LIMIT 1").get(this.projectId,this.memoryEnvironment,this.memoryEnvironment,id,runId);
      if(!ev)return false;
      const changed=this.#database.prepare("UPDATE nodes SET verification_status='verified',confidence=1,updated_at=? WHERE project_id=? AND environment=? AND id=? AND origin='agent' AND verification_status='proposed' AND tombstone=0 AND superseded_by IS NULL AND conflict_status='none' AND NOT EXISTS(SELECT 1 FROM yaml_ownership y WHERE y.project_id=nodes.project_id AND y.environment=nodes.environment AND y.entity_id=nodes.id AND y.tombstone=0)").run(new Date().toISOString(),this.projectId,this.memoryEnvironment,id).changes;
      if(changed)this.#database.prepare('INSERT INTO memory_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),this.projectId,id,'verify',JSON.stringify({runId}),new Date().toISOString());
      return changed>0;
     })());
  }
  supersede(oldId:string,newId:string){
     return this.#withGraphMutation(()=>this.#database.transaction(()=>{
      if(oldId===newId)throw Error('A node cannot supersede itself');
      const eligible=(id:string)=>this.#database.prepare("SELECT 1 FROM nodes n WHERE n.project_id=? AND n.environment=? AND n.id=? AND n.origin='agent' AND n.tombstone=0 AND n.superseded_by IS NULL AND n.verification_status='verified' AND n.conflict_status='none' AND NOT EXISTS(SELECT 1 FROM yaml_ownership y WHERE y.project_id=n.project_id AND y.environment=n.environment AND y.entity_id=n.id AND y.tombstone=0)").get(this.projectId,this.memoryEnvironment,id);
      if(!eligible(oldId))throw Error('Old node must be a live, verified, conflict-free agent record');
      if(!eligible(newId))throw Error('Replacement node must be a live, verified, conflict-free agent record in this Store environment');
       const now=new Date().toISOString();
       const changed=this.#database.prepare("UPDATE nodes SET tombstone=1,superseded_by=?,verification_status='stale',updated_at=? WHERE project_id=? AND environment=? AND id=? AND id<>? AND origin='agent' AND verification_status='verified' AND tombstone=0 AND superseded_by IS NULL AND conflict_status='none' AND NOT EXISTS(SELECT 1 FROM yaml_ownership y WHERE y.project_id=nodes.project_id AND y.environment=nodes.environment AND y.entity_id=nodes.id AND y.tombstone=0)").run(newId,now,this.projectId,this.memoryEnvironment,oldId,newId).changes;
      if(!changed)throw Error('Old node is no longer eligible for supersession');
       if(changed)this.#database.prepare('INSERT INTO memory_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),this.projectId,oldId,'supersede',JSON.stringify({newId}),now);
       appendLifecycleEvent(this.#database,{projectId:this.projectId,environment:this.memoryEnvironment,entityKind:'node',entityId:oldId,action:'superseded',fromState:'verified',toState:'stale',reasonCode:'superseded_by_replacement',relatedEntityKind:'node',relatedEntityId:newId,context:{superseded_by:newId},createdAt:now});
       return changed>0;
     })());
  }
  recallWorkflowCandidates(context:WorkflowRecallContext){
      const cap=Math.max(1,Math.min(3,Math.trunc(context.limit??3))),goalTokens=new Set((context.goal.slice(0,500).toLowerCase().match(/[a-z0-9_-]+/g)??[]));
      const trustYamlSeeds=context.trustYamlSeeds===true;
     let pathname='/';try{pathname=new URL(context.currentUrl).pathname.replace(/\/$/,'')||'/';}catch{}
     type Screen={id:string;canonical_key:string;stable_key:string;display_name:string;attributes_json:string;tombstone:number};
      const screens=this.#database.prepare(`SELECT id,canonical_key,stable_key,display_name,attributes_json,tombstone FROM nodes n WHERE n.project_id=? AND n.environment=? AND n.type='screen' AND ${this.#trustedNodeSql('n',trustYamlSeeds)}`).all(this.projectId,this.memoryEnvironment) as Screen[];
     const byRef=new Map<string,Screen>();for(const screen of screens)for(const key of [screen.id,screen.canonical_key,screen.stable_key,`screen:${screen.canonical_key}`,`screen:${screen.stable_key}`])byRef.set(key,screen);
     const resolve=(key:unknown):Screen|undefined=>typeof key==='string'?byRef.get(key)??byRef.get(key.replace(/^screen:/,'')):undefined;
     const routes:Array<{path:string;screen:Screen}>=[];
     for(const screen of screens){let attrs:any={};try{attrs=JSON.parse(screen.attributes_json);}catch{}if(typeof attrs.route==='string'&&attrs.route.startsWith('/'))routes.push({path:attrs.route,screen});}
      const app=this.#database.prepare(`SELECT attributes_json FROM nodes n WHERE n.project_id=? AND n.environment=? AND n.type='application' AND ${this.#trustedNodeSql('n',trustYamlSeeds)} ORDER BY n.id LIMIT 1`).get(this.projectId,this.memoryEnvironment) as {attributes_json:string}|undefined;
     try{for(const route of JSON.parse(app?.attributes_json??'{}').route_patterns??[]){const screen=resolve(route.screen);if(screen&&typeof route.path==='string'&&route.path.startsWith('/'))routes.push({path:route.path,screen});}}catch{}
     const matches=(pattern:string)=>{const re=pattern.split('/').map(x=>x.startsWith(':')?'[^/]+':x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('/');return new RegExp(`^${re}/?$`).test(pathname);};
     const route=routes.filter(x=>matches(x.path)).sort((a,b)=>b.path.length-a.path.length||a.screen.canonical_key.localeCompare(b.screen.canonical_key))[0];
     const current=route?.screen;
       const rows=this.#database.prepare(`SELECT e.from_node_id,e.to_node_id,f.type from_type,t.type to_type FROM edges e JOIN nodes f ON f.project_id=e.project_id AND f.environment=e.environment AND f.id=e.from_node_id JOIN nodes t ON t.project_id=e.project_id AND t.environment=e.environment AND t.id=e.to_node_id WHERE e.project_id=? AND e.environment=? AND ${this.#trustedEdgeSql('e',trustYamlSeeds)} AND ${this.#trustedNodeSql('f',trustYamlSeeds)} AND ${this.#trustedNodeSql('t',trustYamlSeeds)} AND ((e.relation_type='TRIGGERED_BY' AND f.type='screen' AND t.type='action') OR (e.relation_type='NAVIGATES_TO' AND ((f.type='action' AND t.type='screen') OR (f.type='screen' AND t.type='screen')))) ORDER BY e.from_node_id,e.relation_type,e.to_node_id,e.id`).all(this.projectId,this.memoryEnvironment) as Array<{from_node_id:string;to_node_id:string;from_type:string;to_type:string}>;
      const adjacency=new Map<string,Array<{id:string;type:string}>>();for(const edge of rows){const list=adjacency.get(edge.from_node_id)??[];list.push({id:edge.to_node_id,type:edge.to_type});adjacency.set(edge.from_node_id,list);}
      const findPath=(from:string,to:string)=>{if(from===to)return{screens:[from],actions:[] as string[],length:0};const queue:Array<{id:string;screens:string[];actions:string[];depth:number}>=[{id:from,screens:[from],actions:[],depth:0}],seen=new Set([from]);let visited=0;while(queue.length&&visited<500){const cur=queue.shift()!;visited++;if(cur.depth>=5)continue;for(const next of adjacency.get(cur.id)??[]){if(++visited>500)return null;if(next.type==='screen'){if(seen.has(next.id))continue;const screenPath=[...cur.screens,next.id],depth=cur.depth+1;if(next.id===to)return{screens:screenPath,actions:cur.actions,length:depth};seen.add(next.id);queue.push({id:next.id,screens:screenPath,actions:cur.actions,depth});continue;}if(next.type!=='action')continue;for(const dest of adjacency.get(next.id)??[]){if(++visited>500)return null;if(dest.type!=='screen'||seen.has(dest.id))continue;const screensPath=[...cur.screens,dest.id],actionsPath=[...cur.actions,next.id],depth=cur.depth+1;if(dest.id===to)return{screens:screensPath,actions:actionsPath,length:depth};seen.add(dest.id);queue.push({id:dest.id,screens:screensPath,actions:actionsPath,depth});}}}return null;};
      const rowsW=this.#database.prepare("SELECT n.*,y.source_path FROM nodes n JOIN yaml_ownership y ON y.project_id=n.project_id AND y.environment=n.environment AND y.entity_id=n.id AND y.entity_type='workflow' AND y.entity_key=n.canonical_key AND y.tombstone=0 AND y.conflict_status='none' JOIN yaml_sources ys ON ys.project_id=y.project_id AND ys.environment=y.environment AND ys.path=y.source_path AND ys.active=1 AND ys.hash=y.hash WHERE n.project_id=? AND n.environment=? AND n.type='workflow' AND n.origin='yaml' AND n.tombstone=0 AND n.superseded_by IS NULL AND n.conflict_status='none' AND n.verification_status NOT IN ('stale','superseded') AND n.content_hash=y.hash ORDER BY n.id LIMIT 500").all(this.projectId,this.memoryEnvironment) as Array<RecallNode&{source_path:string}>;
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
        const trustBasis=node.verification_status==='verified'?'verified_fact':trustYamlSeeds?'trusted_seed':'authored_unverified';
        candidates.push({workflow_id:String(wf.id??node.canonical_key),name:node.display_name,source:'yaml',trust_basis:trustBasis,trust_status:trustBasis,...(trustBasis==='authored_unverified'?{guidance_warning:'Authored YAML workflow is unverified; revalidate routes and steps against the current application before acting.'}:{}),verification_status:node.verification_status,start_screen_id:start?.canonical_key??null,end_screen_id:end?.canonical_key??null,score,confidence:node.confidence,uncertainty,reason_codes:reasons,step_count:wf.steps.length,steps,directed_path:pathInfo?{screen_ids:pathInfo.screens.map(id=>(screens.find(s=>s.id===id)?.canonical_key??'').replace(/^screen:/,'')),action_ids:actionIds}:null,current_route_pattern:route?.path??null,current_screen_id:current?.canonical_key??null,outcome_counts:outcomes,citations});
     }
     candidates.sort((a,b)=>b.score-a.score||a.workflow_id.localeCompare(b.workflow_id));return candidates.slice(0,cap);
   }
    stats(){return this.#database.prepare('SELECT (SELECT count(*) FROM nodes WHERE project_id=? AND environment=? AND tombstone=0) nodes,(SELECT count(*) FROM edges WHERE project_id=? AND environment=? AND tombstone=0) edges,(SELECT count(*) FROM evidence e JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id WHERE e.project_id=? AND r.memory_environment=?) evidence').get(this.projectId,this.memoryEnvironment,this.projectId,this.memoryEnvironment,this.projectId,this.memoryEnvironment);}
}
