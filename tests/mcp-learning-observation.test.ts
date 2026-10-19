import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {Store} from '../src/memory/store.js';
import {LearningWriter,type NlpProcessor} from '../src/memory/learning-writer.js';
import {createMemoryRedactor} from '../src/memory/redactor.js';
import {storeLearningCommit} from '../src/memory/store-internal.js';
import {withNlpMetadata} from '../src/memory/learning-types.js';
import {withTestEvidence} from './helpers/learning.js';

function writer(store:Store,options:{failAnalyze?:boolean;emptyPatterns?:boolean;rules?:string;invalidOutput?:'signature'|'index'|'self'|'label'|'span';malformedHealth?:string;analysisCalls?:{value:number};inputs?:string[]}={}){
  const processor:NlpProcessor={
    async health(){
      const response:any={version:3,id:'h',ok:true,op:'health',health:{protocol:3,python:'3.12',spacy:'3.8',model:'test',model_version:'1',rules:options.rules??'r1',patterns_schema_version:1,patterns_digest:'b'.repeat(64),pattern_count:options.emptyPatterns?0:2,patterns_ready:!options.emptyPatterns,ready:true}};
      switch(options.malformedHealth){
        case'idEmpty':response.id='';break;
        case'idTooLong':response.id='h'.repeat(101);break;
        case'ok':response.ok=false;break;
        case'op':response.op='analyze';break;
        case'healthNull':response.health=null;break;
        case'version':response.version=2;break;
        case'protocol':response.health.protocol=2;break;
        case'python':response.health.python='';break;
        case'spacy':response.health.spacy='x'.repeat(101);break;
        case'model':response.health.model='';break;
        case'modelVersion':response.health.model_version='';break;
        case'rules':response.health.rules='';break;
        case'schema':response.health.patterns_schema_version=2;break;
        case'digest':response.health.patterns_digest='A'.repeat(64);break;
        case'countNegative':response.health.pattern_count=-1;break;
        case'countOverLimit':response.health.pattern_count=129;break;
        case'countFractional':response.health.pattern_count=1.5;break;
        case'emptyReady':response.health.pattern_count=0;response.health.patterns_ready=true;break;
        case'patternsNotReady':response.health.patterns_ready=false;break;
        case'notReady':response.health.ready=false;break;
        case'modelUnavailable':response.health.model='unavailable';response.health.ready=false;break;
        case'patternsReadyType':response.health.patterns_ready='yes';break;
      }
      return response;
    },
    async analyze(text){
      if(options.analysisCalls)options.analysisCalls.value++;
      options.inputs?.push(text);
      if(options.failAnalyze)throw new Error('invalid spaCy response');
      const span=(value:string)=>{const offset=text.indexOf(value);if(offset<0)throw Error('missing fixture mention');const start=Array.from(text.slice(0,offset)).length;return{start,end:start+Array.from(value).length,text:value};};
      const entities=[] as any[],relations=[] as any[];
      if(text.includes('Button')&&text.includes('Checkout')){entities.push({label:options.invalidOutput==='signature'?'FIELD':'ACTION',rule_id:'field_rule',normalized:'button',...span('Button')},{label:'PAGE',rule_id:'page_rule',normalized:'checkout',...span('Checkout')});if(options.invalidOutput==='span')entities[1]!.end++;if(text.includes('opens'))relations.push({type:'NAVIGATES_TO',rule_id:'nav_rule',from_index:options.invalidOutput==='index'?3:0,to_index:options.invalidOutput==='self'?0:1,evidence:span('opens')});if(options.invalidOutput==='label')entities[0]!.label='APPLICATION';}
      return{version:3,id:'a',ok:true,op:'analyze',normalized:'fixture normalized',tokens:[],entities,relations};
    },async shutdown(){}
  };
  return withTestEvidence(new LearningWriter(store,processor,createMemoryRedactor({sensitive_paths:[],sensitive_values_env:[]},{})),store);
}

const edgeInput=(observation_id:string,description='🌞 Button opens Checkout')=>({observation_id,from_id:'node-from',to_id:'node-to',relation:'NAVIGATES_TO',attributes:{description}});

test('MCP node observation retries return stable graph ID; fresh observations preserve canonical conflicts',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-mcp-observation-'));let store:Store|undefined;
  try{
    store=await Store.open(path.join(dir,'memory.sqlite'),'mcp-ledger');const learning=writer(store);
    const input={observation_id:'node-observation',type:'screen',stable_key:'home',display_name:'Button',attributes:{description:'Button opens Checkout'}};
    const first=await learning.propose(input) as any,again=await learning.propose(input) as any;
    assert.equal(first.id,again.id);assert.equal((store.listCandidateObservations({source_kind:'mcp_node'})).length,1);
    const sameClaim=await learning.propose({...input,observation_id:'node-observation-same-claim'}) as any;
    assert.equal(sameClaim.id,first.id);assert.equal(sameClaim.conflict_status,'none');
    const second=await learning.propose({...input,observation_id:'node-observation-2',display_name:'Changed'}) as any;
    assert.notEqual(second.id,first.id);assert.equal(second.conflict_status,'conflict');assert.equal(store.listCandidateObservations({source_kind:'mcp_node'}).length,3);
    assert.equal((store.get(first.id) as any).conflict_status,'conflict');
    await assert.rejects(()=>learning.propose({...input,display_name:'Changed'}),/failed safely/);
    const upgraded=await writer(store,{rules:'r2'}).propose(input) as any;
    assert.equal(upgraded.id,first.id);assert.equal(store.listCandidateObservations({source_kind:'mcp_node'}).length,4);
    await assert.rejects(()=>learning.propose({type:'screen',stable_key:'missing-id',display_name:'No ID'} as any),/Invalid observation_id/);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('MCP evidence refs are excluded from NLP and persisted candidate/graph content',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-mcp-evidence-redaction-'));let store:Store|undefined;
  try{
    store=await Store.open(path.join(dir,'memory.sqlite'),'mcp-evidence-redaction');
    const subject=store.applicationSubject()!,assertion=store.recordAssertion({session_id:'evidence-ref-test',subject_node_id:subject.id,passed:true,observed_count:1});
    const ref={evidence_id:(assertion.evidence as any).id,run_id:assertion.id,subject_node_id:subject.id},inputs:string[]=[];
    const proposal=await writer(store,{inputs}).propose({observation_id:'refs-not-nlp',type:'screen',stable_key:'refs-not-nlp',display_name:'Refs not NLP',evidence_refs:[ref]}) as any;
    assert.equal(inputs.length,1);
    for(const value of Object.values(ref))assert.equal(inputs[0]!.includes(value),false,`NLP input leaked ${value}`);
    const observation=store.listCandidateObservations({source_key:'refs-not-nlp'})[0]!;
    assert.equal(observation.redacted_source_text!.includes(ref.evidence_id),false);
    assert.equal(observation.redacted_source_text!.includes(ref.run_id),false);
    const serializedNode=JSON.stringify(store.get(proposal.id));
    assert.equal(serializedNode.includes(ref.evidence_id),false);
    assert.equal(serializedNode.includes(ref.run_id),false);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('MCP edge observations preserve candidates, code-point spans, exact links and retry identity',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-mcp-edge-'));let store:Store|undefined;
  try{
    store=await Store.open(path.join(dir,'memory.sqlite'),'mcp-edge-ledger');
    const a=await writer(store).propose({observation_id:'from',type:'screen',stable_key:'from',display_name:'From'}) as any;
    const b=await writer(store).propose({observation_id:'to',type:'screen',stable_key:'to',display_name:'To'}) as any;
    const learning=writer(store),input={...edgeInput('edge-observation'),from_id:a.id,to_id:b.id};
    const edge=await learning.addEdge(input) as any,repeat=await learning.addEdge(input) as any;
    assert.equal(edge.id,repeat.id);const [observation]=store.listCandidateObservations({source_kind:'mcp_edge'});
    assert.equal(observation!.extraction_ready,true);assert.deepEqual(observation!.links,[{kind:'edge',id:edge.id}]);
    const entities=observation!.entities as any[],relations=observation!.relations as any[];
    assert.equal(entities[0].text,'Button');assert.equal(entities[0].start,Array.from(observation!.redacted_source_text!.slice(0,observation!.redacted_source_text!.indexOf('Button'))).length);
    assert.equal(Array.from(observation!.redacted_source_text!).slice(entities[0].start,entities[0].end).join(''),entities[0].text);
    assert.equal(relations[0].from_candidate_id,entities[0].id);assert.equal(relations[0].to_candidate_id,entities[1].id);assert.equal(relations[0].evidence.text,'opens');
    const semanticRepeat=await learning.addEdge({...input,observation_id:'edge-observation-2'}) as any;
    assert.equal(semanticRepeat.id,edge.id);assert.equal(semanticRepeat.conflict_status,'none');assert.equal(store.listCandidateObservations({source_kind:'mcp_edge'}).length,2);
    const contradiction=await learning.addEdge({...input,observation_id:'edge-observation-conflict',attributes:{description:'🌞 Button closes Checkout'}}) as any;
    assert.notEqual(contradiction.id,edge.id);assert.equal(contradiction.conflict_status,'conflict');assert.equal(store.listCandidateObservations({source_kind:'mcp_edge'}).length,3);
    const conflicts=(store.listEdges() as any[]).filter(row=>row.relation_type==='NAVIGATES_TO');assert.equal(conflicts.length,2);assert(conflicts.every(row=>row.conflict_status==='conflict'));
    await assert.rejects(()=>learning.addEdge({...input,attributes:{description:'Button closes Checkout'}}),/failed safely/);
    assert.equal(store.listCandidateObservations({source_kind:'mcp_edge'}).length,3);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('LearningWriter edge exact replay survives endpoint tombstoning while new or changed commits reject',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-mcp-edge-tombstone-'));let store:Store|undefined;
  try{
    store=await Store.open(path.join(dir,'memory.sqlite'),'mcp-edge-tombstone');
    const a=await writer(store).propose({observation_id:'tombstone-from',type:'screen',stable_key:'tombstone-from',display_name:'From'}) as any;
    const b=await writer(store).propose({observation_id:'tombstone-to',type:'screen',stable_key:'tombstone-to',display_name:'To'}) as any;
    const assertion=store.recordAssertion({session_id:'edge-tombstone-evidence',subject_node_id:a.id,passed:true,observed_count:1});
    const ref={evidence_id:(assertion.evidence as any).id,run_id:assertion.id,subject_node_id:a.id};
    const input={...edgeInput('committed-before-tombstone'),from_id:a.id,to_id:b.id,evidence_refs:[ref]};
    const learning=writer(store),committed=await learning.addEdge(input) as any;
    const native=new Database(path.join(dir,'memory.sqlite'));try{native.prepare('UPDATE nodes SET tombstone=1 WHERE project_id=? AND environment=? AND id=?').run(store.projectId,store.memoryEnvironment,a.id);}finally{native.close();}
    assert.equal((await learning.addEdge(input) as any).id,committed.id,'same persisted identity and refs returns the linked edge without endpoint liveness validation');
    await assert.rejects(()=>learning.addEdge({...input,evidence_refs:[{...ref,subject_node_id:b.id}]}),/failed safely/,'changed refs are rejected');
    await assert.rejects(()=>learning.addEdge({...input,observation_id:'new-after-tombstone'}),/failed safely/,'a new observation still rejects tombstoned endpoints');
    await assert.rejects(()=>writer(store,{rules:'r2'}).addEdge(input),/failed safely/,'a new pipeline revision still rejects tombstoned endpoints');
    assert.equal(store.listCandidateObservations({source_kind:'mcp_edge'}).length,1,'rejected writes do not append observations');
    assert.equal(store.listEdges().length,1,'rejected writes do not mutate graph edges');
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('MCP ingestion fails closed, records empty-pattern readiness, and rolls back graph and ledger together',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-mcp-atomic-'));const filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=await Store.open(filename,'mcp-atomic');const failed=writer(store,{failAnalyze:true});
    await assert.rejects(()=>failed.propose({observation_id:'bad',type:'screen',stable_key:'bad',display_name:'Bad'}));
    assert.equal(store.listCandidateObservations().length,0);assert.equal(store.getByTypeKey('screen','bad'),null);
    const empty=writer(store,{emptyPatterns:true});await empty.propose({observation_id:'empty-rules',type:'screen',stable_key:'empty',display_name:'Empty'});
    const noExtraction=store.listCandidateObservations({source_key:'empty-rules'})[0]!;assert.equal(noExtraction.extraction_ready,false);assert.deepEqual(noExtraction.entities,[]);assert.deepEqual(noExtraction.relations,[]);
    const native=new Database(filename);native.exec("CREATE TRIGGER fail_agent_node BEFORE INSERT ON nodes WHEN NEW.origin='agent' BEGIN SELECT RAISE(ABORT,'forced graph failure'); END");native.close();
    await assert.rejects(()=>empty.propose({observation_id:'rollback',type:'screen',stable_key:'rollback',display_name:'Rollback'}));
    assert.equal(store.listCandidateObservations({source_key:'rollback'}).length,0);assert.equal(store.getByTypeKey('screen','rollback'),null);
    const removeNodeTrigger=new Database(filename);removeNodeTrigger.exec('DROP TRIGGER fail_agent_node');removeNodeTrigger.close();
    const from=await empty.propose({observation_id:'rollback-from',type:'screen',stable_key:'rollback-from',display_name:'From'}) as any;
    const to=await empty.propose({observation_id:'rollback-to',type:'screen',stable_key:'rollback-to',display_name:'To'}) as any;
    const before=store.listEdges().length,nativeEdge=new Database(filename);nativeEdge.exec("CREATE TRIGGER fail_agent_edge BEFORE INSERT ON edges WHEN NEW.origin='agent' BEGIN SELECT RAISE(ABORT,'forced edge failure'); END");nativeEdge.close();
    await assert.rejects(()=>empty.addEdge({observation_id:'edge-rollback',from_id:from.id,to_id:to.id,relation:'NAVIGATES_TO',attributes:{description:'different edge'}}));
    assert.equal(store.listCandidateObservations({source_key:'edge-rollback'}).length,0);assert.equal(store.listEdges().length,before);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('malformed injected candidate output rejects before graph or ledger writes',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-mcp-invalid-nlp-'));let store:Store|undefined;
  try{
    store=await Store.open(path.join(dir,'memory.sqlite'),'mcp-invalid');
    for(const [index,invalidOutput] of (['signature','index','self','label','span'] as const).entries()){
      const learning=writer(store,{invalidOutput});
      await assert.rejects(()=>learning.propose({observation_id:`invalid-${index}`,type:'screen',stable_key:`invalid-${index}`,display_name:'Button',attributes:{description:'Button opens Checkout'}}));
    }
    assert.equal(store.listCandidateObservations().length,0);
    assert.equal((store.db.prepare("SELECT count(*) count FROM nodes WHERE origin='agent'").get() as any).count,0);
    assert.equal((store.listEdges() as any[]).length,0);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('malformed injected health rejects before analysis, ledger, or graph writes',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-mcp-invalid-health-'));let store:Store|undefined;
  try{
    store=await Store.open(path.join(dir,'memory.sqlite'),'mcp-invalid-health');const analysisCalls={value:0};
    const malformed=['idEmpty','idTooLong','ok','op','healthNull','version','protocol','python','spacy','model','modelVersion','rules','schema','digest','countNegative','countOverLimit','countFractional','emptyReady','patternsNotReady','notReady','modelUnavailable','patternsReadyType'];
    for(const [index,malformedHealth] of malformed.entries()){
      await assert.rejects(()=>writer(store!,{malformedHealth,analysisCalls}).propose({observation_id:`bad-health-${index}`,type:'screen',stable_key:`bad-health-${index}`,display_name:'No write'}));
    }
    assert.equal(analysisCalls.value,0);assert.equal(store.listCandidateObservations().length,0);
    assert.equal((store.db.prepare("SELECT count(*) count FROM nodes WHERE origin='agent'").get() as any).count,0);
    const emptyValid=writer(store,{emptyPatterns:true,analysisCalls});
    await emptyValid.propose({observation_id:'empty-valid-rules',type:'screen',stable_key:'empty-valid-rules',display_name:'Normalized only'});
    const observation=store.listCandidateObservations({source_key:'empty-valid-rules'})[0]!;
    assert.equal(observation.extraction_ready,false);assert.equal(analysisCalls.value,1);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('closed graph registry rejects unsupported node types, relations, and endpoint signatures at both boundaries',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-mcp-registry-'));let store:Store|undefined;
  try{
    store=await Store.open(path.join(dir,'memory.sqlite'),'mcp-registry');const learning=writer(store);
    await assert.rejects(()=>learning.propose({observation_id:'unsupported-node',type:'note',stable_key:'n',display_name:'Note'}));
     const from=await learning.propose({observation_id:'screen-a',type:'screen',stable_key:'a',display_name:'A'}) as any;
     const to=await learning.propose({observation_id:'screen-b',type:'screen',stable_key:'b',display_name:'B'}) as any;
     const assertion=store.recordAssertion({session_id:'registry-evidence',subject_node_id:from.id,passed:true,observed_count:1});
     const evidenceRef={evidence_id:(assertion.evidence as any).id,run_id:assertion.id,subject_node_id:from.id};
     await assert.rejects(()=>learning.addEdge({observation_id:'unsupported-relation',from_id:from.id,to_id:to.id,relation:'links'}));
    await assert.rejects(()=>learning.addEdge({observation_id:'bad-signature',from_id:from.id,to_id:to.id,relation:'HAS_ACTION'}));
    const observation={source_kind:'mcp_node' as const,source_key:'boundary-node',source_revision_hash:'a'.repeat(64),pipeline_fingerprint:'b'.repeat(64),nlp_protocol_version:3,python_version:'3.12',spacy_version:'3.8',model_name:'test',model_version:'1',rules_version:'r1',patterns_schema_version:1,patterns_digest:'b'.repeat(64),redaction_policy_fingerprint:'c'.repeat(64),extraction_ready:false,entities:[],relations:[],links:[],status:'proposed' as const};
    assert.throws(()=>storeLearningCommit.mcpNode(store!,{observation,type:'note',stable_key:'bad',display_name:'Bad',attributes:withNlpMetadata({},'normalized')}),/Unsupported memory graph node type/);
     assert.throws(()=>storeLearningCommit.mcpEdge(store!,{observation:{...observation,source_kind:'mcp_edge',source_key:'bad-relation'},evidence_refs:[evidenceRef],from_id:from.id,to_id:to.id,relation:'links',attributes:withNlpMetadata({},'normalized')}),/Unsupported memory graph relation/);
    assert.equal(store.listCandidateObservations().length,2);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
