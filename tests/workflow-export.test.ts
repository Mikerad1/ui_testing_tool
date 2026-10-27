import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import Database from 'better-sqlite3';
import {Store,CURRENT_SCHEMA_VERSION} from '../src/memory/store.js';
import {reconcile} from '../src/knowledge/reconcile.js';
import {runFixtureSql,testWriter} from './helpers/learning.js';
import {generateWorkflowSpec,writeWorkflowSpec} from '../src/workflow/export.js';
import {runWorkflow} from '../src/workflow/runner.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const token='EXPORT_SECRET_SENTINEL_MUST_NOT_BE_EMBEDDED';
const source=(workflowName='Review flow')=>`schema_version: 1
kind: workflow
id: review-flow
name: ${workflowName}
start_screen: home
variables:
  INPUT_VALUE:
    from_env: UMB_EXPORT_INPUT
    sensitive: true
steps:
  - id: navigate
    action: navigate
    path: /start
    timeout_ms: 15000
  - id: wait-hidden-before-appearance
    action: wait
    condition: hidden
    target: {screen: home, element: absent}
  - id: wait-delayed
    action: wait
    condition: visible
    target: {screen: home, element: delayed}
    timeout_ms: 500
    max_attempts: 3
  - id: fill
    action: fill
    target: {screen: home, element: input}
    value: '\${{ variables.INPUT_VALUE }}'
  - id: click
    action: click
    timeout_ms: 2200
    target: {screen: home, element: submit}
  - id: check
    action: assert
    timeout_ms: 2500
    condition: text
    target: {screen: home, element: result}
    expected: Done
`;
async function setup(){
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-workflow-export-')),knowledge=path.join(root,'knowledge');await mkdir(knowledge);
  await writeFile(path.join(knowledge,'home.yaml'),`schema_version: 1
kind: screen
id: home
name: Home
elements:
  - id: input
    locator: {by: test_id, value: input}
  - id: submit
    locator: {by: test_id, value: submit}
  - id: result
    locator: {by: test_id, value: result}
  - id: delayed
    locator: {by: test_id, value: delayed}
  - id: absent
    locator: {by: test_id, value: absent}
`);
  await writeFile(path.join(knowledge,'app.yaml'),`schema_version: 1
kind: application
id: export-app
name: Export App
route_patterns:
  - {screen: home, path: /start}
`);
  await writeFile(path.join(knowledge,'workflow.yaml'),source());
  const databaseFilename=path.join(root,'memory.sqlite'),store=new Store(databaseFilename,'export-project');await reconcile(knowledge, store, testWriter(store));
  const workflow=store.getByTypeKey('workflow','review-flow') as any;
  return{root,knowledge,databaseFilename,store,workflow};
}
function addRun(store:Store,node:any,status:'passed'|'failed'='passed',hash=store.workflowSnapshotHash(JSON.parse(node.attributes_json).id),workflowId=node.id,environment:unknown={}){
 const run=store.createRun('test-session',workflowId,environment,hash);store.addEvidence({run_id:run,subject_node_id:node.id,kind:'workflow',outcome:status,metadata:{}});store.finishRun(run,status);return run;
}
function waitForChild(child:ReturnType<typeof spawn>,label:string,timeoutMs=120_000){
 let stdout='',stderr='',timedOut=false;
 child.stdout?.on('data',chunk=>{stdout+=chunk.toString();});child.stderr?.on('data',chunk=>{stderr+=chunk.toString();});
 return new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
  let escalation:NodeJS.Timeout|undefined;
  const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');escalation=setTimeout(()=>child.kill('SIGKILL'),2000);},timeoutMs);
  child.once('close',code=>{clearTimeout(timeout);if(escalation)clearTimeout(escalation);if(timedOut)reject(new Error(`${label} timed out after ${timeoutMs}ms: ${stdout}\n${stderr}`));else resolve({code,stdout,stderr});});
 });
}

test('v9 to v10 migration preserves run/evidence and rolls back failed additive migration',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-v10-migration-')),file=path.join(root,'db.sqlite');let store:Store|undefined;
 try{
  store=new Store(file,'migration');const subject=store.applicationSubject()!.id;const run=store.createRun('legacy','legacy-workflow');store.addEvidence({run_id:run,subject_node_id:subject,kind:'workflow',outcome:'passed'});store.finishRun(run,'passed');store.close();store=undefined;
        let db=new Database(file);db.exec('DROP TABLE desktop_finding_events; DROP TABLE desktop_comparison_findings; DROP TABLE desktop_visual_comparisons; DROP TABLE desktop_visual_findings; DROP TABLE desktop_baseline_revisions; DROP INDEX memory_audit_verify_subject_latest; DROP INDEX evidence_assertion_provenance_lookup; DROP INDEX memory_search_edges_from_bounded; DROP INDEX memory_search_edges_to_bounded; DROP TABLE memory_candidate_evidence_refs; DROP TABLE memory_lifecycle_events; DROP TABLE memory_candidate_observations; DROP TABLE memory_backfill_items; DROP TABLE memory_backfill_jobs; DROP TABLE yaml_record_fingerprints; DROP TABLE workflow_export_verifications; ALTER TABLE runs DROP COLUMN workflow_snapshot_hash; ALTER TABLE runs DROP COLUMN memory_environment; DELETE FROM schema_migrations WHERE version>=10');db.close();
      store=await Store.open(file,'migration');assert.equal(CURRENT_SCHEMA_VERSION,19);assert.equal((store.db.prepare('SELECT status FROM runs WHERE id=?').get(run) as any).status,'passed');assert.equal((store.db.prepare('SELECT count(*) count FROM evidence WHERE run_id=?').get(run) as any).count,1);assert.deepEqual(store.db.pragma('foreign_key_check'),[]);store.close();store=undefined;
        db=new Database(file);db.exec("CREATE TRIGGER fail_v10 BEFORE INSERT ON schema_migrations WHEN NEW.version=10 BEGIN SELECT RAISE(ABORT,'forced migration failure'); END;");db.exec('DROP TABLE desktop_finding_events; DROP TABLE desktop_comparison_findings; DROP TABLE desktop_visual_comparisons; DROP TABLE desktop_visual_findings; DROP TABLE desktop_baseline_revisions; DROP INDEX memory_audit_verify_subject_latest; DROP INDEX evidence_assertion_provenance_lookup; DROP INDEX memory_search_edges_from_bounded; DROP INDEX memory_search_edges_to_bounded; DROP TABLE memory_candidate_evidence_refs; DROP TABLE memory_lifecycle_events; DROP TABLE memory_candidate_observations; DROP TABLE memory_backfill_items; DROP TABLE memory_backfill_jobs; DROP TABLE yaml_record_fingerprints; DROP TABLE workflow_export_verifications; ALTER TABLE runs DROP COLUMN workflow_snapshot_hash; ALTER TABLE runs DROP COLUMN memory_environment; DELETE FROM schema_migrations WHERE version>=10');db.close();
   await assert.rejects(Store.open(file,'migration'),/forced migration failure/);db=new Database(file);assert.equal((db.prepare('SELECT count(*) count FROM pragma_table_info(\'runs\') WHERE name=\'workflow_snapshot_hash\'').get() as any).count,0);assert.equal((db.prepare('SELECT count(*) count FROM pragma_table_info(\'runs\') WHERE name=\'memory_environment\'').get() as any).count,0);assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_export_verifications'").get(),undefined);assert.equal((db.prepare('SELECT max(version) version FROM schema_migrations').get() as any).version,9);assert.equal((db.prepare('SELECT count(*) count FROM evidence WHERE run_id=?').get(run) as any).count,1);db.close();
 }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('workflow export verification requires current successful matching evidence and expires on source change',async()=>{
 const f=await setup();let other:Store|undefined;
 try{
  assert.equal(f.store.hasWorkflowExportVerification('review-flow'),false);
  assert.throws(()=>generateWorkflowSpec(f.store,'review-flow','http://127.0.0.1:3000'),/verification/);
  const failed=addRun(f.store,f.workflow,'failed');assert.equal(f.store.verifyWorkflowExport('review-flow',failed),false);
  const badHash=addRun(f.store,f.workflow,'passed','f'.repeat(64));assert.equal(f.store.verifyWorkflowExport('review-flow',badHash),false);
  const wrongWorkflow=addRun(f.store,f.workflow,'passed',f.workflow.content_hash,'not-the-workflow-node');assert.equal(f.store.verifyWorkflowExport('review-flow',wrongWorkflow),false);
   const noEvidence=f.store.createRun('session',f.workflow.id,{},f.store.workflowSnapshotHash('review-flow')!);f.store.finishRun(noEvidence,'passed');assert.equal(f.store.verifyWorkflowExport('review-flow',noEvidence),false);
  other=new Store(path.join(f.root,'memory.sqlite'),'another-project');await reconcile(f.knowledge, other, testWriter(other));const foreignNode=other.getByTypeKey('workflow','review-flow') as any,foreignRun=addRun(other,foreignNode);assert.equal(f.store.verifyWorkflowExport('review-flow',foreignRun),false);assert.equal(other.verifyWorkflowExport('review-flow',addRun(f.store,f.workflow)),false);
    const run=addRun(f.store,f.workflow);assert.equal(f.store.verifyWorkflowExport('review-flow',run),true);assert.equal(f.store.hasWorkflowExportVerification('review-flow'),true);f.store.finishRun(run,'failed');assert.equal(f.store.hasWorkflowExportVerification('review-flow'),false,'verification must stop qualifying if its evidence run is no longer passed');const replacement=addRun(f.store,f.workflow);assert.equal(f.store.verifyWorkflowExport('review-flow',replacement),true);assert.equal(f.store.hasWorkflowExportVerification('review-flow'),true);runFixtureSql(f.databaseFilename,"DELETE FROM evidence WHERE project_id=? AND run_id=? AND kind='workflow' AND outcome='passed'",f.store.projectId,replacement);assert.equal(f.store.hasWorkflowExportVerification('review-flow'),false,'verification must stop qualifying if passed workflow evidence is missing');
  await writeFile(path.join(f.knowledge,'workflow.yaml'),source('Edited flow'));await reconcile(f.knowledge, f.store, testWriter(f.store));assert.equal(f.store.hasWorkflowExportVerification('review-flow'),false);
 }finally{other?.close();f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('workflow export eligibility and stored verification fail closed on backend provenance',async()=>{
 const f=await setup();try{
  for(const [label,environment,eligible] of [
   ['legacy',{},true],['browser',{backend:'browser'},true],['tauri',{backend:'tauri'},false],['unknown',{backend:'other'},false],['malformed','{bad',false],['scalar','42',false],['array','[]',false],
  ] as Array<[string,unknown,boolean]>){
   const run=addRun(f.store,f.workflow,'passed',undefined,undefined,label==='malformed'?{}:environment);if(label==='malformed')runFixtureSql(f.databaseFilename,'UPDATE runs SET environment_json=? WHERE project_id=? AND id=?','{bad',f.store.projectId,run);assert.equal(f.store.workflowExportEligibility('review-flow',run)!==null,eligible,label);
   assert.equal(f.store.verifyWorkflowExport('review-flow',run),eligible,label);
   if(eligible){assert.equal(f.store.hasWorkflowExportVerification('review-flow'),true);runFixtureSql(f.databaseFilename,'UPDATE runs SET environment_json=? WHERE project_id=? AND id=?',JSON.stringify({backend:'tauri'}),f.store.projectId,run);assert.equal(f.store.hasWorkflowExportVerification('review-flow'),false,'verification must be revoked when its run becomes Tauri');}
  }
 }finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('screen locator YAML edits invalidate snapshot-bound export verification until a new run is verified',async()=>{
 const f=await setup();try{
  const originalHash=f.store.workflowSnapshotHash('review-flow');assert.match(originalHash,/^[a-f0-9]{64}$/);const run=addRun(f.store,f.workflow);assert.equal((f.store.db.prepare('SELECT workflow_snapshot_hash FROM runs WHERE project_id=? AND id=?').get(f.store.projectId,run) as any).workflow_snapshot_hash,originalHash);assert.equal(f.store.verifyWorkflowExport('review-flow',run),true);
  const screenPath=path.join(f.knowledge,'home.yaml');await writeFile(screenPath,(await readFile(screenPath,'utf8')).replace('value: input','value: updated-input'));await reconcile(f.knowledge, f.store, testWriter(f.store));
  const updatedHash=f.store.workflowSnapshotHash('review-flow');assert.notEqual(updatedHash,originalHash);assert.equal(f.store.hasWorkflowExportVerification('review-flow'),false);assert.throws(()=>generateWorkflowSpec(f.store,'review-flow','http://127.0.0.1:3000'),/verification/);
  const node=f.store.getByTypeKey('workflow','review-flow') as any,newRun=addRun(f.store,node);assert.equal((f.store.db.prepare('SELECT workflow_snapshot_hash FROM runs WHERE project_id=? AND id=?').get(f.store.projectId,newRun) as any).workflow_snapshot_hash,updatedHash);assert.equal(f.store.verifyWorkflowExport('review-flow',newRun),true);assert.equal(f.store.hasWorkflowExportVerification('review-flow'),true);
 }finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('export uses the effective prior locator while its proposal is inactive',async()=>{
 const f=await setup();try{
  const wf=f.store.getByTypeKey('workflow','review-flow') as any,screen=f.store.getByTypeKey('screen','home') as any,element=f.store.getByTypeKey('ui_element','screen:home/input') as any,run=addRun(f.store,wf);assert.equal(f.store.verifyWorkflowExport('review-flow',run),true);
   const now=new Date().toISOString();runFixtureSql(f.databaseFilename,`INSERT INTO workflow_locator_proposals(id,project_id,run_id,workflow_node_id,workflow_id,step_id,screen_id,element_id,screen_node_id,element_node_id,source_path,source_hash,baseline_hash,previous_locator_json,fallback_history_json,candidate_locator_json,reason_code,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,'inactive-export',f.store.projectId,run,wf.id,'review-flow','fill','home','input',screen.id,element.id,'home.yaml','a'.repeat(64),'b'.repeat(64),JSON.stringify({by:'css',value:'#legacy-input'}),'[]',JSON.stringify({by:'test_id',value:'input'}),'target_invalid','pending',now,now);
  const generated=generateWorkflowSpec(f.store,'review-flow','http://127.0.0.1:3000');assert.match(generated,/page\.locator\("#legacy-input"\)\.fill/);assert.doesNotMatch(generated,/page\.getByTestId\("input"\)\.fill/);
 }finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('runWorkflow records the active YAML snapshot hash on its run',async()=>{
 const node={id:'workflow-node',origin:'yaml',content_hash:'a'.repeat(64),attributes_json:JSON.stringify({schema_version:1,kind:'workflow',id:'one',name:'One',steps:[{id:'scroll',action:'scroll',direction:'down',amount:10}]})},snapshot='b'.repeat(64);let args:any;
 const store:any={getByTypeKey:()=>node,workflowSnapshotHash:()=>snapshot,createRun:(...values:any[])=>{args=values;return'run-id';},createWorkflowStepAttempt:()=>{},finishWorkflowStepAttempt:()=>{},addEvidence:()=>{},finishRun:()=>{},getRunReport:()=>({stepAttempts:[]})};
 const browser:any={revision:7,setActionTimeout:()=>{},consoleErrorCount:()=>0,scroll:async()=>{},page:{url:()=> 'http://127.0.0.1/'}};
 const result=await runWorkflow({store,browser,session:{id:'session',closed:false},workflowId:'one',expectedRevision:7,authorize:async()=>undefined});assert.equal(result.status,'passed');assert.equal(args[1],node.id);assert.equal(args[3],snapshot);
});

test('verified workflow exports deterministic env-safe standalone source that passes local fixture',async()=>{
  const f=await setup();const app=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<input data-testid="input"><button data-testid="submit" onclick="document.querySelector(\'[data-testid=result]\').textContent=\'Done\'">Go</button><p data-testid="result"></p><script>setTimeout(()=>{const e=document.createElement(\'i\');e.setAttribute(\'data-testid\',\'delayed\');e.textContent=\'ready\';document.body.append(e)},100)</script>');});app.listen(0,'127.0.0.1');await once(app,'listening');const port=(app.address() as any).port;
 const scriptRoot=await mkdtemp(path.join(repo,'.workflow-export-test-'));let generatedChild:ReturnType<typeof spawn>|undefined;
 try{
  const run=addRun(f.store,f.workflow);assert.equal(f.store.verifyWorkflowExport('review-flow',run),true);
       const first=generateWorkflowSpec(f.store,'review-flow',`http://127.0.0.1:${port}`),second=generateWorkflowSpec(f.store,'review-flow',`http://127.0.0.1:${port}`);assert.equal(first,second);assert.equal(first.includes(token),false);assert.match(first,/UMB_PLAYWRIGHT_ENGINE/);assert.match(first,/Unsupported UMB_PLAYWRIGHT_ENGINE/);assert.match(first,/requiredEnv\("UMB_EXPORT_INPUT"\)/);assert.match(first,/timeout:\s*15000/,'navigation timeout is retained');assert.match(first,/timeout:\s*2200/,'click timeout is retained');assert.ok(first.includes('assertText(page.getByTestId("result"), "Done", false, 2500)'),'assert timeout and text helper are retained');assert.match(first,/retryWait\(3, async \(\) =>/);assert.match(first,/!isTimeoutError\(error\)/);assert.match(first,/locator\.innerText\(\)/);assert.match(first,/getByTestId\("input"\)/);assert.match(first,/getByTestId\("absent"\)\.waitFor\(\{ state: "hidden"/,'hidden wait does not impose a count precondition');
        process.env.UMB_EXPORT_INPUT=token;const spec=path.join(scriptRoot,'review.spec.ts');await writeFile(spec,first);const childEnvironment={...process.env};delete childEnvironment.NODE_TEST_CONTEXT;const child=generatedChild=spawn(process.execPath,['--import','tsx/esm','--test',spec],{cwd:repo,env:childEnvironment,stdio:['ignore','pipe','pipe']});const generated=await waitForChild(child,'generated spec');assert.equal(generated.code,0,`${generated.stdout}\n${generated.stderr}`);
    const unknownEnvironment={...childEnvironment,UMB_PLAYWRIGHT_ENGINE:'gecko'};const unknown=spawn(process.execPath,['--import','tsx/esm','--test',spec],{cwd:repo,env:unknownEnvironment,stdio:['ignore','pipe','pipe']});const unknownResult=await waitForChild(unknown,'unsupported-engine generated spec');assert.notEqual(unknownResult.code,0);assert.match(unknownResult.stdout+unknownResult.stderr,/Unsupported UMB_PLAYWRIGHT_ENGINE/);
  await writeWorkflowSpec(f.root,'review.spec.ts',first);await assert.rejects(writeWorkflowSpec(f.root,'review.spec.ts',first),/EEXIST/);
  await assert.rejects(writeWorkflowSpec(f.root,'../escape.spec.ts',first),/relative|traversal/);await assert.rejects(writeWorkflowSpec(f.root,path.resolve(f.root,'absolute.spec.ts'),first),/relative|traversal/);
  const outside=await mkdtemp(path.join(os.tmpdir(),'umb-export-outside-'));try{await symlink(outside,path.join(f.root,'linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(writeWorkflowSpec(f.root,'linked/escape.spec.ts',first),/Symlink escapes|Path escapes/);}finally{await rm(outside,{recursive:true,force:true});}
  const original=await readFile(path.join(f.root,'review.spec.ts'),'utf8');assert.equal(original,first);
 }finally{delete process.env.UMB_EXPORT_INPUT;if(generatedChild?.exitCode===null){generatedChild.kill();await once(generatedChild,'exit').catch(()=>{});}await new Promise<void>(resolve=>{app.closeAllConnections();app.close(()=>resolve());});f.store.close();await rm(f.root,{recursive:true,force:true});await rm(scriptRoot,{recursive:true,force:true});}
});

test('generated navigation guard blocks direct foreign links and disallowed redirect hops',async()=>{
 const f=await setup();let foreignRequests=0,allowedRequests=0;
 const foreign=createServer((_req,res)=>{foreignRequests++;res.writeHead(200,{'content-type':'text/html'}).end('foreign');});foreign.listen(0,'127.0.0.1');await once(foreign,'listening');const foreignPort=(foreign.address() as any).port,foreignUrl=`http://127.0.0.1:${foreignPort}/foreign`;
 const allowed=createServer((_req,res)=>{allowedRequests++;res.writeHead(302,{location:foreignUrl}).end();});allowed.listen(0,'127.0.0.1');await once(allowed,'listening');const allowedPort=(allowed.address() as any).port,allowedOrigin=`http://127.0.0.1:${allowedPort}`;
 const app=createServer((req,res)=>{if(req.url==='/worker.js'){res.writeHead(200,{'content-type':'application/javascript'}).end(`self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/sw-trigger')event.respondWith(fetch(${JSON.stringify(foreignUrl)}));});`);return;}res.writeHead(200,{'content-type':'text/html'}).end(`<a target="_blank" data-testid="allowed-link" href="${allowedOrigin}/redirect">redirect</a><a target="_blank" data-testid="foreign-link" href="${foreignUrl}">foreign</a><p data-testid="sw-status">pending</p><script>const swStatus=document.querySelector('[data-testid=sw-status]');navigator.serviceWorker.register('/worker.js').then(()=>Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('service worker did not activate')),700))])).then(()=>swStatus.textContent='registered').catch(()=>swStatus.textContent='blocked')</script>`);});app.listen(0,'127.0.0.1');await once(app,'listening');const appPort=(app.address() as any).port;
 const scriptRoot=await mkdtemp(path.join(repo,'.workflow-origin-export-'));let child:ReturnType<typeof spawn>|undefined;
 try{
   await writeFile(path.join(f.knowledge,'home.yaml'),`schema_version: 1\nkind: screen\nid: home\nname: Home\nelements:\n  - id: input\n    locator: {by: test_id, value: input}\n  - id: submit\n    locator: {by: test_id, value: submit}\n  - id: result\n    locator: {by: test_id, value: result}\n  - id: delayed\n    locator: {by: test_id, value: delayed}\n  - id: allowed-link\n    locator: {by: test_id, value: allowed-link}\n  - id: foreign-link\n    locator: {by: test_id, value: foreign-link}\n  - id: sw-status\n    locator: {by: test_id, value: sw-status}\n`);
   await writeFile(path.join(f.knowledge,'workflow.yaml'),`schema_version: 1\nkind: workflow\nid: review-flow\nname: guarded navigation\nsteps:\n  - id: start\n    action: navigate\n    path: /start\n    timeout_ms: 5000\n  - id: service-worker-blocked\n    action: assert\n    timeout_ms: 3000\n    condition: text\n    target: {screen: home, element: sw-status}\n    expected: blocked\n    match: exact\n  - id: service-worker-fetch-path\n    action: navigate\n    path: /sw-trigger\n    timeout_ms: 5000\n  - id: restore-page\n    action: navigate\n    path: /start\n    timeout_ms: 5000\n  - id: via-allowed-origin\n    action: click\n    timeout_ms: 5000\n    target: {screen: home, element: allowed-link}\n  - id: direct-foreign-link\n    action: click\n    timeout_ms: 5000\n    target: {screen: home, element: foreign-link}\n`);await reconcile(f.knowledge, f.store, testWriter(f.store));
  const node=f.store.getByTypeKey('workflow','review-flow') as any,run=addRun(f.store,node);assert.equal(f.store.verifyWorkflowExport('review-flow',run),true);
  const specSource=generateWorkflowSpec(f.store,'review-flow',`http://127.0.0.1:${appPort}`,[allowedOrigin]);assert.ok(specSource.includes(JSON.stringify([allowedOrigin,`http://127.0.0.1:${appPort}`].sort())),'the configured allowed origin is embedded explicitly');assert.match(specSource,/maxRedirects: 0/);assert.match(specSource,/isNavigationRequest\(\)/);assert.match(specSource,/serviceWorkers: 'block'/);
    const spec=path.join(scriptRoot,'origin-guard.spec.ts');await writeFile(spec,specSource);const childEnvironment={...process.env};delete childEnvironment.NODE_TEST_CONTEXT;child=spawn(process.execPath,['--import','tsx/esm','--test',spec],{cwd:repo,env:childEnvironment,stdio:['ignore','pipe','pipe']});const generated=await waitForChild(child,'origin-guard generated spec');assert.equal(generated.code,0,`${generated.stdout}\n${generated.stderr}`);assert.equal(allowedRequests,1,`allowed redirect endpoint receives exactly its navigation request; spec output=${generated.stdout}\n${generated.stderr}`);assert.equal(foreignRequests,0,'foreign redirect target and direct link are blocked before fetch');
 }finally{if(child?.exitCode===null){child.kill();await once(child,'exit').catch(()=>{});}for(const server of [app,allowed,foreign])await new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});f.store.close();await rm(f.root,{recursive:true,force:true});await rm(scriptRoot,{recursive:true,force:true});}
});

test('export rejects unsupported workflow requirements and unsafe URLs',async()=>{
 const f=await setup();try{const run=addRun(f.store,f.workflow);f.store.verifyWorkflowExport('review-flow',run);await writeFile(path.join(f.knowledge,'role.yaml'),'schema_version: 1\nkind: role\nid: member\nname: Member\n');await writeFile(path.join(f.knowledge,'workflow.yaml'),source().replace('steps:','requires: {role: member}\nsteps:'));await reconcile(f.knowledge, f.store, testWriter(f.store));const changed=f.store.getByTypeKey('workflow','review-flow') as any;f.store.verifyWorkflowExport('review-flow',addRun(f.store,changed));assert.throws(()=>generateWorkflowSpec(f.store,'review-flow','http://127.0.0.1:3000'),/unsupported/);await writeFile(path.join(f.knowledge,'workflow.yaml'),source());await reconcile(f.knowledge, f.store, testWriter(f.store));const restored=f.store.getByTypeKey('workflow','review-flow') as any;f.store.verifyWorkflowExport('review-flow',addRun(f.store,restored));assert.throws(()=>generateWorkflowSpec(f.store,'review-flow','http://user:pass@example.com/?secret=x'),/Unsafe/);}finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('export rejects malformed stored workflow YAML projection',async()=>{
  const f=await setup();try{const node=f.store.getByTypeKey('workflow','review-flow') as any;const run=addRun(f.store,node);assert.equal(f.store.verifyWorkflowExport('review-flow',run),true);runFixtureSql(f.databaseFilename,'UPDATE nodes SET attributes_json=? WHERE project_id=? AND id=?','{malformed',f.store.projectId,node.id);assert.throws(()=>generateWorkflowSpec(f.store,'review-flow','http://127.0.0.1:3000'),/invalid/);}finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('workflow export verification refuses non-TTY confirmation',async()=>{
 const f=await setup();const config=path.join(f.root,'umb.config.yaml');await writeFile(config,`version: 1\nproject:\n  id: export-project\n  name: export-project\n  base_url: http://127.0.0.1:3000\nserver:\n  host: 127.0.0.1\n  port: 7317\n  auth:\n    mode: none\nbrowser:\n  headless: true\n  allowed_origins: [http://127.0.0.1:3000]\nmemory:\n  database: ./memory.sqlite\nknowledge:\n  path: ./knowledge\n`);
 try{const child=spawn(process.execPath,['--import','tsx/esm',path.join(repo,'src/cli/index.ts'),'workflow','verify','review-flow','--run-id','run-example','--config',config],{cwd:repo,stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString();});const exit=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('workflow verify TTY check timed out')),15000);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});assert.notEqual(exit,0);assert.match(stderr,/interactive local TTY/);}finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});
