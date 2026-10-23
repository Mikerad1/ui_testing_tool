import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rename,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/memory/store.js';
import {reconcile} from '../src/knowledge/reconcile.js';
import {runFixtureSql,testWriter} from './helpers/learning.js';

const yaml=(value:unknown)=>JSON.stringify(value);
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'workflow-recall-')),knowledge=path.join(root,'knowledge');await mkdir(knowledge);
  const docs:any[]=[
    {schema_version:1,id:'app',name:'Application',kind:'application',base_url:'http://127.0.0.1:3000',route_patterns:[{screen:'home',path:'/home'},{screen:'login',path:'/login'},{screen:'account',path:'/account'},{screen:'reports',path:'/reports'}]},
    {schema_version:1,id:'home',name:'Home screen',kind:'screen',route:'/home',elements:[{id:'to-login',locator:{by:'test_id',value:'go-login'}}],actions:[{id:'open-login',element:'to-login',effect:{navigates_to:'login'}}]},
    {schema_version:1,id:'login',name:'Login screen',route:'/login',kind:'screen',elements:[{id:'to-account',locator:{by:'test_id',value:'go-account'}}],actions:[{id:'open-account',element:'to-account',effect:{navigates_to:'account'}}]},
    {schema_version:1,id:'account',name:'Account screen',route:'/account',kind:'screen',elements:[{id:'secret-input',locator:{by:'label',value:'PRIVATE_LOCATOR_SENTINEL'}}]},
    {schema_version:1,id:'reports',name:'Reports screen',route:'/reports',kind:'screen',elements:[]},
    {schema_version:1,id:'member',name:'Member role',kind:'role',permissions:['read']},
    {schema_version:1,id:'routes',name:'Route rules',kind:'navigation_rules',rules:[{id:'home-to-reports',from:'screen:home',to:'reports',via:{action:'navigate'}}]},
  ];
  const workflows=[
    {id:'direct-flow',name:'Direct account flow',start_screen:'login',requires:{role:'member',environment:['staging']},steps:[{id:'submit-secret',action:'fill',target:{screen:'login',element:'to-account'},value:'PRIVATE_VALUE_SENTINEL'},{id:'assert-secret',action:'assert',condition:'text',target:{by:'text',value:'PRIVATE_LOCATOR_SENTINEL'},expected:'PRIVATE_EXPECTED_SENTINEL'}]},
    {id:'multi-flow',name:'Account report journey',start_screen:'account',requires:{role:'member'},steps:[{id:'open-account',action:'click',target:{screen:'home',element:'to-login'}},{id:'continue-account',action:'navigate',path:'/account?private=PRIVATE_URL_SENTINEL'}]},
    {id:'reverse-flow',name:'Home reverse flow',start_screen:'home',steps:[{id:'open-home',action:'wait',condition:'url',target:'/home'}]},
    {id:'unrelated-flow',name:'Unrelated report flow',start_screen:'home',steps:[{id:'read-reports',action:'click',target:{by:'label',value:'PRIVATE_LOCATOR_SENTINEL'}}]},
    {id:'other-flow',name:'Account authentication alternative',start_screen:'account',requires:{environment:['production']},steps:[{id:'check-account',action:'assert',condition:'visible',target:{screen:'account',element:'secret-input'}}]},
    {id:'prefixed-role-flow',name:'Prefixed role account workflow',start_screen:'account',requires:{role:'role:member'},steps:[{id:'prefixed-role-step',action:'wait',condition:'url',target:'/account'}]},
    {id:'rules-flow',name:'Route rules reports workflow',start_screen:'reports',steps:[{id:'route-rules-step',action:'navigate',path:'/reports'}]},
  ];
  for(const [index,doc] of [...docs,...workflows.map(w=>({schema_version:1,kind:'workflow',...w}))].entries())await writeFile(path.join(knowledge,`${String(index).padStart(2,'0')}.yaml`),yaml(doc));
  const databaseFilename=path.join(root,'memory.sqlite'),store=new Store(databaseFilename,'recall-project');await reconcile(knowledge, store, testWriter(store));
  const close=()=>{store.close();return rm(root,{recursive:true,force:true});};
  return{root,knowledge,databaseFilename,store,workflows,close};
}
test('recall finds direct and directed multi-hop paths but not reverse-only/unrelated routes',async()=>{
  const f=await fixture();try{
    const found=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'direct-flow',currentUrl:'http://127.0.0.1:3000/home?secret=private'});
    const byId=new Map(found.map((x:any)=>[x.workflow_id,x]));
    assert.deepEqual(byId.get('direct-flow')?.directed_path?.screen_ids,['home','login']);
    const multi=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'account journey',currentUrl:'http://127.0.0.1:3000/home?secret=private'}).find((x:any)=>x.workflow_id==='multi-flow');assert.ok(multi);assert.deepEqual(multi.directed_path?.screen_ids,['home','login','account']);assert.equal(multi.current_route_pattern,'/home');
    const viaRule=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'route rules reports',currentUrl:'http://127.0.0.1:3000/home'}).find((x:any)=>x.workflow_id==='rules-flow');assert.deepEqual(viaRule?.directed_path?.screen_ids,['home','reports']);
    runFixtureSql(f.databaseFilename,"UPDATE nodes SET verification_status='stale' WHERE project_id=? AND type='workflow'",f.store.projectId);
    const reverseNode=f.store.getByTypeKey('workflow','reverse-flow') as any;runFixtureSql(f.databaseFilename,"UPDATE nodes SET verification_status='proposed' WHERE project_id=? AND id=?",f.store.projectId,reverseNode.id);
    const reverse=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'reverse home',currentUrl:'http://127.0.0.1:3000/login'}).find((x:any)=>x.workflow_id==='reverse-flow');assert.equal(reverse?.directed_path,null);
    const againstRule=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'reverse-flow',currentUrl:'http://127.0.0.1:3000/reports'}).find((x:any)=>x.workflow_id==='reverse-flow');assert.equal(againstRule?.directed_path,null);
    runFixtureSql(f.databaseFilename,"UPDATE nodes SET verification_status='stale' WHERE project_id=? AND type='workflow'",f.store.projectId);
    const unrelatedNode=f.store.getByTypeKey('workflow','unrelated-flow') as any;runFixtureSql(f.databaseFilename,"UPDATE nodes SET verification_status='proposed' WHERE project_id=? AND id=?",f.store.projectId,unrelatedNode.id);
    const unrelated=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'unrelated report',currentUrl:'http://127.0.0.1:3000/reports'}).find((x:any)=>x.workflow_id==='unrelated-flow');assert.equal(unrelated?.directed_path,null);
  }finally{await f.close();}
});
test('role and environment context filters conflicts and labels missing context uncertain',async()=>{
  const f=await fixture();try{
    const filtered=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'account',currentUrl:'http://127.0.0.1:3000/home',role:'member',environment:'staging',limit:3});
    assert.equal(filtered.some((x:any)=>x.workflow_id==='other-flow'),false);
    assert.equal(filtered.find((x:any)=>x.workflow_id==='direct-flow')?.reason_codes.includes('role_match'),true);
    const unknown=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'direct flow',currentUrl:'http://127.0.0.1:3000/home'});
    const direct=unknown.find((x:any)=>x.workflow_id==='direct-flow');assert.ok(direct?.reason_codes.includes('role_context_missing'));assert.ok(direct?.reason_codes.includes('environment_context_missing'));assert.equal(direct?.uncertainty,'high');
    const prefixedContext=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'direct-flow',currentUrl:'http://127.0.0.1:3000/home',role:'role:member',environment:'staging'}).find((x:any)=>x.workflow_id==='direct-flow');assert.ok(prefixedContext);
    const plainContext=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'prefixed-role-flow',currentUrl:'http://127.0.0.1:3000/home',role:'member'}).find((x:any)=>x.workflow_id==='prefixed-role-flow');assert.ok(plainContext);
  }finally{await f.close();}
});
test('safe goal ranking, bounded stable top-three, and recent outcome citations',async()=>{
  const f=await fixture();try{
    const wf=f.store.getByTypeKey('workflow','direct-flow') as any;const run=f.store.createRun('session',wf.id);f.store.addEvidence({run_id:run,subject_node_id:wf.id,kind:'workflow',outcome:'passed'});f.store.finishRun(run,'passed');
    const result=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'direct submit account',currentUrl:'http://127.0.0.1:3000/login',limit:99});
    assert.equal(result.length,3);assert.equal(result[0].workflow_id,'direct-flow');assert.equal(result[0].outcome_counts.passed,1);assert.equal(result[0].citations[0].run_id,run);assert.ok(result[0].citations[0].evidence_id);
    assert.equal(result[0].uncertainty,'high');
    const again=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'direct submit account',currentUrl:'http://127.0.0.1:3000/login',limit:99});assert.deepEqual(result.map((x:any)=>x.workflow_id),again.map((x:any)=>x.workflow_id));
  }finally{await f.close();}
});
test('recall filters backend provenance in SQL before the recent-run limit',async()=>{
 const f=await fixture();try{
  const workflow=f.store.getByTypeKey('workflow','direct-flow') as any;
  const browser=f.store.createRun('browser',workflow.id,{});f.store.addEvidence({run_id:browser,subject_node_id:workflow.id,kind:'workflow',outcome:'passed'});f.store.finishRun(browser,'passed');
  runFixtureSql(f.databaseFilename,'UPDATE runs SET created_at=?,finished_at=? WHERE project_id=? AND id=?','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z',f.store.projectId,browser);
  for(let index=0;index<25;index++){
   const run=f.store.createRun(`tauri-${index}`,workflow.id,{backend:'tauri'});f.store.addEvidence({run_id:run,subject_node_id:workflow.id,kind:'workflow',outcome:'passed'});f.store.finishRun(run,'passed');
   const date=new Date(Date.UTC(2025,0,1,0,0,index)).toISOString();runFixtureSql(f.databaseFilename,'UPDATE runs SET created_at=?,finished_at=? WHERE project_id=? AND id=?',date,date,f.store.projectId,run);
  }
  for(const [label,raw] of [['unknown','{"backend":"future"}'],['malformed','{bad'],['scalar','3'],['array','[]']] as const){const run=f.store.createRun(label,workflow.id,{});f.store.addEvidence({run_id:run,subject_node_id:workflow.id,kind:'workflow',outcome:'failed'});f.store.finishRun(run,'failed');runFixtureSql(f.databaseFilename,'UPDATE runs SET environment_json=?,created_at=?,finished_at=? WHERE project_id=? AND id=?',raw,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',f.store.projectId,run);}
  const candidate=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'direct-flow',currentUrl:'http://127.0.0.1:3000/login'}).find((item:any)=>item.workflow_id==='direct-flow');assert.ok(candidate);assert.equal(candidate.outcome_counts.passed,1);assert.equal(candidate.outcome_counts.failed,0);assert.equal(candidate.citations.length,1);assert.equal(candidate.citations[0].run_id,browser);
 }finally{await f.close();}
});
test('low uncertainty requires verified success and current-screen path evidence',async()=>{
  const f=await fixture();try{
    const workflow=f.store.getByTypeKey('workflow','direct-flow') as any,run=f.store.createRun('session',workflow.id);
    f.store.addEvidence({run_id:run,subject_node_id:workflow.id,kind:'workflow',outcome:'passed'});f.store.finishRun(run,'passed');
    runFixtureSql(f.databaseFilename,"UPDATE nodes SET verification_status='verified' WHERE project_id=? AND id=?",f.store.projectId,workflow.id);
    const direct=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'direct-flow',currentUrl:'http://127.0.0.1:3000/login',role:'member',environment:'staging'}).find((x:any)=>x.workflow_id==='direct-flow');assert.equal(direct?.uncertainty,'low');
    const disconnected=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'direct-flow',currentUrl:'http://127.0.0.1:3000/reports',role:'member',environment:'staging'}).find((x:any)=>x.workflow_id==='direct-flow');assert.equal(disconnected?.uncertainty,'high');
  }finally{await f.close();}
});
test('recall output is project-scoped and excludes secret payloads and raw current URL',async()=>{
  const f=await fixture();try{
    const serialized=JSON.stringify(f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'PRIVATE_VALUE_SENTINEL',currentUrl:'http://127.0.0.1:3000/home?secret=PRIVATE_URL_SENTINEL'}));
    for(const secret of ['PRIVATE_VALUE_SENTINEL','PRIVATE_EXPECTED_SENTINEL','PRIVATE_LOCATOR_SENTINEL','PRIVATE_URL_SENTINEL'])assert.equal(serialized.includes(secret),false);
    assert.equal(serialized.includes('PRIVATE_URL_SENTINEL'),false);
    const other=new Store(path.join(f.root,'memory.sqlite'),'another-project');try{await reconcile(f.knowledge, other, testWriter(other));assert.notEqual(other.recallWorkflowCandidates({trustYamlSeeds:true,goal:'account',currentUrl:'http://127.0.0.1:3000/home'}).length,0);assert.equal(other.recallWorkflowCandidates({trustYamlSeeds:true,goal:'direct submit account',currentUrl:'http://127.0.0.1:3000/login'})[0].outcome_counts.passed,0);}finally{other.close();}
  }finally{await f.close();}
});
test('candidate provenance is a marker and never exposes the YAML source path',async()=>{
  const f=await fixture();try{
    await rename(path.join(f.knowledge,'07.yaml'),path.join(f.knowledge,'UNIQUE_SOURCE_PATH_SENTINEL.yaml'));await reconcile(f.knowledge, f.store, testWriter(f.store));
    const result=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'direct-flow',currentUrl:'http://127.0.0.1:3000/login'});const serialized=JSON.stringify(result);
    assert.equal(result[0]?.source,'yaml');assert.equal(serialized.includes('source_path'),false);assert.equal(serialized.includes('UNIQUE_SOURCE_PATH_SENTINEL'),false);
  }finally{await f.close();}
});
test('uncertainty is low only for verified workflows with successful runs and known required context',async()=>{
  const f=await fixture();try{
   const workflow=f.store.getByTypeKey('workflow','direct-flow') as any;runFixtureSql(f.databaseFilename,"UPDATE nodes SET verification_status='verified' WHERE project_id=? AND id=?",f.store.projectId,workflow.id);
    const run=f.store.createRun('session','direct-flow');f.store.addEvidence({run_id:run,subject_node_id:workflow.id,kind:'workflow',outcome:'passed'});f.store.finishRun(run,'passed');
    const result=f.store.recallWorkflowCandidates({trustYamlSeeds:true,goal:'direct-flow',currentUrl:'http://127.0.0.1:3000/login',role:'role:member',environment:'staging'}).find((x:any)=>x.workflow_id==='direct-flow');assert.equal(result?.uncertainty,'low');
  }finally{await f.close();}
});
