import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {Store} from '../src/memory/store.js';
import {withNlpMetadata} from '../src/memory/learning-types.js';
import {storeLearningCommit} from '../src/memory/store-internal.js';
import {migrateProvenanceIndexesV17} from '../src/memory/schema-v17.js';

async function verifiedFact(store:Store,key:string){
  storeLearningCommit.proposedNode(store,{type:'validation_rule',stable_key:key,display_name:`Provenance ${key}`,attributes:withNlpMetadata({description:'Safe searchable fact'},'ignored')} as any);
  const node=store.db.prepare('SELECT id FROM nodes WHERE project_id=? AND environment=? AND canonical_key=?').get(store.projectId,store.memoryEnvironment,key) as {id:string};
  const recorded=store.recordAssertion({session_id:`session-${key}`,subject_node_id:node.id,passed:true,observed_count:7,artifact_ref:'PRIVATE_ARTIFACT_REF',actions:[{action:'click',at:2,target_by:'text',text:'PRIVATE_ACTION_TEXT'}]}) as any;
  assert.equal(store.verify(node.id,recorded.id,{approved:true,source:'local_approver'}),true);
  return{nodeId:node.id,runId:recorded.id,evidenceId:recorded.evidence.id};
}

test('search emits same-scope verified provenance with safe metadata only',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'search-provenance-'));let store:Store|undefined;
  try{
    store=new Store(path.join(root,'memory.sqlite'),'search-provenance');const proof=await verifiedFact(store,'verified-safe');
    const result=store.searchPage('provenance verified-safe',{mode:'prose'}),hit=result.data[0] as any;
    assert.equal(result.data.length,1);assert.equal(hit.provenance.status,'provenance_only');
    assert.deepEqual(hit.provenance.evidence.map((ref:any)=>ref.evidence_id),[proof.evidenceId]);
    const ref=hit.provenance.evidence[0];assert.equal(ref.run_id,proof.runId);assert.equal(ref.subject_node_id,proof.nodeId);
    assert.equal(ref.run_status,'passed');assert.equal(ref.observed_count,7);assert.equal(ref.action_count,1);
    const wire=JSON.stringify(hit);assert.equal(wire.includes('PRIVATE_ARTIFACT_REF'),false);assert.equal(wire.includes('PRIVATE_ACTION_TEXT'),false);assert.equal(wire.includes('metadata_json'),false);
    const external=new Database(path.join(root,'memory.sqlite'));
    const failedId='failed-proposal-evidence';external.prepare("INSERT INTO evidence(id,project_id,run_id,subject_node_id,kind,outcome,metadata_json,artifact_ref,created_at) VALUES(?,?,?,?,'assertion','failed','{}','proposal-secret','2020-01-01T00:00:00.000Z')").run(failedId,store.projectId,proof.runId,proof.nodeId);
    const observation='a'.repeat(64),hash='b'.repeat(64),now=new Date().toISOString();
    external.prepare(`INSERT INTO memory_candidate_observations(id,project_id,environment,source_kind,source_key,source_revision_hash,pipeline_fingerprint,nlp_protocol_version,python_version,spacy_version,model_name,model_version,rules_version,patterns_schema_version,patterns_digest,redaction_policy_fingerprint,extraction_ready,redacted_source_text,entities_json,relations_json,links_json,status,supersedes_observation_id,created_at,updated_at) VALUES(?,?,?,'mcp_node','candidate',?,?,1,'','','','','',0,?,?,0,NULL,'[]','[]','[]','proposed',NULL,?,?)`).run(observation,store.projectId,store.memoryEnvironment,hash,'c'.repeat(64),'d'.repeat(64),'e'.repeat(64),now,now);
    external.prepare('INSERT INTO memory_candidate_evidence_refs(project_id,environment,observation_id,evidence_id,run_id,subject_node_id,created_at) VALUES(?,?,?,?,?,?,?)').run(store.projectId,store.memoryEnvironment,observation,failedId,proof.runId,proof.nodeId,now);external.close();
    const afterProposal=store.searchPage('provenance verified-safe',{mode:'prose'}).data[0] as any;
    assert.deepEqual(afterProposal.provenance.evidence.map((item:any)=>item.evidence_id),[proof.evidenceId],'candidate proposal references do not become search provenance');
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('search marks missing or invalid verified audit proof unavailable',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'search-provenance-unavailable-'));let store:Store|undefined;
  try{
    store=new Store(path.join(root,'memory.sqlite'),'provenance-unavailable');const proof=await verifiedFact(store,'legacy-verified');
    const external=new Database(path.join(root,'memory.sqlite'));external.prepare("UPDATE memory_audit SET detail_json='not-json' WHERE project_id=? AND subject_node_id=? AND action='verify'").run(store.projectId,proof.nodeId);external.close();
    const result=store.searchPage('provenance legacy-verified',{mode:'prose'});assert.equal((result.data[0] as any).provenance.status,'unavailable');assert.deepEqual((result.data[0] as any).provenance.evidence,[]);
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('search rejects verify runs from another scope and non-passing evidence',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'search-provenance-scope-'));let store:Store|undefined,foreign:Store|undefined;
  try{
    const filename=path.join(root,'memory.sqlite');store=new Store(filename,'provenance-scope-a');const proof=await verifiedFact(store,'scoped-verified');
    foreign=new Store(filename,'provenance-scope-b');const foreignSubject=foreign.applicationSubject()!.id;
    const foreignRun=foreign.recordAssertion({session_id:'foreign-session',subject_node_id:foreignSubject,passed:true,observed_count:1}) as any;
    const external=new Database(filename);external.prepare("UPDATE memory_audit SET detail_json=? WHERE project_id=? AND subject_node_id=? AND action='verify'").run(JSON.stringify({runId:foreignRun.id}),store.projectId,proof.nodeId);external.close();
    let hit=store.searchPage('provenance scoped-verified',{mode:'prose'}).data[0] as any;assert.equal(hit.provenance.status,'unavailable');
    const repair=new Database(filename);repair.prepare("UPDATE memory_audit SET detail_json=? WHERE project_id=? AND subject_node_id=? AND action='verify'").run(JSON.stringify({runId:proof.runId}),store.projectId,proof.nodeId);repair.prepare("UPDATE evidence SET outcome='failed' WHERE project_id=? AND run_id=? AND id=?").run(store.projectId,proof.runId,proof.evidenceId);repair.close();
    hit=store.searchPage('provenance scoped-verified',{mode:'prose'}).data[0] as any;assert.equal(hit.provenance.status,'unavailable');
  }finally{foreign?.close();store?.close();await rm(root,{recursive:true,force:true});}
});

test('YAML search provenance uses only the current source revision hash',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'search-provenance-yaml-'));let store:Store|undefined;
  try{
    store=new Store(path.join(root,'memory.sqlite'),'provenance-yaml');const hash='f'.repeat(64),source='private/path/never-emitted.yaml';
    storeLearningCommit.reconciliation(store,{sources:[{path:source,hash}],entities:[{type:'screen',key:'yaml-screen',name:'Current YAML provenance',attrs:withNlpMetadata({id:'yaml-screen',elements:[]},'ignored'),hash,source}],edges:[]} as any);
    const result=store.searchPage('yaml provenance',{mode:'prose',trustYamlSeeds:true}),hit=result.data.find((row:any)=>row.stable_key==='yaml-screen') as any;
    assert.equal(hit.provenance.source_kind,'yaml_document');assert.equal(hit.provenance.source_revision_hash,hash);assert.equal(hit.provenance.status,'source_provenance_only');
    assert.equal(JSON.stringify(hit).includes(source),false);
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('v17 provenance indexes are created and migration is atomic',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'search-provenance-index-'));let store:Store|undefined;
  try{
    const filename=path.join(root,'memory.sqlite');store=new Store(filename,'provenance-index');
    assert.equal((store.db.prepare('SELECT version FROM schema_migrations WHERE version=17').get() as any).version,17);
    assert.equal((store.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='memory_audit_verify_subject_latest'").get() as any).sql.includes("WHERE action='verify'"),true);
    assert(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='evidence_assertion_provenance_lookup'").get());
    assert(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='memory_search_edges_from_bounded'").get());
    assert(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='memory_search_edges_to_bounded'").get());
    store.close();store=undefined;
    const db=new Database(':memory:');db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);CREATE TABLE memory_audit(project_id TEXT,subject_node_id TEXT,created_at TEXT,id TEXT,action TEXT);CREATE TABLE evidence(project_id TEXT,subject_node_id TEXT,run_id TEXT,kind TEXT,outcome TEXT,created_at TEXT,id TEXT);CREATE INDEX memory_audit_verify_subject_latest ON memory_audit(project_id,subject_node_id,created_at,id) WHERE action='verify';`);
    assert.throws(()=>migrateProvenanceIndexesV17(db));assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE version=17').get(),undefined);assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='evidence_assertion_provenance_lookup'").get(),undefined);db.close();
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});
