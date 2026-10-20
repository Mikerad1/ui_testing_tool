import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import {hasNlpMetadata, type YamlReconciliationPlan} from './learning-types.js';
import {LEGACY_MEMORY_ENVIRONMENT} from './environment.js';
import type {CandidateObservationInput} from './store.js';
import {appendLifecycleEvent} from './schema-v15.js';

const hashValue=(value:string)=>createHash('sha1').update(value).digest('hex');
const canonical=(value:any):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);

export function commitYamlReconciliation(database:Database.Database,projectId:string,environment:string,plan:YamlReconciliationPlan,appendObservation:(input:CandidateObservationInput)=>unknown):number {
  if(plan.entities.some(entity=>!hasNlpMetadata(entity.attrs))||plan.edges.some(edge=>!hasNlpMetadata(edge.attrs)))throw Error('NLP ingestion is required');
  for(const fingerprint of plan.recordFingerprints??[]){
    if(!/^[a-z_]{1,40}$/.test(fingerprint.document_kind)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(fingerprint.document_id)||!plan.sources.some(source=>source.path===fingerprint.source_path&&source.hash===fingerprint.raw_hash)||![fingerprint.raw_hash,fingerprint.redacted_hash,fingerprint.preparation_key].every(hash=>/^[a-f0-9]{64}$/.test(hash)))throw Error('Invalid YAML record fingerprint');
  }
  const identity=(type:string,key:string)=>environment===LEGACY_MEMORY_ENVIRONMENT?`${projectId}:${type}:${key}`:`${projectId}:${environment}:${type}:${key}`;
  return database.transaction(()=>{
    const now=new Date().toISOString(),activeNodes=new Set<string>(),activeEdges=new Set<string>(),sourcePaths=new Set(plan.sources.map(source=>source.path));
    for(const observation of plan.candidateObservations??[])appendObservation(observation);
    const nodeId=(type:string,key:string)=>{
      const owned=database.prepare('SELECT entity_id FROM yaml_ownership WHERE project_id=? AND environment=? AND entity_type=? AND entity_key=? AND tombstone=0').get(projectId,environment,type,key) as {entity_id:string}|undefined;
      return owned?.entity_id??hashValue(identity(type,key));
    };
    const resolve=(reference:string)=>{const [type='unknown',...rest]=reference.split(':');return nodeId(type,rest.join(':'));};
    database.prepare('UPDATE yaml_sources SET active=0 WHERE project_id=? AND environment=?').run(projectId,environment);
    for(const source of plan.sources)database.prepare('INSERT INTO yaml_sources(project_id,environment,path,hash,imported_at,active) VALUES(?,?,?,?,?,1) ON CONFLICT(project_id,environment,path) DO UPDATE SET hash=excluded.hash,imported_at=excluded.imported_at,active=1').run(projectId,environment,source.path,source.hash,now);

    const saveOwner=(source:string,type:string,key:string,id:string,hash:string,conflict:string,conflicting:string|null)=>{
      const owners=database.prepare('SELECT source_path FROM yaml_ownership WHERE project_id=? AND environment=? AND entity_type=? AND entity_key=? AND tombstone=0').all(projectId,environment,type,key) as {source_path:string}[];
      const previous=owners[0]?.source_path;
      if(previous===source){
        database.prepare('UPDATE yaml_ownership SET entity_id=?,hash=?,tombstone=0,conflict_status=?,conflicting_entity_id=? WHERE project_id=? AND environment=? AND source_path=? AND entity_type=? AND entity_key=?').run(id,hash,conflict,conflicting,projectId,environment,source,type,key);
        return;
      }
      for(const owner of owners)database.prepare('UPDATE yaml_ownership SET tombstone=1 WHERE project_id=? AND environment=? AND source_path=? AND entity_type=? AND entity_key=?').run(projectId,environment,owner.source_path,type,key);
      database.prepare('INSERT INTO yaml_ownership(project_id,environment,source_path,entity_type,entity_key,entity_id,hash,tombstone,conflict_status,conflicting_entity_id) VALUES(?,?,?,?,?,?,?,0,?,?) ON CONFLICT(project_id,environment,source_path,entity_type,entity_key) DO UPDATE SET entity_id=excluded.entity_id,hash=excluded.hash,tombstone=0,conflict_status=excluded.conflict_status,conflicting_entity_id=excluded.conflicting_entity_id').run(projectId,environment,source,type,key,id,hash,conflict,conflicting);
    };

    for(const entity of plan.entities){
      const id=nodeId(entity.type,entity.key),occupied=database.prepare('SELECT id,origin FROM nodes WHERE project_id=? AND environment=? AND type=? AND canonical_key=? AND tombstone=0 AND id<>? LIMIT 1').get(projectId,environment,entity.type,entity.key,id) as {id:string;origin:string}|undefined;
      const stable=occupied?`yaml:${hashValue(identity(entity.type,entity.key))}`:entity.key;
      database.prepare('INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence,content_hash,tombstone,conflict_status,conflicting_node_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,attributes_json=excluded.attributes_json,content_hash=excluded.content_hash,tombstone=0,updated_at=excluded.updated_at').run(id,projectId,environment,entity.type,stable,entity.key,entity.name,JSON.stringify(entity.attrs),'yaml','proposed',0.7,entity.hash,0,occupied?'conflict':'none',occupied?.id??null,now);
      activeNodes.add(id);
      if(occupied){
       database.prepare("UPDATE nodes SET conflict_status='conflict',conflicting_node_id=? WHERE project_id=? AND environment=? AND id=?").run(id,projectId,environment,occupied.id);
         const prior=database.prepare("SELECT verification_status FROM nodes WHERE project_id=? AND environment=? AND id=? AND origin<>'yaml'").get(projectId,environment,occupied.id) as {verification_status:string}|undefined;
         const stale=database.prepare("UPDATE nodes SET verification_status='stale' WHERE project_id=? AND environment=? AND id=? AND origin<>'yaml'").run(projectId,environment,occupied.id).changes;
         if(stale&&prior?.verification_status!=='stale')appendLifecycleEvent(database,{projectId,environment,entityKind:'node',entityId:occupied.id,action:'stale',fromState:prior?.verification_status??'unknown',toState:'stale',reasonCode:'yaml_conflict',relatedEntityKind:'node',relatedEntityId:id,context:{conflict:'yaml_identity'}});
      }
      saveOwner(entity.source,entity.type,entity.key,id,entity.hash,occupied?'conflict':'none',occupied?.id??null);
    }

    const previousYamlEdgeIds=new Set((database.prepare("SELECT entity_id FROM yaml_ownership WHERE project_id=? AND environment=? AND entity_type='edge' AND tombstone=0").all(projectId,environment) as Array<{entity_id:string}>).map(row=>row.entity_id));
    for(const edge of plan.edges){
      const from=resolve(edge.from),to=resolve(edge.to),attrs=canonical(edge.attrs),stableKey=`${edge.key}:${hashValue(`${from}:${to}:${edge.relation}:${attrs}`)}`,id=hashValue(`${identity('edge',stableKey)}`),matches=database.prepare("SELECT id,attributes_json FROM edges WHERE project_id=? AND environment=? AND origin='agent' AND from_node_id=? AND to_node_id=? AND relation_type=? AND tombstone=0 ORDER BY id").all(projectId,environment,from,to,edge.relation) as Array<{id:string;attributes_json:string}>,conflicts=matches.filter(match=>canonical(JSON.parse(match.attributes_json))!==attrs);
      database.prepare('INSERT INTO edges(id,project_id,environment,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,tombstone,created_at,updated_at,conflict_status,conflicting_edge_id,stable_key) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?) ON CONFLICT(project_id,environment,origin,stable_key) DO UPDATE SET tombstone=0,updated_at=excluded.updated_at,conflict_status=excluded.conflict_status,conflicting_edge_id=excluded.conflicting_edge_id').run(id,projectId,environment,from,to,edge.relation,attrs,'yaml','proposed',now,now,conflicts.length?'conflict':'none',conflicts[0]?.id??null,stableKey);
      activeEdges.add(id);
      for(const agent of conflicts){
         database.prepare("UPDATE edges SET conflict_status='conflict',conflicting_edge_id=? WHERE project_id=? AND environment=? AND id=?").run(id,projectId,environment,agent.id);
         const prior=database.prepare("SELECT verification_status FROM edges WHERE project_id=? AND environment=? AND id=?").get(projectId,environment,agent.id) as {verification_status:string}|undefined;
         const stale=database.prepare("UPDATE edges SET verification_status='stale' WHERE project_id=? AND environment=? AND id=?").run(projectId,environment,agent.id).changes;
         if(stale&&prior?.verification_status!=='stale')appendLifecycleEvent(database,{projectId,environment,entityKind:'edge',entityId:agent.id,action:'stale',fromState:prior?.verification_status??'unknown',toState:'stale',reasonCode:'yaml_conflict',relatedEntityKind:'edge',relatedEntityId:id,context:{conflict:'yaml_edge_semantics'}});
      }
      saveOwner(edge.source,'edge',edge.key,id,'',conflicts.length?'conflict':'none',conflicts[0]?.id??null);
    }

    for(const id of previousYamlEdgeIds)if(!activeEdges.has(id))database.prepare('UPDATE edges SET tombstone=1,updated_at=? WHERE project_id=? AND environment=? AND id=?').run(now,projectId,environment,id);
    for(const row of database.prepare('SELECT entity_id,entity_type,entity_key FROM yaml_ownership WHERE project_id=? AND environment=? AND tombstone=0').all(projectId,environment) as Array<{entity_id:string;entity_type:string;entity_key:string}>){
      if(row.entity_type==='edge'&&!activeEdges.has(row.entity_id)){
        database.prepare('UPDATE yaml_ownership SET tombstone=1 WHERE project_id=? AND environment=? AND entity_type=? AND entity_key=?').run(projectId,environment,row.entity_type,row.entity_key);
        database.prepare('UPDATE edges SET tombstone=1,updated_at=? WHERE project_id=? AND environment=? AND id=?').run(now,projectId,environment,row.entity_id);
      }else if(row.entity_type!=='edge'&&!activeNodes.has(row.entity_id)){
        database.prepare('UPDATE yaml_ownership SET tombstone=1 WHERE project_id=? AND environment=? AND entity_type=? AND entity_key=?').run(projectId,environment,row.entity_type,row.entity_key);
        database.prepare("UPDATE nodes SET tombstone=1,updated_at=? WHERE project_id=? AND environment=? AND id=? AND origin='yaml'").run(now,projectId,environment,row.entity_id);
      }
    }
    for(const row of database.prepare('SELECT path FROM yaml_sources WHERE project_id=? AND environment=?').all(projectId,environment) as Array<{path:string}>)if(!sourcePaths.has(row.path))database.prepare('UPDATE yaml_sources SET active=0 WHERE project_id=? AND environment=? AND path=?').run(projectId,environment,row.path);
    for(const fingerprint of plan.recordFingerprints??[])database.prepare(`INSERT INTO yaml_record_fingerprints(project_id,environment,document_kind,document_id,source_path,raw_hash,redacted_hash,preparation_key,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id,environment,document_kind,document_id) DO UPDATE SET source_path=excluded.source_path,raw_hash=excluded.raw_hash,redacted_hash=excluded.redacted_hash,preparation_key=excluded.preparation_key,updated_at=excluded.updated_at`).run(projectId,environment,fingerprint.document_kind,fingerprint.document_id,fingerprint.source_path,fingerprint.raw_hash,fingerprint.redacted_hash,fingerprint.preparation_key,now);
    return plan.sources.length;
  })();
}
