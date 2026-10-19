import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {Store,type CandidateObservationInput} from '../src/memory/store.js';
import {withNlpMetadata} from '../src/memory/learning-types.js';
import {storeLearningCommit,type EvidenceReference} from '../src/memory/store-internal.js';

const hash='a'.repeat(64),patterns='b'.repeat(64),redaction='c'.repeat(64);
function observation(source_key:string,pipeline_fingerprint=hash):CandidateObservationInput{return{
  source_kind:'mcp_node',source_key,source_revision_hash:hash,pipeline_fingerprint,nlp_protocol_version:1,
  python_version:'3.12',spacy_version:'3.8',model_name:'test',model_version:'1',rules_version:'rules',patterns_schema_version:1,
  patterns_digest:patterns,redaction_policy_fingerprint:redaction,extraction_ready:true,redacted_source_text:'redacted',
  entities:[{id:'e1',text:'candidate'}],relations:[],links:[],status:'proposed',
};}
function commitNode(store:Store,source_key:string,refs:EvidenceReference[],pipeline=hash){
  return storeLearningCommit.mcpNode(store,{observation:observation(source_key,pipeline),evidence_refs:refs,type:'screen',stable_key:`key-${source_key}-${pipeline.slice(0,4)}`,display_name:`Node ${source_key}`,attributes:withNlpMetadata({},'node text')});
}
function evidence(store:Store,subject:string,{outcome='passed',runStatus='passed'}:{outcome?:string;runStatus?:string}={}){
  const run_id=store.createRun();store.addEvidence({run_id,subject_node_id:subject,kind:'assertion',outcome});store.finishRun(run_id,runStatus);
  const row=store.db.prepare('SELECT id FROM evidence WHERE project_id=? AND run_id=?').get(store.projectId,run_id) as {id:string};
  return{evidence_id:row.id,run_id,subject_node_id:subject};
}

test('v16 scoped evidence associations validate, persist immutably, and span pipeline revisions',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-evidence-store-')),filename=path.join(dir,'memory.sqlite');
  let store:Store|undefined,staging:Store|undefined,otherProject:Store|undefined;
  try{
    store=await Store.open(filename,'evidence-project','local');
    staging=await Store.open(filename,'evidence-project','staging');
    otherProject=await Store.open(filename,'other-project','local');
    assert.equal((store.db.prepare('SELECT max(version) version FROM schema_migrations').get() as {version:number}).version,16);
    const v13Triggers=store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_candidate_observations_%' ORDER BY name").all();
    assert.deepEqual(v13Triggers.map((row:any)=>row.name),['memory_candidate_observations_no_delete','memory_candidate_observations_no_update']);
    assert(v13Triggers.every((row:any)=>row.sql.includes('candidate observations are immutable')));

    const anchor=(store.db.prepare("SELECT id FROM nodes WHERE project_id=? AND environment=? AND origin='human' LIMIT 1").get(store.projectId,store.memoryEnvironment) as {id:string}).id;
    const scopeAnchor=(scope:Store)=>(scope.db.prepare("SELECT id FROM nodes WHERE project_id=? AND environment=? AND origin='human' LIMIT 1").get(scope.projectId,scope.memoryEnvironment) as {id:string}).id;
     const ref=evidence(store,anchor);
     const proposal=commitNode(store,'same-observation',[ref]) as any;
     const refs=store.listCandidateEvidenceReferences((store.listCandidateObservations({source_key:'same-observation'})[0]!).id);
     assert.deepEqual(refs,[{...ref,valid:true,status:'current'}]);
     const review=store.listCandidateObservationPage({source_key:'same-observation'}).items[0] as any;
     assert.equal(review.evidence_link_status,'provenance_only');
     assert.deepEqual(review.evidence_refs,[{...ref,valid:true,status:'current'}]);
     assert.equal(review.current_status,'proposed');
     assert.equal((store.get(proposal.id) as any).verification_status,'proposed','provenance links do not verify a candidate');
     assert(!JSON.stringify(review).includes('artifact_ref')&&!JSON.stringify(review).includes('metadata_json'),'review exposes refs and validity only, not assertion metadata');
     const staleSubjectDb=new Database(filename);try{staleSubjectDb.prepare("UPDATE nodes SET verification_status='stale' WHERE project_id=? AND environment=? AND id=?").run(store.projectId,store.memoryEnvironment,anchor);}finally{staleSubjectDb.close();}
      const staleLink=store.listCandidateObservationPage({source_key:'same-observation'}).items[0] as any;
      assert.equal(staleLink.evidence_refs[0].valid,false);assert.equal(staleLink.evidence_refs[0].status,'invalid');
      assert.equal((store.get(proposal.id) as any).verification_status,'proposed','a later-invalid provenance ref also cannot verify a candidate');
      assert.equal((commitNode(store,'same-observation',[ref]) as any).id,proposal.id,'exact committed retry remains idempotent after evidence becomes invalid');
      assert.throws(()=>commitNode(store,'same-observation',[{...ref,subject_node_id:'different-subject'}]),/different evidence references/);
      assert.throws(()=>commitNode(store,'same-observation',[ref],'d'.repeat(64)),/Evidence reference/,'new pipeline revision still validates refs');
      assert.throws(()=>commitNode(store,'new-while-stale',[ref]),/Evidence reference/,'new observation still validates refs');
      const restoreSubjectDb=new Database(filename);try{restoreSubjectDb.prepare("UPDATE nodes SET verification_status='verified' WHERE project_id=? AND environment=? AND id=?").run(store.projectId,store.memoryEnvironment,anchor);}finally{restoreSubjectDb.close();}
     const ledger=store.listCandidateObservations({source_key:'same-observation'})[0]!;
    assert.deepEqual(ledger.entities,[{id:'e1',text:'candidate'}]);
    assert(!JSON.stringify(ledger).includes(ref.evidence_id),'refs remain outside the NLP candidate payload');

    const retry=commitNode(store,'same-observation',[ref]) as any;assert.equal(retry.id,proposal.id);
    assert.equal((store.db.prepare('SELECT count(*) count FROM memory_candidate_evidence_refs WHERE project_id=? AND environment=? AND observation_id=?').get(store.projectId,store.memoryEnvironment,ledger.id) as {count:number}).count,1);
    const secondPipeline=commitNode(store,'same-observation',[ref],'d'.repeat(64)) as any;
    assert.equal(secondPipeline.id,proposal.id);
    const versions=store.listCandidateObservations({source_key:'same-observation'});
    assert.equal(versions.length,2);
    for(const version of versions)assert.deepEqual(store.listCandidateEvidenceReferences(version.id).map(({evidence_id,run_id,subject_node_id})=>({evidence_id,run_id,subject_node_id})),[ref]);
    assert.throws(()=>commitNode(store!,'same-observation',[evidence(store!,anchor)],'e'.repeat(64)),/different evidence references/);

    const foreignProject=evidence(otherProject,scopeAnchor(otherProject)),foreignEnvironment=evidence(staging,scopeAnchor(staging));
    assert.throws(()=>commitNode(store,'wrong-project',[foreignProject]),/Evidence reference/);
    assert.throws(()=>commitNode(store,'wrong-environment',[foreignEnvironment]),/Evidence reference/);
    const anotherPassedRun=evidence(store,anchor);
    assert.throws(()=>commitNode(store,'wrong-run',[{...ref,run_id:anotherPassedRun.run_id}]),/Evidence reference/);
    const failedAssertion=evidence(store,anchor,{outcome:'failed'});
    assert.throws(()=>commitNode(store,'failed-assertion',[failedAssertion]),/Evidence reference/);
    const failedRun=evidence(store,anchor,{runStatus:'failed'});
    assert.throws(()=>commitNode(store,'failed-run',[failedRun]),/Evidence reference/);

    for(const [label,field,value] of [['tombstone','tombstone',1],['stale','verification_status','stale'],['conflict','conflict_status','conflict'],['superseded','superseded_by','not-a-live-node']] as const){
      const subject=(store.db.prepare('SELECT id FROM nodes WHERE project_id=? AND environment=? AND origin=\'human\' LIMIT 1').get(store.projectId,store.memoryEnvironment) as {id:string}).id;
      const inactive=evidence(store,subject);
      const native=new Database(filename);try{native.prepare(`UPDATE nodes SET ${field}=? WHERE project_id=? AND environment=? AND id=?`).run(value,store.projectId,store.memoryEnvironment,subject);}finally{native.close();}
      assert.throws(()=>commitNode(store,`inactive-${label}`,[inactive]),/Evidence reference/);
      const restore=new Database(filename);try{restore.prepare(`UPDATE nodes SET ${field}=? WHERE project_id=? AND environment=? AND id=?`).run(field==='tombstone'?0:field==='superseded_by'?null:field==='verification_status'?'verified':'none',store.projectId,store.memoryEnvironment,subject);}finally{restore.close();}
    }

     const endpoint=storeLearningCommit.proposedNode(store,{type:'screen',stable_key:'edge-endpoint-screen',display_name:'Edge screen',attributes:withNlpMetadata({},'screen')}) as any;
     const action=storeLearningCommit.proposedNode(store,{type:'action',stable_key:'edge-endpoint-action',display_name:'Edge action',attributes:withNlpMetadata({},'action')}) as any;
     const edgeRef=evidence(store,endpoint.id),edgeInput={observation:{...observation('retry-edge'),source_kind:'mcp_edge' as const},evidence_refs:[edgeRef],from_id:endpoint.id,to_id:action.id,relation:'TRIGGERED_BY',attributes:withNlpMetadata({},'edge')};
     const committedEdge=storeLearningCommit.mcpEdge(store,edgeInput) as any;
     const staleEdgeSubjectDb=new Database(filename);try{staleEdgeSubjectDb.prepare("UPDATE nodes SET verification_status='stale' WHERE project_id=? AND environment=? AND id=?").run(store.projectId,store.memoryEnvironment,endpoint.id);}finally{staleEdgeSubjectDb.close();}
     assert.equal((storeLearningCommit.mcpEdge(store,edgeInput) as any).id,committedEdge.id,'exact committed edge retry remains idempotent after evidence becomes invalid');
     assert.throws(()=>storeLearningCommit.mcpEdge(store,{...edgeInput,evidence_refs:[{...edgeRef,subject_node_id:action.id}]}),/different evidence references/);
     assert.throws(()=>storeLearningCommit.mcpEdge(store,{...edgeInput,observation:{...edgeInput.observation,pipeline_fingerprint:'e'.repeat(64)}}),/Evidence reference/,'new edge pipeline still validates refs');
     const restoreEdgeSubjectDb=new Database(filename);try{restoreEdgeSubjectDb.prepare("UPDATE nodes SET verification_status='verified' WHERE project_id=? AND environment=? AND id=?").run(store.projectId,store.memoryEnvironment,endpoint.id);}finally{restoreEdgeSubjectDb.close();}
     const notEndpoint=evidence(store,anchor);
    assert.throws(()=>storeLearningCommit.mcpEdge(store,{observation:{...observation('bad-edge'),source_kind:'mcp_edge'},evidence_refs:[notEndpoint],from_id:endpoint.id,to_id:action.id,relation:'TRIGGERED_BY',attributes:withNlpMetadata({},'edge')}),/endpoint/);

    const legacy=observation('legacy-observation');
    const native=new Database(filename);try{
      const legacyId='f'.repeat(64),now=new Date().toISOString();
      native.prepare(`INSERT INTO memory_candidate_observations(id,project_id,environment,source_kind,source_key,source_revision_hash,pipeline_fingerprint,nlp_protocol_version,python_version,spacy_version,model_name,model_version,rules_version,patterns_schema_version,patterns_digest,redaction_policy_fingerprint,extraction_ready,redacted_source_text,entities_json,relations_json,links_json,status,supersedes_observation_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(legacyId,store.projectId,store.memoryEnvironment,legacy.source_kind,legacy.source_key,legacy.source_revision_hash,legacy.pipeline_fingerprint,legacy.nlp_protocol_version,legacy.python_version,legacy.spacy_version,legacy.model_name,legacy.model_version,legacy.rules_version,legacy.patterns_schema_version,legacy.patterns_digest,legacy.redaction_policy_fingerprint,1,legacy.redacted_source_text,JSON.stringify(legacy.entities),JSON.stringify(legacy.relations),JSON.stringify(legacy.links),'proposed',null,now,now);
    }finally{native.close();}
    assert.throws(()=>commitNode(store,'legacy-observation',[ref]),/Legacy candidate observations/);

    const rollbackObservation='rollback-observation';
    const triggerDb=new Database(filename);try{triggerDb.exec("CREATE TRIGGER fail_evidence_assoc BEFORE INSERT ON memory_candidate_evidence_refs BEGIN SELECT RAISE(ABORT,'forced evidence association failure'); END");}finally{triggerDb.close();}
    assert.throws(()=>commitNode(store,rollbackObservation,[ref]),/forced evidence association failure/);
    assert.equal(store.listCandidateObservations({source_key:rollbackObservation}).length,0);
    assert.equal((store.db.prepare('SELECT count(*) count FROM nodes WHERE project_id=? AND environment=? AND stable_key=?').get(store.projectId,store.memoryEnvironment,`key-${rollbackObservation}-aaaa`) as {count:number}).count,0);
    const checkDb=new Database(filename);try{checkDb.exec('DROP TRIGGER fail_evidence_assoc');}finally{checkDb.close();}

    const fresh=commitNode(store,'immutable-association',[ref]) as any;
    const freshObservation=store.listCandidateObservations({source_key:'immutable-association'})[0]!;
    assert.equal(fresh.id.length,64);
    assert.throws(()=>store!.db.prepare('UPDATE memory_candidate_evidence_refs SET subject_node_id=? WHERE observation_id=?').run(anchor,freshObservation.id),/read-only/);
    const mutationDb=new Database(filename);try{
      assert.throws(()=>mutationDb.prepare('UPDATE memory_candidate_evidence_refs SET run_id=? WHERE observation_id=?').run(ref.run_id,freshObservation.id),/immutable/);
      assert.throws(()=>mutationDb.prepare('DELETE FROM memory_candidate_evidence_refs WHERE observation_id=?').run(freshObservation.id),/immutable/);
    }finally{mutationDb.close();}
  }finally{store?.close();staging?.close();otherProject?.close();await rm(dir,{recursive:true,force:true});}
});
