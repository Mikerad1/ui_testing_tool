import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {Store,type CandidateObservationInput} from '../src/memory/store.js';
import {fixtureEdge,runFixtureSql,testWriter} from './helpers/learning.js';

const fingerprint='a'.repeat(64),digest='b'.repeat(64),redaction='c'.repeat(64);
function observation(overrides:Record<string,unknown>={}){
  return{source_kind:'mcp_node' as const,source_key:'obs-1',source_revision_hash:fingerprint,pipeline_fingerprint:digest,
    nlp_protocol_version:3,python_version:'3.12',spacy_version:'3.8',model_name:'model',model_version:'1',rules_version:'rules-1',
    patterns_schema_version:1,patterns_digest:digest,redaction_policy_fingerprint:redaction,extraction_ready:true,redacted_source_text:'redacted text',
    entities:[{id:'e1',text:'redacted',start:0,end:8}],relations:[],links:[],status:'proposed' as const,...overrides};
}
// Test-only native fixture writer: production callers must use trusted commit paths.
const appendObservation=(store:Store,filename:string,input:CandidateObservationInput)=>{
  const db=new Database(filename);
  try{
    const id=createHash('sha256').update(`${store.projectId}:${store.memoryEnvironment}:${input.source_kind}:${input.source_key}:${input.source_revision_hash}:${input.pipeline_fingerprint}`).digest('hex');
    const now=input.created_at??new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO memory_candidate_observations(id,project_id,environment,source_kind,source_key,source_revision_hash,pipeline_fingerprint,nlp_protocol_version,python_version,spacy_version,model_name,model_version,rules_version,patterns_schema_version,patterns_digest,redaction_policy_fingerprint,extraction_ready,redacted_source_text,entities_json,relations_json,links_json,status,supersedes_observation_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,store.projectId,store.memoryEnvironment,input.source_kind,input.source_key,input.source_revision_hash,input.pipeline_fingerprint,input.nlp_protocol_version,input.python_version,input.spacy_version,input.model_name,input.model_version,input.rules_version,input.patterns_schema_version,input.patterns_digest,input.redaction_policy_fingerprint,input.extraction_ready?1:0,input.redacted_source_text??null,JSON.stringify(input.entities),JSON.stringify(input.relations),JSON.stringify(input.links),input.status,input.supersedes_observation_id??null,now,now);
    return{id,...input,created_at:now};
  }finally{db.close();}
};

test('v13 candidate ledger is scoped, append-only by identity, and exact retries are no-ops',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-candidate-ledger-')),filename=path.join(dir,'memory.sqlite');
  let store:Store|undefined,other:Store|undefined,otherProject:Store|undefined;
  try{
    store=await Store.open(filename,'ledger-project','local');
    assert.equal((store.db.prepare('SELECT max(version) version FROM schema_migrations').get() as {version:number}).version,14);
    assert.equal('appendCandidateObservation' in store,false,'raw candidate writes are not exposed on Store');
    const original=observation(),inserted=appendObservation(store,filename,original),replayed=appendObservation(store,filename,{...original,created_at:'2026-01-01T00:00:00.000Z'});
    assert.equal(inserted.id,replayed.id);
    assert.deepEqual(replayed.entities,original.entities);
    assert.equal(store.listCandidateObservations().length,1);
    const native=new Database(filename);
    try{
      assert.throws(()=>native.prepare('UPDATE memory_candidate_observations SET status=? WHERE id=?').run('rejected',inserted.id),/immutable/);
      assert.throws(()=>native.prepare('DELETE FROM memory_candidate_observations WHERE id=?').run(inserted.id),/immutable/);
    }finally{native.close();}

    appendObservation(store,filename,observation({source_key:'obs-2'}));
    appendObservation(store,filename,observation({source_revision_hash:'d'.repeat(64)}));
    appendObservation(store,filename,observation({pipeline_fingerprint:'e'.repeat(64)}));
    assert.equal(store.listCandidateObservations().length,4);
    other=await Store.open(filename,'ledger-project','staging');
    otherProject=await Store.open(filename,'another-project','local');
    assert.equal(other.listCandidateObservations().length,0);
    assert.equal(otherProject.listCandidateObservations().length,0);
    appendObservation(other,filename,original);
    appendObservation(otherProject,filename,original);
    assert.notEqual(other.listCandidateObservations()[0]!.id,inserted.id);
    assert.notEqual(otherProject.listCandidateObservations()[0]!.id,inserted.id);
  }finally{store?.close();other?.close();otherProject?.close();await rm(dir,{recursive:true,force:true});}
});

test('candidate review pages are scoped, stable, filtered, bounded, and derive only explicit graph links',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-candidate-review-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined,other:Store|undefined;
  try{
    store=await Store.open(filename,'review-project','local');
    const node=await testWriter(store).propose({observation_id:'review-linked',type:'screen',stable_key:'review-node',display_name:'Review node'}) as any;
    const target=await testWriter(store).propose({observation_id:'review-edge-target',type:'screen',stable_key:'review-edge-target',display_name:'Edge target'}) as any;
    const edge=fixtureEdge(store,filename,node.id,target.id,'NAVIGATES_TO');
      const make=(source_key:string,overrides:Record<string,unknown>={})=>appendObservation(store!,filename,observation({source_kind:'yaml_document',source_key,created_at:'2026-01-01T00:00:00.000Z',links:[],...overrides}));
      const a=make('a',{entities:[{id:'mention',text:'Review node',start:0,end:11}],links:[{kind:'node',id:node.id}]});
      const b=make('b');const c=make('c',{status:'conflict'});const d=appendObservation(store,filename,observation({source_kind:'backfill_node',source_key:`node:${node.id}`,links:[]}));
     const yamlRevision='f'.repeat(64),yamlRaw='1'.repeat(64),yamlPath='known.yaml';
     const fixtureDb=new Database(filename);try{
       fixtureDb.prepare('INSERT INTO yaml_sources(project_id,environment,path,hash,imported_at,active) VALUES(?,?,?,?,?,1)').run(store.projectId,store.memoryEnvironment,yamlPath,yamlRaw,'2026-01-01');
       fixtureDb.prepare('INSERT INTO yaml_ownership(project_id,environment,source_path,entity_type,entity_key,entity_id,hash,tombstone,conflict_status) VALUES(?,?,?,?,?,?,?,0,\'none\')').run(store.projectId,store.memoryEnvironment,yamlPath,'workflow','known-document','yaml-node',yamlRaw);
       fixtureDb.prepare('INSERT INTO yaml_record_fingerprints(project_id,environment,document_kind,document_id,source_path,raw_hash,redacted_hash,preparation_key,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(store.projectId,store.memoryEnvironment,'workflow','known-document',yamlPath,yamlRaw,yamlRevision,digest,'2026-01-01');
     }finally{fixtureDb.close();}
     const known=make('workflow:known-document',{source_revision_hash:yamlRevision});
     const expected=[a.id,b.id,c.id,known.id].sort();const first=store.listCandidateObservationPage({source_kind:'yaml_document',limit:2});assert.equal(first.items.length,2);assert.deepEqual(first.items.map(item=>item.id),expected.slice(0,2));assert(first.next_cursor);
    const second=store.listCandidateObservationPage({source_kind:'yaml_document',limit:2,cursor:first.next_cursor!});assert.deepEqual(second.items.map(item=>item.id),expected.slice(2));assert.equal(second.next_cursor,null);
    assert.throws(()=>store.listCandidateObservationPage({cursor:'not-a-cursor'}),/cursor/);
    assert.throws(()=>store.listCandidateObservationPage({cursor:Buffer.from(JSON.stringify(['not-time','f'.repeat(64)])).toString('base64url')}),/cursor/);
    assert.equal(store.listCandidateObservationPage({source_key:'b'}).items.length,1);
    assert.deepEqual(store.listCandidateObservationPage({source_kind:'yaml_document',stored_status:'conflict'}).items.map(item=>item.id),[c.id]);
     assert.equal(store.listCandidateObservationPage({source_kind:'yaml_document',limit:1000}).items.length,4);
    const defaultRecord=store.listCandidateObservationPage({source_key:'a'}).items[0] as any;assert.equal('redacted_source_text' in defaultRecord,false);assert.equal(defaultRecord.stored_status,'proposed');assert.equal(defaultRecord.current_status,'proposed');assert.equal(defaultRecord.source_current,'current');
    assert.equal(defaultRecord.entities[0].text,'Review node');assert.deepEqual(defaultRecord.links,[{kind:'node',id:node.id}]);
    const withText=store.listCandidateObservationPage({source_key:'a',include_redacted_source:true}).items[0] as any;assert.equal(withText.redacted_source.label,'redacted_untrusted');assert.equal(withText.redacted_source.text,'redacted text');
      const noLink=store.listCandidateObservationPage({source_key:'b'}).items[0] as any;assert.equal(noLink.current_status,'unknown');assert.equal(noLink.source_current,'unknown','candidate mentions do not create graph links');
     let knownReview=store.listCandidateObservationPage({source_key:'workflow:known-document'}).items[0] as any;assert.equal(knownReview.current_status,'current');assert.equal(knownReview.source_current,'current');
     runFixtureSql(filename,'UPDATE yaml_record_fingerprints SET redacted_hash=? WHERE project_id=? AND environment=? AND document_kind=? AND document_id=?','2'.repeat(64),store.projectId,store.memoryEnvironment,'workflow','known-document');
     knownReview=store.listCandidateObservationPage({source_key:'workflow:known-document'}).items[0] as any;assert.equal(knownReview.current_status,'stale');assert.equal(knownReview.source_current,'stale');
    const initialBackfill=store.listCandidateObservationPage({source_kind:'backfill_node'}).items[0] as any;assert.equal(initialBackfill.current_status,'proposed');
      const backfillEdge=appendObservation(store,filename,observation({source_kind:'backfill_edge',source_key:`edge:${edge.id}`,links:[]}));
    assert.equal((store.listCandidateObservationPage({source_key:`edge:${edge.id}`}).items[0] as any).current_status,'proposed');
    runFixtureSql(filename,"UPDATE nodes SET verification_status='verified' WHERE project_id=? AND environment=? AND id=?",store.projectId,store.memoryEnvironment,node.id);
    assert.equal((store.listCandidateObservationPage({source_key:'a'}).items[0] as any).current_status,'verified');
    assert.equal((store.listCandidateObservationPage({source_kind:'backfill_node'}).items[0] as any).current_status,'verified');
    assert.equal((store.listCandidateObservationPage({source_kind:'backfill_edge'}).items[0] as any).current_status,'proposed');
    runFixtureSql(filename,"UPDATE nodes SET conflict_status='conflict' WHERE project_id=? AND environment=? AND id=?",store.projectId,store.memoryEnvironment,node.id);
    assert.equal((store.listCandidateObservationPage({source_key:'a'}).items[0] as any).current_status,'conflict');
    runFixtureSql(filename,"UPDATE nodes SET tombstone=1 WHERE project_id=? AND environment=? AND id=?",store.projectId,store.memoryEnvironment,node.id);
    const afterDelete=store.listCandidateObservationPage({source_key:'a'}).items[0] as any;assert.equal(afterDelete.stored_status,'proposed');assert.equal(afterDelete.current_status,'tombstoned');assert.equal(afterDelete.source_current,'stale');
    assert.equal((store.listCandidateObservationPage({source_key:`edge:${edge.id}`}).items[0] as any).current_status,'proposed');assert.equal(backfillEdge.source_key,`edge:${edge.id}`);
    other=await Store.open(filename,'review-project','staging');assert.equal(other.listCandidateObservationPage().items.length,0);
  }finally{store?.close();other?.close();await rm(dir,{recursive:true,force:true});}
});

test('candidate response byte budget omits oversized fields explicitly and preserves keyset progress',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-candidate-budget-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=await Store.open(filename,'budget-project','local');
      appendObservation(store,filename,observation({source_kind:'mcp_edge',source_key:'large',created_at:'2025-01-01T00:00:00.000Z',redacted_source_text:'R'.repeat(65000),entities:[{text:'E'.repeat(240000)}],relations:[{text:'L'.repeat(120000)}]}));
      const next=appendObservation(store,filename,observation({source_kind:'mcp_edge',source_key:'next',created_at:'2025-01-02T00:00:00.000Z'}));
    const page=store.listCandidateObservationPage({source_kind:'mcp_edge',limit:1,include_redacted_source:true});
    assert(Buffer.byteLength(JSON.stringify(page),'utf8')<=48*1024);assert.equal(page.truncated,true);assert(page.next_cursor);
    const row=page.items[0] as any;assert.equal(row.truncated,true);assert(row.omitted_fields.includes('entities'));assert(row.omitted_fields.includes('redacted_source'));assert(!JSON.stringify(page).includes('R'.repeat(100)));
    const continued=store.listCandidateObservationPage({source_kind:'mcp_edge',limit:1,cursor:page.next_cursor!,include_redacted_source:true});assert.equal(continued.items[0]!.id,next.id);assert.equal(continued.next_cursor,null);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('v13 migration failure is atomic and can be retried',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-candidate-migration-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=await Store.open(filename,'migration-project');store.close();store=undefined;
    const native=new Database(filename);
    native.exec("DROP TABLE memory_candidate_observations; DROP TABLE memory_search_tokens; DROP TABLE memory_search_values; DROP TABLE memory_search_df; DROP TABLE memory_search_state; DELETE FROM schema_migrations WHERE version IN (13,14); CREATE TRIGGER fail_v13 BEFORE INSERT ON schema_migrations WHEN NEW.version=13 BEGIN SELECT RAISE(ABORT,'forced v13 failure'); END");native.close();
    await assert.rejects(Store.open(filename,'migration-project'),/forced v13 failure/);
    const inspect=new Database(filename);try{
      assert.equal((inspect.prepare('SELECT max(version) version FROM schema_migrations').get() as {version:number}).version,12);
      assert.equal(inspect.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_candidate_observations'").get(),undefined);
    }finally{inspect.close();}
    const retry=new Database(filename);retry.exec('DROP TRIGGER fail_v13');retry.close();
    store=await Store.open(filename,'migration-project');
    assert.equal((store.db.prepare('SELECT max(version) version FROM schema_migrations').get() as {version:number}).version,14);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
