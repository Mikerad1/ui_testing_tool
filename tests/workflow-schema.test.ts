import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseWorkflowDocument,resolveWorkflowVariables,workflowSchema,type WorkflowStep} from '../src/workflow/contract.js';
import {validateKnowledge} from '../src/knowledge/reconcile.js';

const valid={schema_version:1,kind:'workflow',id:'login',name:'Login flow',start_screen:'login',end_screen:'home',requires:{role:'member',environment:['local']},variables:{USERNAME:{from_env:'APP_USER'},PASSWORD:{from_env:'APP_PASSWORD'}},preconditions:[{condition:'visible',target:{screen:'login',element:'username'}}],steps:[{id:'open-login',action:'navigate',path:'/login'},{id:'enter-user',action:'fill',target:{screen:'login',element:'username'},value:'${{ variables.USERNAME }}'},{id:'enter-password',action:'fill',target:{screen:'login',element:'password'},value:'${{ variables.PASSWORD }}'},{id:'submit',action:'click',target:{by:'role',role:'button',name:'Sign in'}},{id:'loaded',action:'wait',condition:'visible',target:{screen:'home',element:'welcome'},timeout_ms:5000,max_attempts:2},{id:'check-home',action:'assert',condition:'text',target:{screen:'home',element:'welcome'},expected:'Welcome'}],on_failure:{capture:['snapshot','screenshot','console_errors']}};
const validDoc=()=>structuredClone(valid);
const rejects=(doc:unknown)=>assert.equal(workflowSchema.safeParse(doc).success,false);
test('accepts a strict login workflow and resolves declared env values only for caller',()=>{
  const workflow=parseWorkflowDocument(validDoc());assert.equal(workflow.steps.length,6);assert.equal(workflow.variables?.USERNAME?.sensitive,true);
  const values=resolveWorkflowVariables(workflow,{APP_USER:'local-user',APP_PASSWORD:'local-password'});assert.deepEqual(values,{USERNAME:'local-user',PASSWORD:'local-password'});
});
test('accepts PRD-style prefixed screen and role references',()=>{const doc=validDoc() as any;doc.start_screen='screen:login';doc.end_screen='screen:home';doc.requires.role='role:member';doc.steps[1].target.screen='screen:login';assert.equal(workflowSchema.safeParse(doc).success,true);});
test('rejects invalid action discriminants, irrelevant fields, IDs, and missing action fields',()=>{
  for(const mutate of [
    (x:any)=>x.steps[0].action='launch',
    (x:any)=>x.steps[0].unknown=true,
    (x:any)=>x.steps[0].id='../bad',
    (x:any)=>x.steps[0].path=undefined,
    (x:any)=>x.steps[1].value=undefined,
    (x:any)=>x.steps[1].id=x.steps[0].id,
    (x:any)=>x.steps[0].path='https://example.invalid/',
    (x:any)=>x.steps[4].retries=4,
    (x:any)=>x.steps[1].retries=2,
    (x:any)=>x.on_failure.stop=false,
    (x:any)=>x.steps[4].timeout_ms=30001,
  ]){const doc=validDoc();mutate(doc);rejects(doc);}
});
test('accepts only whole-field declared variable references and static environment names',()=>{
  const ok=validDoc();(ok as any).steps[1].value='${{ variables.USERNAME }}';assert.equal(workflowSchema.safeParse(ok).success,true);
  for(const value of ['prefix-${{ variables.USERNAME }}','${{ variables.MISSING }}','${{ variables.USERNAME + "x" }}']){const doc=validDoc();(doc as any).steps[1].value=value;rejects(doc);}
  const doc=validDoc();(doc as any).variables.EXTRA={from_env:'not-valid'};rejects(doc);
});
test('preflight missing environment errors identify only the variable name',()=>{
  const workflow=parseWorkflowDocument(validDoc());const secret='do-not-leak-this-value';
  assert.throws(()=>resolveWorkflowVariables(workflow,{APP_USER:secret}),error=>{assert.match((error as Error).message,/APP_PASSWORD/);assert.equal((error as Error).message.includes(secret),false);return true;});
});
test('assertion field shapes and bounded workflow size are enforced',()=>{
  const doc=validDoc();(doc as any).steps[5]={id:'assert-url',action:'assert',condition:'url_matches',target:{by:'text',value:'forbidden'}};rejects(doc);
  const extra=validDoc();(extra as any).steps[5].value='undeclared-payload';rejects(extra);
  const unknown=validDoc();(unknown as any).steps[5].condition='unknown';rejects(unknown);
  const tooMany=validDoc();(tooMany as any).steps=Array.from({length:101},(_,i)=>({id:`step-${i}`,action:'click',target:{by:'test_id',value:'x'}}));rejects(tooMany);
});
test('wait max_attempts means total attempts and agrees with the exported step type',()=>{
  const doc=validDoc() as any;doc.steps=[{id:'wait-once',action:'wait',condition:'url',target:'/ready'}];
  const parsed=parseWorkflowDocument(doc);assert.equal((parsed.steps[0] as any).max_attempts,undefined);
  doc.steps[0].max_attempts=2;assert.equal(workflowSchema.safeParse(doc).success,true);
  doc.steps[0].max_attempts=3;assert.equal(workflowSchema.safeParse(doc).success,true);
  doc.steps[0].max_attempts=1;rejects(doc);
  const wait:WorkflowStep={id:'wait',action:'wait',condition:'url',target:'/ready',max_attempts:3};
  const navigate:WorkflowStep={id:'go',action:'navigate',path:'/next'};
  void wait;void navigate;
  // @ts-expect-error navigate has no retries
  const invalidNavigate:WorkflowStep={id:'go',action:'navigate',path:'/next',retries:2};
  // @ts-expect-error wait uses max_attempts, not value
  const invalidWait:WorkflowStep={id:'wait',action:'wait',condition:'url',target:'/ready',value:2};
  void invalidNavigate;void invalidWait;
});
test('retries are rejected on navigate, assert, and fill',()=>{
  for(const step of [{id:'nav',action:'navigate',path:'/login',retries:2},{id:'check',action:'assert',condition:'visible',target:{by:'test_id',value:'x'},retries:2},{id:'fill',action:'fill',target:{by:'test_id',value:'x'},value:'ok',retries:2}]){
    const doc=validDoc() as any;doc.steps=[step];rejects(doc);
  }
});
test('variable references are allowed only in payload fields and assertion expected fields',()=>{
  const allowed=validDoc() as any;allowed.steps=[{id:'fill',action:'fill',target:{by:'test_id',value:'username'},value:'${{ variables.USERNAME }}'},{id:'check',action:'assert',condition:'text',target:{by:'test_id',value:'message'},expected:'${{ variables.PASSWORD }}'}];
  assert.equal(workflowSchema.safeParse(allowed).success,true);
  for(const invalid of [
    {id:'fill',action:'fill',target:{by:'test_id',value:'${{ variables.USERNAME }}'},value:'x'},
    {id:'nav',action:'navigate',path:'/${{ variables.USERNAME }}'},
    {id:'assert',action:'assert',condition:'visible',target:{by:'text',value:'${{ variables.USERNAME }}'}},
  ]){const doc=validDoc() as any;doc.steps=[invalid];rejects(doc);}
});
test('overlong environment values are rejected without exposing their contents',()=>{
  const workflow=parseWorkflowDocument(validDoc());const sentinel='private-sentinel-value'.repeat(500);
  assert.throws(()=>resolveWorkflowVariables(workflow,{APP_USER:'user',APP_PASSWORD:sentinel}),error=>{assert.match((error as Error).message,/exceeds the workflow value limit/);assert.equal((error as Error).message.includes(sentinel),false);return true;});
});
test('reconciliation validation catches unresolved workflow screen, element, and role references',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'workflow-schema-'));
  try{
    await mkdir(root,{recursive:true});
    const base=[{schema_version:1,id:'login',name:'Login',kind:'screen',elements:[{id:'user',locator:{by:'test_id',value:'user'}}]},{schema_version:1,id:'member',name:'Member',kind:'role'}];
    const write=async(extra:unknown[])=>{for(const name of ['screen.yaml','role.yaml','workflow.yaml'])await rm(path.join(root,name),{force:true});const docs=[...base,...extra];for(let i=0;i<docs.length;i++)await writeFile(path.join(root,['screen.yaml','role.yaml','workflow.yaml'][i]!),JSON.stringify(docs[i]));};
    const workflow=validDoc() as any;workflow.start_screen='missing-screen';workflow.steps=[{id:'click',action:'click',target:{screen:'login',element:'user'}}];await write([workflow]);await assert.rejects(()=>validateKnowledge(root));
    workflow.start_screen='login';workflow.requires.role='missing-role';await write([workflow]);await assert.rejects(()=>validateKnowledge(root));
    workflow.requires.role='member';workflow.steps[0].target.element='missing-element';await write([workflow]);await assert.rejects(()=>validateKnowledge(root));
  }finally{await rm(root,{recursive:true,force:true});}
});
