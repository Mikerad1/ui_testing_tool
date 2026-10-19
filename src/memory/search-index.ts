import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {GraphMutationFinalizer,GraphMutationWriteSet} from './graph-mutation.js';

export const SEARCH_ALLOWLIST_VERSION='fr07d-paths-v1';
export const SEARCH_RANKER_VERSION='fr07d-ranker-v1';
const MAX_NODE_BYTES=16*1024,MAX_NODE_TOKENS=256;
const TOKEN_PATTERN=/[\p{L}\p{N}\p{M}]+/gu;
type NodeRow={id:string;project_id:string;environment:string;type:string;canonical_key:string;display_name:string;attributes_json:string;origin:string;verification_status:string;confidence:number;tombstone:number;superseded_by:string|null;conflict_status:string;updated_at:string;content_hash:string|null};
type Value={path:string;kind:'exact'|'prose';value:string;weight:number};
type Token={path:string;token:string;weight:number;value_id:number};
const unicodeVersion=()=>JSON.stringify({unicode:process.versions.unicode??'unknown',icu:process.versions.icu??'unknown'});
export const SEARCH_NORMALIZER_VERSION=unicodeVersion();

export function normalizeSearchText(value:string):string{return value.normalize('NFKC').toLowerCase();}
function tokensOf(value:string):string[]{return normalizeSearchText(value).match(TOKEN_PATTERN)??[];}
function isString(value:unknown):value is string{return typeof value==='string'&&value.length>0&&!value.includes('[REDACTED]');}
function safeRoute(value:string):boolean{return value.startsWith('/')&&!value.startsWith('//')&&!/[?#]/.test(value)&&! /^[A-Za-z][A-Za-z\d+.-]*:/.test(value);}
function safeUrl(value:string):boolean{if(/[?#]/.test(value))return false;try{const url=new URL(value);return(url.protocol==='http:'||url.protocol==='https:')&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}}
function safeUrlOrRoute(value:string):boolean{return safeUrl(value)||safeRoute(value);}
function attrsOf(node:NodeRow):Record<string,any>{try{const value=JSON.parse(node.attributes_json);if(value&&typeof value==='object'&&!Array.isArray(value))return value;throw new Error('expected a JSON object');}catch(error){throw new Error(`Malformed attributes_json for memory node ${node.id}; cannot build trusted search index`,{cause:error});}}
function live(node:NodeRow):boolean{return node.tombstone===0&&node.superseded_by===null&&!['stale','superseded'].includes(node.verification_status)&&node.conflict_status==='none';}
function ownerIsCurrent(db:Database.Database,node:NodeRow):boolean{
  return Boolean(db.prepare(`SELECT 1 FROM yaml_ownership y JOIN yaml_sources s ON s.project_id=y.project_id AND s.environment=y.environment AND s.path=y.source_path
    WHERE y.project_id=? AND y.environment=? AND y.entity_id=? AND y.entity_type=? AND y.entity_key=? AND y.tombstone=0 AND y.conflict_status='none'
    AND y.hash=? AND s.active=1 AND s.hash=y.hash LIMIT 1`).get(node.project_id,node.environment,node.id,node.type,node.canonical_key,node.content_hash));
}
function eligible(db:Database.Database,node:NodeRow,view:0|1):boolean{
  if(!live(node))return false;
  const owned=node.origin==='yaml'&&ownerIsCurrent(db,node);
  if(node.verification_status==='verified'&&(node.origin!=='yaml'||owned))return true;
  return view===1&&owned;
}
function trustedEdge(db:Database.Database,edge:any,view:0|1):boolean{
  if(edge.tombstone!==0||edge.conflict_status!=='none'||['stale','superseded'].includes(edge.verification_status))return false;
  if(edge.verification_status==='verified'&&(edge.origin!=='yaml'||edgeOwnedCurrent(db,edge)))return true;
  return view===1&&edge.origin==='yaml'&&edgeOwnedCurrent(db,edge);
}
function edgeOwnedCurrent(db:Database.Database,edge:any):boolean{return Boolean(db.prepare(`SELECT 1 FROM yaml_ownership y JOIN yaml_sources s ON s.project_id=y.project_id AND s.environment=y.environment AND s.path=y.source_path
   WHERE y.project_id=? AND y.environment=? AND y.entity_id=? AND y.entity_type='edge' AND y.tombstone=0 AND y.conflict_status='none' AND s.active=1 LIMIT 1`).get(edge.project_id,edge.environment,edge.id));}
const add=(out:Value[],path:string,kind:'exact'|'prose',value:unknown,weight:number,validator?:(value:string)=>boolean)=>{if(!isString(value)||validator&&!validator(value))return;out.push({path,kind,value,weight});};
const fields=(out:Value[],base:string,value:unknown,weight:number)=>{if(!value||typeof value!=='object'||Array.isArray(value))return;for(const key of ['by','role','name','value'] as const)add(out,`${base}.${key}`,'exact',(value as any)[key],weight);};

function currentActionOwner(db:Database.Database,node:NodeRow,view:0|1,attrs:Record<string,any>):boolean{
  const elementRef=attrs.element;if(!isString(elementRef))return false;
  const rows=db.prepare(`SELECT e.*,s.id screen_id,s.attributes_json screen_attributes,s.origin screen_origin,s.verification_status screen_verification_status,s.conflict_status screen_conflict_status,s.tombstone screen_tombstone,s.superseded_by screen_superseded_by,s.content_hash screen_content_hash,s.canonical_key screen_canonical_key,s.type screen_type,s.display_name screen_display_name,s.updated_at screen_updated_at,s.confidence screen_confidence
    FROM edges e JOIN nodes s ON s.project_id=e.project_id AND s.environment=e.environment AND s.id=e.from_node_id
     WHERE e.project_id=? AND e.environment=? AND e.to_node_id=? AND e.relation_type='TRIGGERED_BY' AND s.type='screen' ORDER BY e.id`).all(node.project_id,node.environment,node.id) as any[];
    const currentRows=rows.flatMap(row=>{
     const screen:NodeRow={id:row.screen_id,project_id:row.project_id,environment:row.environment,type:row.screen_type,canonical_key:row.screen_canonical_key,display_name:row.screen_display_name,attributes_json:row.screen_attributes,origin:row.screen_origin,verification_status:row.screen_verification_status,confidence:row.screen_confidence,tombstone:row.screen_tombstone,superseded_by:row.screen_superseded_by,conflict_status:row.screen_conflict_status,updated_at:row.screen_updated_at,content_hash:row.screen_content_hash};
     return trustedEdge(db,row,view)&&eligible(db,screen,view)?[{row,screen}]:[];
    });
   if(currentRows.length!==1)return false;
   const {row,screen}=currentRows[0]!;
  const elements=attrsOf(screen).elements;if(!Array.isArray(elements))return false;
  const matching=elements.filter((element:any)=>element&&typeof element==='object'&&element.id===elementRef);
  return matching.length===1&&matching[0].sensitive!==true;
}

function collectValues(db:Database.Database,node:NodeRow,view:0|1):Value[]{
  const attrs=attrsOf(node),values:Value[]=[];
  if(node.type==='ui_element'&&attrs.sensitive===true)return values;
  if(node.type==='action'&&!currentActionOwner(db,node,view,attrs))return values;
  add(values,'canonical_key','exact',node.canonical_key,3);add(values,'display_name','prose',node.display_name,4);add(values,'attributes.id','exact',attrs.id,3);
  switch(node.type){
    case'application':
      add(values,'attributes.base_url','exact',attrs.base_url,3,safeUrl);add(values,'attributes.start_screen','exact',attrs.start_screen,3);
      if(Array.isArray(attrs.route_patterns))attrs.route_patterns.forEach((item:any,i:number)=>{if(!item||typeof item!=='object')return;add(values,`attributes.route_patterns[${i}].path`,'exact',item.path,3,safeRoute);add(values,`attributes.route_patterns[${i}].screen`,'exact',item.screen,3);});break;
    case'role':if(Array.isArray(attrs.permissions))attrs.permissions.forEach((value:any,i:number)=>add(values,`attributes.permissions[${i}]`,'prose',value,1));break;
    case'screen':
      add(values,'attributes.route','exact',attrs.route,3,safeRoute);
      if(Array.isArray(attrs.elements)){
        const ids=attrs.elements.filter((element:any)=>element&&typeof element==='object'&&isString(element.id));
        attrs.elements.forEach((element:any,i:number)=>{if(!element||typeof element!=='object'||element.sensitive===true||!isString(element.id)||ids.filter(candidate=>candidate.id===element.id).length!==1)return;
          add(values,`attributes.elements[${i}].id`,'exact',element.id,3);add(values,`attributes.elements[${i}].description`,'prose',element.description,1);
          fields(values,`attributes.elements[${i}].locator`,element.locator,3);
          if(Array.isArray(element.fallback_locators))element.fallback_locators.forEach((loc:any,j:number)=>fields(values,`attributes.elements[${i}].fallback_locators[${j}]`,loc,3));
        });
      }
      if(Array.isArray(attrs.actions))attrs.actions.forEach((action:any,i:number)=>{if(!action||typeof action!=='object'||!isString(action.element)||!Array.isArray(attrs.elements))return;const matches=attrs.elements.filter((element:any)=>element&&typeof element==='object'&&element.id===action.element);if(matches.length!==1||matches[0].sensitive===true)return;add(values,`attributes.actions[${i}].id`,'exact',action.id,3);add(values,`attributes.actions[${i}].element`,'exact',action.element,3);add(values,`attributes.actions[${i}].effect.navigates_to`,'exact',action.effect?.navigates_to,3);});break;
    case'ui_element':fields(values,'attributes.locator',attrs.locator,3);if(Array.isArray(attrs.fallback_locators))attrs.fallback_locators.forEach((loc:any,i:number)=>fields(values,`attributes.fallback_locators[${i}]`,loc,3));add(values,'attributes.description','prose',attrs.description,1);break;
    case'action':add(values,'attributes.element','exact',attrs.element,3);add(values,'attributes.effect.navigates_to','exact',attrs.effect?.navigates_to,3);break;
    case'workflow':
      for(const key of ['start_screen','end_screen'] as const)add(values,`attributes.${key}`,'exact',attrs[key],3);add(values,'attributes.requires.role','exact',attrs.requires?.role,3);
      if(Array.isArray(attrs.steps))attrs.steps.forEach((step:any,i:number)=>{if(!step||typeof step!=='object')return;add(values,`attributes.steps[${i}].id`,'exact',step.id,3);add(values,`attributes.steps[${i}].path`,'exact',step.path,3,safeRoute);if(step.condition==='url_matches')add(values,`attributes.steps[${i}].expected`,'exact',step.expected,3,safeUrlOrRoute);});break;
    case'navigation_rules':if(Array.isArray(attrs.rules))attrs.rules.forEach((rule:any,i:number)=>{if(!rule||typeof rule!=='object')return;for(const key of ['id','from','to'] as const)add(values,`attributes.rules[${i}].${key}`,'exact',rule[key],3);add(values,`attributes.rules[${i}].via.action`,'exact',rule.via?.action,3);if(rule.verify?.condition==='url_matches'){add(values,`attributes.rules[${i}].verify.condition`,'exact',rule.verify.condition,3);add(values,`attributes.rules[${i}].verify.pattern`,'exact',rule.verify.pattern,3,safeUrlOrRoute);}});break;
    case'validation_rule':for(const key of ['rule_id','condition','error_code','error'] as const)add(values,`attributes.${key}`,'exact',attrs[key],3);for(const key of ['description','message'] as const)add(values,`attributes.${key}`,'prose',attrs[key],1);break;
    case'locator':for(const key of ['by','role','name','value'] as const)add(values,`attributes.${key}`,'exact',attrs[key],3);fields(values,'attributes.locator',attrs.locator,3);break;
    case'test':for(const key of ['test_id','issue_key'] as const)add(values,`attributes.${key}`,'exact',attrs[key],3);add(values,'attributes.url','exact',attrs.url,3,safeUrl);add(values,'attributes.route','exact',attrs.route,3,safeRoute);for(const key of ['title','summary','description'] as const)add(values,`attributes.${key}`,'prose',attrs[key],1);break;
    case'acceptance_criterion':for(const key of ['criterion_id','issue_key'] as const)add(values,`attributes.${key}`,'exact',attrs[key],3);for(const key of ['title','description','statement'] as const)add(values,`attributes.${key}`,'prose',attrs[key],1);break;
  }
  return values;
}

function nodeRow(db:Database.Database,project:string,environment:string,id:string):NodeRow|undefined{return db.prepare('SELECT * FROM nodes WHERE project_id=? AND environment=? AND id=?').get(project,environment,id) as NodeRow|undefined;}
function exactHash(node:NodeRow,path:string,value:string):string{const hash=createHash('sha256').update('umb-search-exact\0v1\0');for(const part of [node.project_id,node.environment,node.type,path,value]){const bytes=Buffer.from(part,'utf8'),length=Buffer.allocUnsafe(4);length.writeUInt32BE(bytes.length);hash.update(length).update(bytes);}return hash.digest('hex');}

function buildNodeIndex(db:Database.Database,node:NodeRow,view:0|1):{values:Value[];tokens:Token[]}{
  const values=collectValues(db,node,view);let bytes=0;const tokens:Token[]=[];let tokenCount=0;
  values.forEach((value,value_id)=>{bytes+=Buffer.byteLength(value.value,'utf8');if(value.kind==='prose'){const valueTokens=tokensOf(value.value);tokenCount+=valueTokens.length;for(const token of new Set(valueTokens))tokens.push({path:value.path,token,weight:value.weight,value_id});}});
  if(bytes>MAX_NODE_BYTES||tokenCount>MAX_NODE_TOKENS)throw new Error(`Cannot index node ${node.id} (${node.project_id}/${node.environment}): searchable values exceed ${MAX_NODE_BYTES} UTF-8 bytes or ${MAX_NODE_TOKENS} normalized tokens`);
  if(!eligible(db,node,view))return{values:[],tokens:[]};
  return{values,tokens};
}

function createIndexSchema(db:Database.Database):void{
  db.exec(`CREATE TABLE IF NOT EXISTS memory_search_state(project_id TEXT NOT NULL,environment TEXT NOT NULL,normalizer_version TEXT NOT NULL,allowlist_version TEXT NOT NULL,ranker_version TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,environment));
     CREATE TABLE IF NOT EXISTS memory_search_values(project_id TEXT NOT NULL,environment TEXT NOT NULL,trust_view INTEGER NOT NULL CHECK(trust_view IN (0,1)),node_id TEXT NOT NULL,value_id INTEGER NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('exact','prose')),raw_value TEXT NOT NULL,value_hash TEXT NOT NULL,path_weight INTEGER NOT NULL,PRIMARY KEY(project_id,environment,trust_view,node_id,value_id));
     CREATE INDEX IF NOT EXISTS memory_search_exact_lookup ON memory_search_values(project_id,environment,trust_view,value_hash,node_id) WHERE kind='exact';
     CREATE INDEX IF NOT EXISTS memory_search_exact_raw_lookup ON memory_search_values(project_id,environment,trust_view,raw_value COLLATE BINARY,node_id,value_id) WHERE kind='exact';
     CREATE INDEX IF NOT EXISTS memory_search_values_node ON memory_search_values(project_id,environment,trust_view,node_id);
    CREATE TABLE IF NOT EXISTS memory_search_tokens(project_id TEXT NOT NULL,environment TEXT NOT NULL,trust_view INTEGER NOT NULL CHECK(trust_view IN (0,1)),node_id TEXT NOT NULL,value_id INTEGER NOT NULL,path TEXT NOT NULL,token TEXT NOT NULL,path_weight INTEGER NOT NULL,PRIMARY KEY(project_id,environment,trust_view,node_id,value_id,token));
    CREATE INDEX IF NOT EXISTS memory_search_token_lookup ON memory_search_tokens(project_id,environment,trust_view,token,node_id);
    CREATE TABLE IF NOT EXISTS memory_search_df(project_id TEXT NOT NULL,environment TEXT NOT NULL,trust_view INTEGER NOT NULL CHECK(trust_view IN (0,1)),token TEXT NOT NULL,document_frequency INTEGER NOT NULL CHECK(document_frequency>0),PRIMARY KEY(project_id,environment,trust_view,token));`);
}

function insertNodeIndex(db:Database.Database,node:NodeRow,view:0|1,projection:{values:Value[];tokens:Token[]}):void{
  const insertValue=db.prepare('INSERT INTO memory_search_values(project_id,environment,trust_view,node_id,value_id,path,kind,raw_value,value_hash,path_weight) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const insertToken=db.prepare('INSERT INTO memory_search_tokens(project_id,environment,trust_view,node_id,value_id,path,token,path_weight) VALUES(?,?,?,?,?,?,?,?)');
  for(const [value_id,value] of projection.values.entries())insertValue.run(node.project_id,node.environment,view,node.id,value_id,value.path,value.kind,value.value,value.kind==='exact'?exactHash(node,value.path,value.value):'',value.weight);
  for(const token of projection.tokens)insertToken.run(node.project_id,node.environment,view,node.id,token.value_id,token.path,token.token,token.weight);
  for(const token of new Set(projection.tokens.map(item=>item.token)))db.prepare(`INSERT INTO memory_search_df(project_id,environment,trust_view,token,document_frequency) VALUES(?,?,?,?,1) ON CONFLICT(project_id,environment,trust_view,token) DO UPDATE SET document_frequency=document_frequency+1`).run(node.project_id,node.environment,view,token);
}

export function migrateSearchIndexV14(db:Database.Database):void{
  createIndexSchema(db);
  // The caller owns the schema migration transaction. Stream all scopes and
  // fail that transaction on malformed/over-limit legacy projections.
  db.exec('DELETE FROM memory_search_tokens; DELETE FROM memory_search_values; DELETE FROM memory_search_df; DELETE FROM memory_search_state;');
  const insertState=db.prepare('INSERT INTO memory_search_state(project_id,environment,normalizer_version,allowlist_version,ranker_version,generation) VALUES(?,?,?,?,?,0)');
  const initialized=new Set<string>(),selectBatch=db.prepare('SELECT * FROM nodes WHERE (? IS NULL OR (project_id,environment,id)>(?,?,?)) ORDER BY project_id,environment,id LIMIT 100');let last:NodeRow|undefined;
  for(;;){const batch=selectBatch.all(last?.project_id??null,last?.project_id??null,last?.environment??null,last?.id??null) as NodeRow[];if(!batch.length)break;
    for(const node of batch){const views: Array<0|1>=node.verification_status==='verified'&&live(node)?[0,1]:[1];for(const view of views){const projection=buildNodeIndex(db,node,view);if(!projection.values.length)continue;const scope=`${node.project_id}\0${node.environment}`;if(!initialized.has(scope)){insertState.run(node.project_id,node.environment,SEARCH_NORMALIZER_VERSION,SEARCH_ALLOWLIST_VERSION,SEARCH_RANKER_VERSION);initialized.add(scope);}insertNodeIndex(db,node,view,projection);}}
    last=batch.at(-1)!;
  }
  // Empty scopes still need metadata so a normalizer-version comparison is unambiguous.
  db.prepare(`INSERT OR IGNORE INTO memory_search_state(project_id,environment,normalizer_version,allowlist_version,ranker_version,generation)
    SELECT DISTINCT project_id,environment,?,?,?,0 FROM nodes`).run(SEARCH_NORMALIZER_VERSION,SEARCH_ALLOWLIST_VERSION,SEARCH_RANKER_VERSION);
  db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(14,?)').run(new Date().toISOString());
}

export function rebuildSearchIndexIfVersionChanged(db:Database.Database):void{
  // This additive lookup index is required by the bounded exact-query path and
  // is installed for existing v14 databases without changing index contents.
  db.exec('CREATE INDEX IF NOT EXISTS memory_search_exact_raw_lookup ON memory_search_values(project_id,environment,trust_view,raw_value COLLATE BINARY,node_id,value_id) WHERE kind=\'exact\'');
  const changed=db.prepare('SELECT 1 FROM memory_search_state WHERE normalizer_version<>? OR allowlist_version<>? OR ranker_version<>? LIMIT 1').get(SEARCH_NORMALIZER_VERSION,SEARCH_ALLOWLIST_VERSION,SEARCH_RANKER_VERSION);
  const missing=db.prepare(`SELECT 1 FROM nodes n LEFT JOIN memory_search_state s ON s.project_id=n.project_id AND s.environment=n.environment WHERE s.project_id IS NULL LIMIT 1`).get();
  if(!changed&&!missing)return;
  const rebuild=db.transaction(()=>{
    db.exec('DELETE FROM memory_search_tokens; DELETE FROM memory_search_values; DELETE FROM memory_search_df; DELETE FROM memory_search_state;');
    const insertState=db.prepare('INSERT INTO memory_search_state(project_id,environment,normalizer_version,allowlist_version,ranker_version,generation) VALUES(?,?,?,?,?,0)');
    const initialized=new Set<string>(),selectBatch=db.prepare('SELECT * FROM nodes WHERE (? IS NULL OR (project_id,environment,id)>(?,?,?)) ORDER BY project_id,environment,id LIMIT 100');let last:NodeRow|undefined;
    for(;;){const batch=selectBatch.all(last?.project_id??null,last?.project_id??null,last?.environment??null,last?.id??null) as NodeRow[];if(!batch.length)break;
      for(const node of batch)for(const view of [0,1] as const){const projection=buildNodeIndex(db,node,view);if(!projection.values.length)continue;const scope=`${node.project_id}\0${node.environment}`;if(!initialized.has(scope)){insertState.run(node.project_id,node.environment,SEARCH_NORMALIZER_VERSION,SEARCH_ALLOWLIST_VERSION,SEARCH_RANKER_VERSION);initialized.add(scope);}insertNodeIndex(db,node,view,projection);}
      last=batch.at(-1)!;
    }
    db.prepare(`INSERT OR IGNORE INTO memory_search_state(project_id,environment,normalizer_version,allowlist_version,ranker_version,generation) SELECT DISTINCT project_id,environment,?,?,?,0 FROM nodes`).run(SEARCH_NORMALIZER_VERSION,SEARCH_ALLOWLIST_VERSION,SEARCH_RANKER_VERSION);
  });rebuild();
}

export function createSearchIndexFinalizer(db:Database.Database):GraphMutationFinalizer{return(writeSet)=>{
  const affected=new Set([...writeSet.changedNodeIds,...writeSet.changedEdgeEndpoints,...writeSet.affectedOwnerEntityIds,...writeSet.affectedActionNodeIds]);
  if(!affected.size)return;
  const projectEnvironments=new Set<string>();
  for(const item of writeSet.nodes)for(const row of [item.old,item.next])if(row)projectEnvironments.add(`${row.project_id}\0${row.environment}`);
  for(const item of writeSet.edges)for(const row of [item.old,item.next])if(row)projectEnvironments.add(`${row.project_id}\0${row.environment}`);
  for(const item of writeSet.owners)for(const row of [item.old,item.next])if(row)projectEnvironments.add(`${row.project_id}\0${row.environment}`);
  for(const item of writeSet.sources)for(const row of [item.old,item.next])if(row)projectEnvironments.add(`${row.project_id}\0${row.environment}`);
  // Store writes are scope-local; captured scopes identify the owner for every
  // affected ID. A missing scope is an incomplete write set and must abort.
  if(!projectEnvironments.size)throw new Error('Graph mutation write set omitted project/environment identity');
  const scopes=[...projectEnvironments].map(item=>{const [project_id,environment]=item.split('\0');return{project_id:project_id!,environment:environment!};});
  for(const scope of scopes){
    const ids=new Set<string>();
    for(const item of writeSet.nodes)for(const row of [item.old,item.next])if(row?.project_id===scope.project_id&&row.environment===scope.environment)ids.add(row.id);
    for(const item of writeSet.edges)for(const row of [item.old,item.next])if(row?.project_id===scope.project_id&&row.environment===scope.environment)for(const id of [row.from_node_id,row.to_node_id])ids.add(id);
    for(const item of writeSet.owners)for(const row of [item.old,item.next])if(row?.project_id===scope.project_id&&row.environment===scope.environment)ids.add(row.entity_id);
    for(const item of writeSet.sources)for(const row of [item.old,item.next])if(row?.project_id===scope.project_id&&row.environment===scope.environment){for(const owner of db.prepare('SELECT entity_id FROM yaml_ownership WHERE project_id=? AND environment=? AND source_path=?').all(scope.project_id,scope.environment,row.path) as Array<{entity_id:string}>)ids.add(owner.entity_id);}
    for(const id of writeSet.affectedActionNodeIds)ids.add(id);
    if(!ids.size)continue;
    const selectOld=db.prepare('SELECT token FROM memory_search_tokens WHERE project_id=? AND environment=? AND trust_view=? AND node_id=? GROUP BY token');
    const deleteTokens=db.prepare('DELETE FROM memory_search_tokens WHERE project_id=? AND environment=? AND trust_view=? AND node_id=?');
    const deleteValues=db.prepare('DELETE FROM memory_search_values WHERE project_id=? AND environment=? AND trust_view=? AND node_id=?');
    const delta=new Map<string,number>();
    for(const id of ids){
      for(const view of [0,1] as const){for(const row of selectOld.all(scope.project_id,scope.environment,view,id) as Array<{token:string}>)delta.set(`${view}\0${row.token}`,(delta.get(`${view}\0${row.token}`)??0)-1);deleteTokens.run(scope.project_id,scope.environment,view,id);deleteValues.run(scope.project_id,scope.environment,view,id);}
      const node=nodeRow(db,scope.project_id,scope.environment,id);if(!node)continue;
      for(const view of [0,1] as const){const projection=buildNodeIndex(db,node,view);if(!projection.values.length)continue;insertNodeIndexWithoutDf(db,node,view,projection);for(const token of new Set(projection.tokens.map(item=>item.token)))delta.set(`${view}\0${token}`,(delta.get(`${view}\0${token}`)??0)+1);}
    }
    const updateDf=db.prepare('UPDATE memory_search_df SET document_frequency=document_frequency+? WHERE project_id=? AND environment=? AND trust_view=? AND token=?');
    const insertDf=db.prepare('INSERT INTO memory_search_df(project_id,environment,trust_view,token,document_frequency) VALUES(?,?,?,?,?) ON CONFLICT(project_id,environment,trust_view,token) DO UPDATE SET document_frequency=document_frequency+excluded.document_frequency');
    const deleteDf=db.prepare('DELETE FROM memory_search_df WHERE project_id=? AND environment=? AND trust_view=? AND token=?');
    for(const [key,change] of delta){if(change===0)continue;const [view,token]=key.split('\0');const current=db.prepare('SELECT document_frequency FROM memory_search_df WHERE project_id=? AND environment=? AND trust_view=? AND token=?').get(scope.project_id,scope.environment,Number(view),token) as {document_frequency:number}|undefined;if(current){const next=current.document_frequency+change;if(next<0)throw new Error('Search index DF delta underflow; refusing graph mutation');if(next===0)deleteDf.run(scope.project_id,scope.environment,Number(view),token);else updateDf.run(change,scope.project_id,scope.environment,Number(view),token);}else if(change>0)insertDf.run(scope.project_id,scope.environment,Number(view),token,change);else throw new Error('Search index DF delta underflow; refusing graph mutation');}
    db.prepare(`INSERT INTO memory_search_state(project_id,environment,normalizer_version,allowlist_version,ranker_version,generation) VALUES(?,?,?,?,?,1)
      ON CONFLICT(project_id,environment) DO UPDATE SET generation=generation+1,normalizer_version=excluded.normalizer_version,allowlist_version=excluded.allowlist_version,ranker_version=excluded.ranker_version`).run(scope.project_id,scope.environment,SEARCH_NORMALIZER_VERSION,SEARCH_ALLOWLIST_VERSION,SEARCH_RANKER_VERSION);
  }
};}

function insertNodeIndexWithoutDf(db:Database.Database,node:NodeRow,view:0|1,projection:{values:Value[];tokens:Token[]}):void{
  const insertValue=db.prepare('INSERT INTO memory_search_values(project_id,environment,trust_view,node_id,value_id,path,kind,raw_value,value_hash,path_weight) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const insertToken=db.prepare('INSERT INTO memory_search_tokens(project_id,environment,trust_view,node_id,value_id,path,token,path_weight) VALUES(?,?,?,?,?,?,?,?)');
  for(const [value_id,value] of projection.values.entries())insertValue.run(node.project_id,node.environment,view,node.id,value_id,value.path,value.kind,value.value,value.kind==='exact'?exactHash(node,value.path,value.value):'',value.weight);
  for(const token of projection.tokens)insertToken.run(node.project_id,node.environment,view,node.id,token.value_id,token.path,token.token,token.weight);
}
