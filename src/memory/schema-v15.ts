import type Database from 'better-sqlite3';
import {Buffer} from 'node:buffer';
import {randomUUID} from 'node:crypto';

export type LifecycleEventInput={
  projectId:string; environment:string; entityKind:'node'|'edge'; entityId:string;
  action:'stale'|'superseded'; fromState:string; toState:string;
  reasonCode:'legacy_unknown'|'superseded_by_replacement'|'yaml_conflict';
  relatedEntityKind?:'node'|'edge'|null; relatedEntityId?:string|null;
  context?:Record<string,unknown>; createdAt?:string;
};

export function appendLifecycleEvent(database:Database.Database,event:LifecycleEventInput):void{
  if(!['legacy_unknown','superseded_by_replacement','yaml_conflict'].includes(event.reasonCode))throw new Error('Invalid lifecycle reason code');
  let contextJson:string;
  try{contextJson=JSON.stringify(event.context??{});}catch{throw new Error('Invalid lifecycle event context');}
  if(typeof contextJson!=='string'||Buffer.byteLength(contextJson,'utf8')>4096)throw new Error('Lifecycle event context exceeds 4096 UTF-8 bytes');
  database.prepare(`INSERT INTO memory_lifecycle_events
    (id,project_id,environment,entity_kind,entity_id,action,from_state,to_state,reason_code,related_entity_kind,related_entity_id,context_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(),
      event.projectId,event.environment,event.entityKind,event.entityId,event.action,event.fromState,event.toState,event.reasonCode,
      event.relatedEntityKind??null,event.relatedEntityId??null,contextJson,event.createdAt??new Date().toISOString());
}

/** Install typed, append-only lifecycle history and conservatively represent legacy transitions. */
export function migrateLifecycleEventsV15(database:Database.Database):void{
  database.transaction(()=>{
    database.exec(`CREATE TABLE memory_lifecycle_events(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, environment TEXT NOT NULL,
      entity_kind TEXT NOT NULL CHECK(entity_kind IN ('node','edge')), entity_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('stale','superseded')),
      from_state TEXT NOT NULL, to_state TEXT NOT NULL,
      reason_code TEXT NOT NULL CHECK(reason_code IN ('legacy_unknown','superseded_by_replacement','yaml_conflict')),
      related_entity_kind TEXT CHECK(related_entity_kind IS NULL OR related_entity_kind IN ('node','edge')),
      related_entity_id TEXT, context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(CAST(context_json AS BLOB))<=4096), created_at TEXT NOT NULL
    );
    CREATE INDEX memory_lifecycle_events_entity ON memory_lifecycle_events(project_id,environment,entity_kind,entity_id,created_at);
    CREATE TRIGGER memory_lifecycle_events_no_update BEFORE UPDATE ON memory_lifecycle_events BEGIN SELECT RAISE(ABORT,'lifecycle events are immutable'); END;
    CREATE TRIGGER memory_lifecycle_events_no_delete BEFORE DELETE ON memory_lifecycle_events BEGIN SELECT RAISE(ABORT,'lifecycle events are immutable'); END;`);
    const insert=database.prepare(`INSERT INTO memory_lifecycle_events
      (id,project_id,environment,entity_kind,entity_id,action,from_state,to_state,reason_code,related_entity_kind,related_entity_id,context_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const audits=database.prepare("SELECT a.id,a.project_id,a.subject_node_id,a.detail_json,a.created_at,COALESCE(n.environment,'legacy') environment,n.superseded_by FROM memory_audit a LEFT JOIN nodes n ON n.project_id=a.project_id AND n.id=a.subject_node_id WHERE a.action='supersede'").all() as Array<any>;
    const legacySupersededNodes=new Set(audits.map(audit=>`${audit.project_id}\0${audit.subject_node_id}`));
    for(const kind of ['node','edge'] as const){
      const table=kind==='node'?'nodes':'edges';
      const rows=database.prepare(`SELECT id,project_id,environment,verification_status,updated_at${kind==='node'?',superseded_by':''} FROM ${table} WHERE verification_status='stale'`).all() as Array<any>;
      for(const row of rows){
        if(kind==='node'&&legacySupersededNodes.has(`${row.project_id}\0${row.id}`))continue;
        insert.run(randomUUID(),row.project_id,row.environment,kind,row.id,row.superseded_by?'superseded':'stale','unknown','stale','legacy_unknown',row.superseded_by?'node':null,row.superseded_by??null,JSON.stringify({source:'schema_v15_backfill'}),row.updated_at||new Date().toISOString());
      }
    }
    for(const audit of audits){
      let related:string|null=typeof audit.superseded_by==='string'?audit.superseded_by:null;
      try{const detail=JSON.parse(audit.detail_json);if(typeof detail?.newId==='string')related=detail.newId;}catch{}
      database.prepare("UPDATE nodes SET verification_status='stale' WHERE project_id=? AND environment=? AND id=?").run(audit.project_id,audit.environment,audit.subject_node_id);
      insert.run(`legacy-supersede-${audit.id}`,audit.project_id,audit.environment,'node',audit.subject_node_id,'superseded','verified','stale','legacy_unknown',related?'node':null,related,JSON.stringify({source:'memory_audit',audit_id:audit.id}),audit.created_at);
    }
    database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(15,?)').run(new Date().toISOString());
  })();
}
