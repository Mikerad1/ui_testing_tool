#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, safePath } from '../config/config.js';
import { Store } from '../memory/store.js';
import { createLearningWriter } from '../memory/runtime.js';
import { reconcile, validateKnowledge } from '../knowledge/reconcile.js';
import { BrowserController } from '../browser/controller.js';
import { serve } from '../mcp/server.js';
import { acquireProjectLock } from '../security/project-lock.js';
import { runDoctor } from './doctor.js';
import { ShutdownLifecycle } from './lifecycle.js';
import { createInterface } from 'node:readline/promises';
import { confirmWorkflowLocatorProposal } from '../knowledge/locator-proposals.js';
import { startPlaywrightEndpoint } from '../playwright/endpoint.js';
import { generateWorkflowSpec, writeWorkflowSpec } from '../workflow/export.js';
import { stringify } from 'yaml';
import { access, rmdir, unlink } from 'node:fs/promises';
import { checkForUpdate, updateBundle, updateCheckEnabled } from './updater.js';

const cli = new Command().name('umb').description('UI Memory Browser').option('--update','Update an official prebuilt UMB bundle').action(async options => {
 if (!options.update) cli.help();
 try { console.error(await updateBundle()); } catch (error) { console.error(`Update failed safely: ${(error as Error).message}`); process.exitCode = 1; }
}).addHelpText('after', '\nExamples:\n  $ umb init\n  $ umb knowledge validate --json\n  $ umb doctor --json');
cli.command('update').description('Update an official prebuilt UMB bundle from GitHub Releases').action(async () => {
 try { console.error(await updateBundle()); } catch (error) { console.error(`Update failed safely: ${(error as Error).message}`); process.exitCode = 1; }
});
cli.command('init').description('Safely create starter project configuration and knowledge directory').option('--project <id>', 'Project id', 'demo-web').option('--url <url>', 'Application base URL', 'http://127.0.0.1:3000').option('--yes','Skip interactive confirmation').option('--starter-knowledge','Generate sample application.yaml and home.yaml documents').action(async o => {
 try {
  const url=new URL(o.url); if(!/^https?:$/.test(url.protocol)) throw Error('Use an http or https base URL.');
  if(typeof o.project!=='string'||!/^[_\w-]+$/.test(o.project))throw Error('Project id must be nonempty and contain only letters, numbers, underscores, or hyphens.');
  const config=stringify({version:1,project:{id:o.project,name:o.project,base_url:url.href.replace(/\/$/,'')},server:{host:'127.0.0.1',port:7317,auth:{mode:'token',token_env:'UMB_MCP_TOKEN'}},browser:{headless:true,allowed_origins:[url.origin]},artifacts:{directory:'./.umb/artifacts',redact_sensitive:true},memory:{database:'./.umb/memory.sqlite'},knowledge:{path:'./umb-knowledge'}});
  for(const target of ['umb.config.yaml','umb-knowledge']) try{await access(target);throw Error(`${target} already exists; nothing was changed.`);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(!o.yes&&process.stdin.isTTY){const rl=createInterface({input:process.stdin,output:process.stdout});let answer;try{answer=await rl.question(`Create umb.config.yaml and umb-knowledge/ for ${url.origin}? [y/N] `);}finally{rl.close();}if(answer.trim().toLowerCase()!=='y'){console.log('Initialization cancelled; no changes were made.');return;}}
   const generated=['application.yaml','home.yaml'];await mkdir('umb-knowledge');
   try{
    if(o.starterKnowledge){
     await writeFile(path.join('umb-knowledge','application.yaml'),stringify({schema_version:1,kind:'application',id:o.project,name:o.project,base_url:url.href.replace(/\/$/,''),start_screen:'screen:home'}),{flag:'wx'});
     await writeFile(path.join('umb-knowledge','home.yaml'),stringify({schema_version:1,kind:'screen',id:'home',name:'Home',route:'/',landmarks:[],elements:[]}),{flag:'wx'});
    }
    await writeFile('umb.config.yaml',config,{flag:'wx'});
    }catch(e){for(const file of generated)await unlink(path.join('umb-knowledge',file)).catch(()=>{});await rmdir('umb-knowledge').catch(()=>{});throw e;}
   console.log(`Created umb.config.yaml and umb-knowledge/${o.starterKnowledge?' (application.yaml, home.yaml)':''}. Set UMB_MCP_TOKEN before serving.`);
 } catch(e){console.error(`Init failed safely: ${(e as Error).message}`);process.exitCode=1;}
});
cli.command('doctor').description('Read-only diagnostics with remediation guidance').option('--config <path>', 'Config file', 'umb.config.yaml').option('--json','Output machine-readable JSON').action(async o => {
  try { const result = await runDoctor(o.config); if(o.json) console.log(JSON.stringify(result)); else for (const check of result.checks) console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`); if (!result.ok) process.exitCode = 1; }
  catch { if(o.json)console.log(JSON.stringify({ok:false,checks:[{id:'doctor.unexpected-error',name:'unexpected-error',status:'fail',message:'Doctor could not complete.',remediation:'Check the config path and permissions, then retry.'}]})); console.error('Doctor failed safely.'); process.exitCode = 1; }
});
const knowledge=cli.command('knowledge').description('Manage YAML knowledge and local locator proposals');
knowledge.command('proposals').option('--config <path>','Config file','umb.config.yaml').action(async o=>{
 let store:Store|undefined,lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined;
 try{const{config,root}=await loadConfig(o.config);const db=await safePath(root,config.memory.database);lock=await acquireProjectLock(root,config.project.id,config.memory.database);await mkdir(path.dirname(db),{recursive:true});store=new Store(db,config.project.id);for(const proposal of store.listWorkflowLocatorProposals() as any[]){const prior=JSON.stringify(JSON.parse(proposal.previous_locator_json)),candidate=JSON.stringify(JSON.parse(proposal.candidate_locator_json));console.log(`${proposal.id} [${proposal.status}] ${proposal.source_path} :: screen ${proposal.screen_id} / element ${proposal.element_id}`);console.log(`  Prior locator (untrusted YAML source): ${prior}`);console.log(`  Candidate locator (untrusted YAML source): ${candidate}`);console.log(`  Reason: ${proposal.reason_code}`);}}
 catch{console.error('Unable to list locator proposals safely.');process.exitCode=1;}
 finally{store?.close();await lock?.release().catch(()=>{});}
});
knowledge.command('validate').description('Read-only validation of YAML knowledge and references').option('--config <path>','Config file','umb.config.yaml').option('--json','Output machine-readable JSON').action(async o=>{
  try{const{config,root}=await loadConfig(o.config),knowledgeRoot=await safePath(root,config.knowledge.path),count=await validateKnowledge(knowledgeRoot);const result={ok:true,count,diagnostics:[{id:'knowledge.validation',status:'ok',message:`Knowledge validation passed (${count} YAML documents).`,remediation:'No action required.'}]};console.log(o.json?JSON.stringify(result):`Knowledge validation passed (${count} YAML documents).`);}
  catch{const diagnostic={id:'knowledge.validation',status:'fail',message:'Knowledge could not be validated.',remediation:'Check YAML syntax, supported schemas, and referenced IDs; rerun validation.'};const result={ok:false,count:null,diagnostics:[diagnostic]};if(o.json)console.log(JSON.stringify(result));else console.error(`${diagnostic.message} ${diagnostic.remediation}`);process.exitCode=1;}
});
knowledge.command('reload').option('--config <path>','Config file','umb.config.yaml').action(async o=>{
 let store:Store|undefined,learningWriter:ReturnType<typeof createLearningWriter>|undefined,lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined;
 try{const{config,root}=await loadConfig(o.config),knowledgeRoot=await safePath(root,config.knowledge.path),db=await safePath(root,config.memory.database);lock=await acquireProjectLock(root,config.project.id,config.memory.database);await mkdir(path.dirname(db),{recursive:true});store=new Store(db,config.project.id);learningWriter=createLearningWriter(store,config);await reconcile(knowledgeRoot,store,learningWriter);console.log('Knowledge reload completed.');}
 catch(error){console.error(error instanceof Error&&/already locked|lock gate .*busy/i.test(error.message)?'Knowledge reload refused because the project is locked by an active UMB process.':'Knowledge reload failed; the previous valid graph remains active.');process.exitCode=1;}
  finally{await learningWriter?.close();store?.close();await lock?.release().catch(()=>{});}
});
 knowledge.command('confirm-locator <proposalId>').option('--config <path>','Config file','umb.config.yaml').action(async(proposalId,o)=>{
 if(!process.stdin.isTTY||!process.stdout.isTTY){console.error('Locator confirmation requires an interactive local TTY; no changes were made.');process.exitCode=1;return;}
  let store:Store|undefined,learningWriter:ReturnType<typeof createLearningWriter>|undefined,lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined;
  try{const{config,root}=await loadConfig(o.config);const db=await safePath(root,config.memory.database),knowledgeRoot=await safePath(root,config.knowledge.path);lock=await acquireProjectLock(root,config.project.id,config.memory.database);await mkdir(path.dirname(db),{recursive:true});store=new Store(db,config.project.id);learningWriter=createLearningWriter(store,config);const proposal=store.getWorkflowLocatorProposal(proposalId) as any;if(!proposal){console.error('Unknown locator proposal.');process.exitCode=1;return;}if(proposal.status==='accepted'){console.log('Locator proposal is already accepted.');return;}if(proposal.status!=='pending'){console.error(`Proposal is ${proposal.status}; no source change was made.`);process.exitCode=1;return;}console.log(`Confirm locator proposal ${proposal.id}?`);console.log(`Source document: ${proposal.source_path} (screen ${proposal.screen_id}, element ${proposal.element_id})`);console.log(`Prior locator — untrusted YAML source data: ${JSON.stringify(JSON.parse(proposal.previous_locator_json))}`);console.log(`Candidate locator — untrusted YAML source data: ${JSON.stringify(JSON.parse(proposal.candidate_locator_json))}`);console.log('Confirmation does not edit YAML. The source must already contain the candidate as primary and preserve the prior locator in fallback_locators.');const rl=createInterface({input:process.stdin,output:process.stdout});let answer:string;try{answer=await rl.question('Accept and validate/reconcile this manual YAML edit? [y/N] ');}finally{rl.close();}if(answer.trim().toLowerCase()!=='y'){store.setWorkflowLocatorProposalStatus(proposal.id,'rejected');console.log('Proposal rejected; YAML and graph were not changed.');return;}const result=await confirmWorkflowLocatorProposal(store,proposal.id,knowledgeRoot,learningWriter);if(result.status==='accepted')console.log('Locator proposal accepted after knowledge validation and reconciliation.');else{console.error('Proposal source is stale or invalid; it was not accepted.');process.exitCode=1;}}
 catch{console.error('Locator confirmation failed safely.');process.exitCode=1;}
  finally{await learningWriter?.close();store?.close();await lock?.release().catch(()=>{});}
 });
 const workflow=cli.command('workflow').description('Verify and export reviewed workflow specs');
 workflow.command('verify <workflowId>').requiredOption('--run-id <runId>','Successful workflow run id').option('--config <path>','Config file','umb.config.yaml').action(async(workflowId,o)=>{
  if(!process.stdin.isTTY||!process.stdout.isTTY){console.error('Workflow export verification requires an interactive local TTY.');process.exitCode=1;return;}
   let store:Store|undefined,learningWriter:ReturnType<typeof createLearningWriter>|undefined,lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined;
   try{const{config,root}=await loadConfig(o.config);lock=await acquireProjectLock(root,config.project.id,config.memory.database);const db=await safePath(root,config.memory.database);await mkdir(path.dirname(db),{recursive:true});store=new Store(db,config.project.id);learningWriter=createLearningWriter(store,config);await reconcile(await safePath(root,config.knowledge.path),store,learningWriter);
   const eligible=store.workflowExportEligibility(workflowId,o.runId);if(!eligible)throw Error('Workflow/run is not eligible for export verification.');
   console.log(`Verify workflow ${workflowId} from successful run ${o.runId} (source ${eligible.contentHash.slice(0,12)}) for static spec export?`);
   const rl=createInterface({input:process.stdin,output:process.stdout});let answer:string;try{answer=await rl.question('This creates export eligibility only; generated source requires review. [y/N] ');}finally{rl.close();}
   if(answer.trim().toLowerCase()!=='y'){console.error('Workflow export verification declined.');process.exitCode=1;return;}
   if(!store.verifyWorkflowExport(workflowId,o.runId))throw Error('Workflow verification became stale; no verification was recorded.');console.log('Workflow export verification recorded for the current YAML hash.');
   }catch(error){console.error(`Workflow verification failed: ${(error as Error).message}`);process.exitCode=1;}finally{await learningWriter?.close();store?.close();await lock?.release().catch(()=>{});}
 });
 workflow.command('export <workflowId>').requiredOption('--output <relativePath>','New project-relative .spec.ts path').option('--config <path>','Config file','umb.config.yaml').action(async(workflowId,o)=>{
   let store:Store|undefined,learningWriter:ReturnType<typeof createLearningWriter>|undefined,lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined;
   try{const{config,root}=await loadConfig(o.config);lock=await acquireProjectLock(root,config.project.id,config.memory.database);const db=await safePath(root,config.memory.database);await mkdir(path.dirname(db),{recursive:true});store=new Store(db,config.project.id);learningWriter=createLearningWriter(store,config);await reconcile(await safePath(root,config.knowledge.path),store,learningWriter);
   if(!store.hasWorkflowExportVerification(workflowId))throw Error('Workflow has no verification for its current YAML content hash.');
   const relative=o.output as string,source=generateWorkflowSpec(store,workflowId,config.project.base_url,config.browser.allowed_origins);
   await writeWorkflowSpec(root,relative,source);console.log(`Generated ${relative}. Review the static source before running it; no test was executed.`);
   }catch(error){console.error(`Workflow export failed: ${(error as Error).message}`);process.exitCode=1;}finally{await learningWriter?.close();store?.close();await lock?.release().catch(()=>{});}
 });
   cli.command('serve').option('--config <path>', 'Config file', 'umb.config.yaml').option('--watch-knowledge','Watch YAML knowledge and reconcile validated changes').option('--no-update-check','Disable the non-blocking release check').action(async o => {
  let store: Store | undefined, browser: BrowserController | undefined, learningWriter:ReturnType<typeof createLearningWriter>|undefined, stop: (() => Promise<void>) | undefined;
 let lock: Awaited<ReturnType<typeof acquireProjectLock>> | undefined;
  const lifecycle = new ShutdownLifecycle(async () => {
    try { await stop?.(); } finally { try { await learningWriter?.close(); } finally { try { await browser?.close(); } finally { try { store?.close(); } finally { await lock?.release(); } } } }
   });
 const signal = () => { lifecycle.requestStop(); };
 process.on('SIGINT', signal); process.on('SIGTERM', signal);
 try {
   const { config, root } = await loadConfig(o.config);
    if (updateCheckEnabled(o.updateCheck === false)) void checkForUpdate().then(version => { if (version) console.error(`A newer UMB release (${version}) is available. Run "umb update" to update this official bundle.`); }).catch(() => undefined);
   if (lifecycle.stopRequested) throw Error('Shutdown requested during startup');
  if (config.server.auth.mode === 'none' && !['127.0.0.1', 'localhost', '::1'].includes(config.server.host)) throw Error('Unauthenticated mode must be loopback');
  const db = await safePath(root, config.memory.database);
  lock = await acquireProjectLock(root, config.project.id, config.memory.database);
   if (lifecycle.stopRequested) throw Error('Shutdown requested during startup');
   await mkdir(path.dirname(db), { recursive: true }); store = new Store(db, config.project.id);learningWriter=createLearningWriter(store,config);
   try{await reconcile(await safePath(root, config.knowledge.path), store,learningWriter);}catch(error){if(!(error instanceof Error&&error.message==='NLP sidecar request failed'))throw error;console.error('Knowledge load deferred; the last valid graph remains active and learning writes are unavailable.');}
   if (lifecycle.stopRequested) throw Error('Shutdown requested during startup');
  browser = new BrowserController(config, root); await browser.start();
   if (lifecycle.stopRequested) throw Error('Shutdown requested during startup');
   let applicationReady = false;
   try { await browser.navigate(config.project.base_url, 'domcontentloaded', 2500); applicationReady = true; } catch { /* The configured application may start after UMB. */ }
    if (lifecycle.stopRequested) throw Error('Shutdown requested during startup');
     const stopServer=await serve(config, store, browser, { applicationReady, projectRoot:root,knowledgeRoot:await safePath(root,config.knowledge.path),learningWriter,watchKnowledge:Boolean(o.watchKnowledge),approver: async prompt => { if(!process.stdin.isTTY||!process.stdout.isTTY)return false;const rl=createInterface({input:process.stdin,output:process.stdout});try{return (await rl.question(prompt)).trim().toLowerCase()==='y';}finally{rl.close();} } });
     stop=async()=>{try{await stopServer();}finally{await learningWriter?.close();}};
  lifecycle.markReady();
  console.error(`UMB project ${config.project.id} listening at http://${config.server.host}:${config.server.port}/mcp`);
  await lifecycle.waitForStopRequest();
 } catch (e) { console.error(`Serve failed: ${(e as Error).message}`); process.exitCode = 1; }
  finally { process.off('SIGINT', signal); process.off('SIGTERM', signal); try { await lifecycle.shutdown(); } catch (e) { console.error(`Shutdown failed: ${(e as Error).message}`); process.exitCode = 1; } finally { await learningWriter?.close(); } }
 });
 cli.command('mcp').option('--stdio','Use local subprocess stdio transport').option('--config <path>','Config file','umb.config.yaml').action(async o => {
  if(!o.stdio){console.error('Specify --stdio for the local subprocess transport.');process.exitCode=1;return;}
   let store:Store|undefined,browser:BrowserController|undefined,learningWriter:ReturnType<typeof createLearningWriter>|undefined,stop:(()=>Promise<void>)|undefined;
  let lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined;
   const lifecycle=new ShutdownLifecycle(async()=>{try{await stop?.();}finally{try{await learningWriter?.close();}finally{try{await browser?.close();}finally{try{store?.close();}finally{await lock?.release();}}}}});
  const signal=()=>lifecycle.requestStop();process.on('SIGINT',signal);process.on('SIGTERM',signal);process.stdin.once('end',signal);
  try{
   const{config,root}=await loadConfig(o.config);if(lifecycle.stopRequested)throw Error('Shutdown requested during startup');
   const db=await safePath(root,config.memory.database);lock=await acquireProjectLock(root,config.project.id,config.memory.database);
    await mkdir(path.dirname(db),{recursive:true});store=new Store(db,config.project.id);learningWriter=createLearningWriter(store,config);
    try{await reconcile(await safePath(root,config.knowledge.path),store,learningWriter);}catch(error){if(!(error instanceof Error&&error.message==='NLP sidecar request failed'))throw error;console.error('Knowledge load deferred; the last valid graph remains active and learning writes are unavailable.');}if(lifecycle.stopRequested)throw Error('Shutdown requested during startup');
   browser=new BrowserController(config,root);await browser.start();if(lifecycle.stopRequested)throw Error('Shutdown requested during startup');
    let applicationReady = false;
    try { await browser.navigate(config.project.base_url, 'domcontentloaded', 2500); applicationReady = true; } catch { /* The configured application may start after UMB. */ }
    if(lifecycle.stopRequested)throw Error('Shutdown requested during startup');
     const stopServer=await serve(config,store,browser,{stdio:true,applicationReady,projectRoot:root,knowledgeRoot:await safePath(root,config.knowledge.path),learningWriter});stop=async()=>{try{await stopServer();}finally{await learningWriter?.close();}};
   lifecycle.markReady();await lifecycle.waitForStopRequest();
  }catch(e){console.error(`MCP stdio failed: ${(e as Error).message}`);process.exitCode=1;}
   finally{process.off('SIGINT',signal);process.off('SIGTERM',signal);process.stdin.off('end',signal);try{await lifecycle.shutdown();}catch(e){console.error(`Shutdown failed: ${(e as Error).message}`);process.exitCode=1;}finally{await learningWriter?.close();}}
  });
 const playwright=cli.command('playwright').description('Manage explicit local Playwright endpoints');
 playwright.command('endpoint').option('--config <path>','Config file','umb.config.yaml').option('--token-env <name>','Environment variable containing endpoint bearer token','UMB_PLAYWRIGHT_ENDPOINT_TOKEN').action(async o=>{
  let lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined,endpoint:Awaited<ReturnType<typeof startPlaywrightEndpoint>>|undefined,closing=false;
  let finish!:()=>void;const stopped=new Promise<void>(resolve=>{finish=resolve;});
  const signal=()=>finish();process.on('SIGINT',signal);process.on('SIGTERM',signal);process.stdin.once('end',signal);process.stdin.resume();
  try{
   if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.tokenEnv))throw Error('Invalid --token-env variable name');
   const token=process.env[o.tokenEnv];if(!token)throw Error(`Set ${o.tokenEnv} before starting endpoint`);
   const{config,root}=await loadConfig(o.config);lock=await acquireProjectLock(root,config.project.id,config.memory.database);
    endpoint=await startPlaywrightEndpoint(token,config.browser.engine);if(closing)throw Error('Shutdown requested during startup');
   console.error(`Playwright endpoint available at ${endpoint.endpoint} (Bearer auth required; local loopback only)`);
   await stopped;
  }catch(error){console.error(`Playwright endpoint failed: ${(error as Error).message}`);process.exitCode=1;}
  finally{closing=true;process.off('SIGINT',signal);process.off('SIGTERM',signal);process.stdin.off('end',signal);try{await endpoint?.close();}catch{process.exitCode=1;}await lock?.release().catch(()=>{});}
 });
 cli.parseAsync(process.argv);
