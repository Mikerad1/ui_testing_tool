import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {Store} from '../src/memory/store.js';
import {withNlpMetadata} from '../src/memory/learning-types.js';
import {storeLearningCommit} from '../src/memory/store-internal.js';
import {SEARCH_NORMALIZER_VERSION,SEARCH_RANKER_VERSION} from '../src/memory/search-index.js';

test('v14 rebuild streams and indexes every project/environment scope and rolls migration back for over-limit legacy rows',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-search-v14-')),filename=path.join(root,'memory.sqlite');let first:Store|undefined,second:Store|undefined,reopened:Store|undefined;
  try{
    first=new Store(filename,'index-project-a');second=new Store(filename,'index-project-b','staging');
    const firstId=first.applicationSubject()!.id,secondId=second.applicationSubject()!.id;first.close();first=undefined;second.close();second=undefined;
      const legacy=new Database(filename);legacy.exec('DROP INDEX memory_audit_verify_subject_latest; DROP INDEX evidence_assertion_provenance_lookup; DROP INDEX memory_search_edges_from_bounded; DROP INDEX memory_search_edges_to_bounded; DROP TABLE memory_candidate_evidence_refs; DROP TABLE memory_lifecycle_events; DROP TABLE memory_search_tokens; DROP TABLE memory_search_values; DROP TABLE memory_search_df; DROP TABLE memory_search_state; DELETE FROM schema_migrations WHERE version IN (14,15,16,17)');legacy.close();
    reopened=await Store.open(filename,'index-project-a');
    assert.equal((reopened.db.prepare('SELECT count(*) count FROM memory_search_state').get() as any).count,2);
    assert.equal((reopened.db.prepare('SELECT DISTINCT normalizer_version FROM memory_search_state').get() as any).normalizer_version,SEARCH_NORMALIZER_VERSION);assert.equal((reopened.db.prepare('SELECT DISTINCT ranker_version FROM memory_search_state').get() as any).ranker_version,SEARCH_RANKER_VERSION);
    assert.equal((reopened.db.prepare('SELECT count(*) count FROM memory_search_values WHERE node_id=? AND trust_view=0').get(firstId) as any).count>0,true);
    assert.equal((reopened.db.prepare('SELECT count(*) count FROM memory_search_values WHERE node_id=? AND trust_view=0').get(secondId) as any).count>0,true);
    reopened.close();reopened=undefined;

      const broken=new Database(filename);broken.exec('DROP INDEX memory_audit_verify_subject_latest; DROP INDEX evidence_assertion_provenance_lookup; DROP INDEX memory_search_edges_from_bounded; DROP INDEX memory_search_edges_to_bounded; DROP TABLE memory_candidate_evidence_refs; DROP TABLE memory_lifecycle_events; DROP TABLE memory_search_tokens; DROP TABLE memory_search_values; DROP TABLE memory_search_df; DROP TABLE memory_search_state; DELETE FROM schema_migrations WHERE version IN (14,15,16,17)');
    broken.prepare(`INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-too-wide','index-project-b','staging','screen','legacy-too-wide','legacy-too-wide','x'.repeat(16*1024+1),'{}','agent','proposed',0.5);broken.close();
     await assert.rejects(Store.open(filename,'index-project-a'),/legacy-too-wide.*16384 UTF-8 bytes/);
     const inspect=new Database(filename);try{assert.equal((inspect.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version,13);assert.equal(inspect.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_search_values'").get(),undefined);assert.equal((inspect.prepare('SELECT count(*) count FROM nodes WHERE id=?').get('legacy-too-wide') as any).count,1);}finally{inspect.close();}
     const malformed=new Database(filename);malformed.prepare('DELETE FROM nodes WHERE id=?').run('legacy-too-wide');malformed.prepare(`INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-malformed','index-project-b','staging','screen','legacy-malformed','legacy-malformed','Malformed attributes','{broken','agent','verified',1);malformed.close();
     await assert.rejects(Store.open(filename,'index-project-a'),/Malformed attributes_json for memory node legacy-malformed/);
     const afterMalformed=new Database(filename);try{assert.equal((afterMalformed.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version,13);assert.equal(afterMalformed.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_search_values'").get(),undefined);}finally{afterMalformed.close();}
  }finally{reopened?.close();first?.close();second?.close();await rm(root,{recursive:true,force:true});}
});

test('incremental index tracks trust-view postings, DF deltas, generations, and fails closed for sensitive actions',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-search-incremental-')),filename=path.join(root,'memory.sqlite');let store:Store|undefined;
  try{
    store=new Store(filename,'search-project');
    const source='search.yaml',hash='a'.repeat(64);
    const makePlan=()=>({sources:[{path:source,hash}],entities:[
      {type:'screen',key:'screen-key',name:'Checkout screen',attrs:withNlpMetadata({id:'checkout',elements:[{id:'public-element',description:'Public payment description',locator:{by:'test_id',value:'public-control'}},{id:'private-element',sensitive:true,description:'PRIVATE_SENTINEL',locator:{value:'private-selector'}}],actions:[{id:'safe-action',element:'public-element',effect:{navigates_to:'receipt'}},{id:'unsafe-action',element:'private-element'}]},'normalized ignored'),hash,source},
      {type:'action',key:'action-key',name:'Graph action display',attrs:withNlpMetadata({id:'graph-action',element:'public-element',effect:{navigates_to:'receipt'}},'ignored'),hash,source},
    ],edges:[{key:'trigger-action',from:'screen:screen-key',to:'action:action-key',relation:'TRIGGERED_BY',attrs:withNlpMetadata({},'ignored'),source}]});
    // Invoke the same LearningWriter-only commit path used by reconciliation.
     const plan=makePlan();storeLearningCommit.reconciliation(store,plan as any);
    const ids=store.db.prepare("SELECT id,type FROM nodes WHERE project_id=? AND canonical_key IN ('screen-key','action-key') ORDER BY type").all('search-project') as Array<{id:string;type:string}>;
    const screen=ids.find(row=>row.type==='screen')!,action=ids.find(row=>row.type==='action')!;
    const values=(id:string,view:number)=>store!.db.prepare('SELECT path,raw_value,value_hash FROM memory_search_values WHERE project_id=? AND environment=? AND node_id=? AND trust_view=?').all(store!.projectId,store!.memoryEnvironment,id,view) as Array<{path:string;raw_value:string;value_hash:string}>;
    assert.deepEqual(values(screen.id,0),[],'YAML seed is absent from verified-only view');
    const seeded=values(screen.id,1);assert(seeded.some(row=>row.path==='attributes.elements[0].description'&&row.raw_value==='Public payment description'));assert.equal(seeded.some(row=>row.raw_value.includes('PRIVATE_SENTINEL')||row.raw_value==='private-selector'),false);
     assert.equal((store.db.prepare('SELECT 1 FROM memory_search_tokens WHERE project_id=? AND environment=? AND node_id=? AND token=?').get(store.projectId,store.memoryEnvironment,screen.id,'payment')!==undefined),true);
     assert.equal(seeded.some(row=>row.path==='attributes.actions[0].id'),true);assert.equal(seeded.some(row=>row.path==='attributes.actions[1].id'),false);
     storeLearningCommit.preparedEdge(store,{from_id:screen.id,to_id:action.id,relation:'TRIGGERED_BY',attributes:withNlpMetadata({},'ignored')});
     const actionValues=values(action.id,1);assert.equal(actionValues.length>0,true);assert.equal(actionValues.some(row=>row.raw_value==='Graph action display'),true);
     store.close();store=undefined;
     const staleEdgeOwner=new Database(filename);staleEdgeOwner.prepare("UPDATE yaml_ownership SET tombstone=1 WHERE project_id=? AND environment=? AND entity_type='edge'").run('search-project','legacy');staleEdgeOwner.prepare("UPDATE memory_search_state SET allowlist_version='stale' WHERE project_id=? AND environment=?").run('search-project','legacy');staleEdgeOwner.close();
     store=new Store(filename,'search-project');
     assert.equal(values(screen.id,1).some(row=>row.raw_value==='Public payment description'),true,'the current screen remains searchable');assert.deepEqual(values(action.id,1),[],'an action with stale YAML edge ownership is excluded');
     const generation=(store.db.prepare('SELECT generation FROM memory_search_state WHERE project_id=? AND environment=?').get(store.projectId,store.memoryEnvironment) as any).generation;
    const df=(token:string,view=1)=>(store!.db.prepare('SELECT document_frequency FROM memory_search_df WHERE project_id=? AND environment=? AND trust_view=? AND token=?').get(store!.projectId,store!.memoryEnvironment,view,token) as any)?.document_frequency??0;
     assert.equal(df('public'),1);assert.equal(df('graph'),0,'excluded actions do not contribute to document frequency');
    const update=makePlan();update.entities[0]!.attrs=withNlpMetadata({id:'checkout',elements:[{id:'public-element',sensitive:true,description:'Public payment description',locator:{by:'test_id',value:'public-control'}},{id:'private-element',sensitive:true,description:'PRIVATE_SENTINEL',locator:{value:'private-selector'}}],actions:[{id:'safe-action',element:'public-element',effect:{navigates_to:'receipt'}}]},'ignored');update.entities[0]!.hash='b'.repeat(64);update.sources[0]!.hash='b'.repeat(64);update.entities[1]!.hash='b'.repeat(64);update.edges[0]!.source=source;
    storeLearningCommit.reconciliation(store,update as any);
    const after=(store.db.prepare('SELECT generation FROM memory_search_state WHERE project_id=? AND environment=?').get(store.projectId,store.memoryEnvironment) as any).generation;
    assert.equal(after,generation+1);assert.equal(values(action.id,1).length,0,'dependent graph action is excluded when its owning element becomes sensitive');assert.equal(values(screen.id,1).some(row=>row.path.startsWith('attributes.elements[0].')),false);assert.equal(df('public'),0);
    const beforeNodes=(store.db.prepare('SELECT count(*) count FROM nodes WHERE project_id=?').get(store.projectId) as any).count,beforeGeneration=after;
    assert.throws(()=>storeLearningCommit.proposedNode(store!,{type:'validation_rule',stable_key:'too-wide',display_name:'Too wide',attributes:withNlpMetadata({description:'x'.repeat(16*1024)},'ignored')}),/searchable values exceed 16384 UTF-8 bytes/);
    assert.equal((store.db.prepare('SELECT count(*) count FROM nodes WHERE project_id=?').get(store.projectId) as any).count,beforeNodes);assert.equal((store.db.prepare('SELECT generation FROM memory_search_state WHERE project_id=? AND environment=?').get(store.projectId,store.memoryEnvironment) as any).generation,beforeGeneration);
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('ineligible screen relations do not make the current action owner ambiguous',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-search-owner-')),filename=path.join(root,'memory.sqlite');let store:Store|undefined;
  try{
    store=new Store(filename,'search-owner');const source='owners.yaml',hash='b'.repeat(64),screen=(key:string)=>({type:'screen',key,name:`${key} screen`,attrs:withNlpMetadata({id:key,elements:[{id:'shared-element'}]},'ignored'),hash,source}),action={type:'action',key:'owned-action',name:'Owned action',attrs:withNlpMetadata({id:'owned-action',element:'shared-element'},'ignored'),hash,source};
    const edge=(key:string,from:string)=>({key,from:`screen:${from}`,to:'action:owned-action',relation:'TRIGGERED_BY',attrs:withNlpMetadata({},'ignored'),source});
    storeLearningCommit.reconciliation(store,{sources:[{path:source,hash}],entities:[screen('current-owner'),screen('stale-owner'),action],edges:[edge('current-trigger','current-owner'),edge('stale-trigger','stale-owner')]} as any);
    const actionId=(store.db.prepare("SELECT id FROM nodes WHERE project_id=? AND type='action' AND canonical_key='owned-action'").get(store.projectId) as any).id;
    const valueCount=()=> (store!.db.prepare('SELECT count(*) count FROM memory_search_values WHERE project_id=? AND environment=? AND node_id=? AND trust_view=1').get(store!.projectId,store!.memoryEnvironment,actionId) as any).count;
    assert.equal(valueCount(),0,'two current eligible screens make ownership ambiguous');store.close();store=undefined;
    const stale=new Database(filename);stale.prepare("UPDATE nodes SET verification_status='stale' WHERE project_id=? AND canonical_key='stale-owner'").run('search-owner');stale.prepare("UPDATE memory_search_state SET allowlist_version='stale' WHERE project_id=? AND environment=?").run('search-owner','legacy');stale.close();
    store=new Store(filename,'search-owner');assert(valueCount()>0,'only the single eligible current screen relation determines ownership');
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});
