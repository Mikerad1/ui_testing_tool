#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, safePath } from '../config/config.js';
import { Store } from '../memory/store.js';
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

const cli = new Command().name('umb').description('UI Memory Browser');
cli.command('init').option('--project <id>', 'Project id', 'demo-web').option('--url <url>', 'Application base URL', 'http://127.0.0.1:3000').action(async o => {
 const config = `version: 1\nproject:\n  id: ${o.project}\n  name: ${o.project}\n  base_url: ${o.url}\nserver:\n  host: 127.0.0.1\n  port: 7317\n  auth:\n    mode: token\n    token_env: UMB_MCP_TOKEN\nbrowser:\n  headless: true\n  allowed_origins:\n    - ${new URL(o.url).origin}\nartifacts:\n  directory: ./.umb/artifacts\n  redact_sensitive: true\nmemory:\n  database: ./.umb/memory.sqlite\nknowledge:\n  path: ./umb-knowledge\n`;
 await writeFile('umb.config.yaml', config, { flag: 'wx' }); await mkdir('umb-knowledge', { recursive: true }); console.log('Created umb.config.yaml and umb-knowledge/. Set UMB_MCP_TOKEN before serving.');
});
cli.command('doctor').option('--config <path>', 'Config file', 'umb.config.yaml').action(async o => {
 try { const result = await runDoctor(o.config); for (const check of result.checks) console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`); if (!result.ok) process.exitCode = 1; }
 catch (e) { console.error(`Doctor failed: ${(e as Error).message}`); process.exitCode = 1; }
});
const knowledge=cli.command('knowledge').description('Manage YAML knowledge and local locator proposals');
knowledge.command('proposals').option('--config <path>','Config file','umb.config.yaml').action(async o=>{
 let store:Store|undefined,lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined;
 try{const{config,root}=await loadConfig(o.config);const db=await safePath(root,config.memory.database);lock=await acquireProjectLock(root,config.project.id,config.memory.database);await mkdir(path.dirname(db),{recursive:true});store=new Store(db,config.project.id);for(const proposal of store.listWorkflowLocatorProposals() as any[]){const prior=JSON.stringify(JSON.parse(proposal.previous_locator_json)),candidate=JSON.stringify(JSON.parse(proposal.candidate_locator_json));console.log(`${proposal.id} [${proposal.status}] ${proposal.source_path} :: screen ${proposal.screen_id} / element ${proposal.element_id}`);console.log(`  Prior locator (untrusted YAML source): ${prior}`);console.log(`  Candidate locator (untrusted YAML source): ${candidate}`);console.log(`  Reason: ${proposal.reason_code}`);}}
 catch{console.error('Unable to list locator proposals safely.');process.exitCode=1;}
 finally{store?.close();await lock?.release().catch(()=>{});}
});
knowledge.command('validate').option('--config <path>','Config file','umb.config.yaml').action(async o=>{
 try{const{config,root}=await loadConfig(o.config),knowledgeRoot=await safePath(root,config.knowledge.path),count=await validateKnowledge(knowledgeRoot);console.log(`Knowledge validation passed (${count} YAML documents).`);}
 catch{console.error('Knowledge validation failed; no graph changes were made.');process.exitCode=1;}
});
knowledge.command('reload').option('--config <path>','Config file','umb.config.yaml').action(async o=>{
 let store:Store|undefined,lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined;
 try{const{config,root}=await loadConfig(o.config),knowledgeRoot=await safePath(root,config.knowledge.path),db=await safePath(root,config.memory.database);lock=await acquireProjectLock(root,config.project.id,config.memory.database);await mkdir(path.dirname(db),{recursive:true});store=new Store(db,config.project.id);await reconcile(knowledgeRoot,store);console.log('Knowledge reload completed.');}
 catch(error){console.error(error instanceof Error&&/already locked|lock gate .*busy/i.test(error.message)?'Knowledge reload refused because the project is locked by an active UMB process.':'Knowledge reload failed; the previous valid graph remains active.');process.exitCode=1;}
 finally{store?.close();await lock?.release().catch(()=>{});}
});
 knowledge.command('confirm-locator <proposalId>').option('--config <path>','Config file','umb.config.yaml').action(async(proposalId,o)=>{
 if(!process.stdin.isTTY||!process.stdout.isTTY){console.error('Locator confirmation requires an interactive local TTY; no changes were made.');process.exitCode=1;return;}
 let store:Store|undefined,lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined;
 try{const{config,root}=await loadConfig(o.config);const db=await safePath(root,config.memory.database),knowledgeRoot=await safePath(root,config.knowledge.path);lock=await acquireProjectLock(root,config.project.id,config.memory.database);await mkdir(path.dirname(db),{recursive:true});store=new Store(db,config.project.id);const proposal=store.getWorkflowLocatorProposal(proposalId) as any;if(!proposal){console.error('Unknown locator proposal.');process.exitCode=1;return;}if(proposal.status==='accepted'){console.log('Locator proposal is already accepted.');return;}if(proposal.status!=='pending'){console.error(`Locator proposal is ${proposal.status}; no source change was made.`);process.exitCode=1;return;}console.log(`Confirm locator proposal ${proposal.id}?`);console.log(`Source document: ${proposal.source_path} (screen ${proposal.screen_id}, element ${proposal.element_id})`);console.log(`Prior locator — untrusted YAML source data: ${JSON.stringify(JSON.parse(proposal.previous_locator_json))}`);console.log(`Candidate locator — untrusted YAML source data: ${JSON.stringify(JSON.parse(proposal.candidate_locator_json))}`);console.log('Confirmation does not edit YAML. The source must already contain the candidate as primary and preserve the prior locator in fallback_locators.');const rl=createInterface({input:process.stdin,output:process.stdout});let answer:string;try{answer=await rl.question('Accept and validate/reconcile this manual YAML edit? [y/N] ');}finally{rl.close();}if(answer.trim().toLowerCase()!=='y'){store.setWorkflowLocatorProposalStatus(proposal.id,'rejected');console.log('Proposal rejected; YAML and graph were not changed.');return;}const result=await confirmWorkflowLocatorProposal(store,proposal.id,knowledgeRoot);if(result.status==='accepted')console.log('Locator proposal accepted after knowledge validation and reconciliation.');else{console.error('Proposal source is stale or invalid; it was not accepted.');process.exitCode=1;}}
 catch{console.error('Locator confirmation failed safely.');process.exitCode=1;}
 finally{store?.close();await lock?.release().catch(()=>{});}
 });
 const workflow=cli.command('workflow').description('Verify and export reviewed workflow specs');
 workflow.command('verify <workflowId>').requiredOption('--run-id <runId>','Successful workflow run id').option('--config <path>','Config file','umb.config.yaml').action(async(workflowId,o)=>{
  if(!process.stdin.isTTY||!process.stdout.isTTY){console.error('Workflow export verification requires an interactive local TTY.');process.exitCode=1;return;}
  let store:Store|undefined,lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined;
  try{const{config,root}=await loadConfig(o.config);lock=await acquireProjectLock(root,config.project.id,config.memory.database);const db=await safePath(root,config.memory.database);await mkdir(path.dirname(db),{recursive:true});store=new Store(db,config.project.id);await reconcile(await safePath(root,config.knowledge.path),store);
   const eligible=store.workflowExportEligibility(workflowId,o.runId);if(!eligible)throw Error('Workflow/run is not eligible for export verification.');
   console.log(`Verify workflow ${workflowId} from successful run ${o.runId} (source ${eligible.contentHash.slice(0,12)}) for static spec export?`);
   const rl=createInterface({input:process.stdin,output:process.stdout});let answer:string;try{answer=await rl.question('This creates export eligibility only; generated source requires review. [y/N] ');}finally{rl.close();}
   if(answer.trim().toLowerCase()!=='y'){console.error('Workflow export verification declined.');process.exitCode=1;return;}
   if(!store.verifyWorkflowExport(workflowId,o.runId))throw Error('Workflow verification became stale; no verification was recorded.');console.log('Workflow export verification recorded for the current YAML hash.');
  }catch(error){console.error(`Workflow verification failed: ${(error as Error).message}`);process.exitCode=1;}finally{store?.close();await lock?.release().catch(()=>{});}
 });
 workflow.command('export <workflowId>').requiredOption('--output <relativePath>','New project-relative .spec.ts path').option('--config <path>','Config file','umb.config.yaml').action(async(workflowId,o)=>{
  let store:Store|undefined,lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined;
  try{const{config,root}=await loadConfig(o.config);lock=await acquireProjectLock(root,config.project.id,config.memory.database);const db=await safePath(root,config.memory.database);await mkdir(path.dirname(db),{recursive:true});store=new Store(db,config.project.id);await reconcile(await safePath(root,config.knowledge.path),store);
   if(!store.hasWorkflowExportVerification(workflowId))throw Error('Workflow has no verification for its current YAML content hash.');
   const relative=o.output as string,source=generateWorkflowSpec(store,workflowId,config.project.base_url,config.browser.allowed_origins);
   await writeWorkflowSpec(root,relative,source);console.log(`Generated ${relative}. Review the static source before running it; no test was executed.`);
  }catch(error){console.error(`Workflow export failed: ${(error as Error).message}`);process.exitCode=1;}finally{store?.close();await lock?.release().catch(()=>{});}
 });
  cli.command('serve').option('--config <path>', 'Config file', 'umb.config.yaml').option('--watch-knowledge','Watch YAML knowledge and reconcile validated changes').action(async o => {
 let store: Store | undefined, browser: BrowserController | undefined, stop: (() => Promise<void>) | undefined;
 let lock: Awaited<ReturnType<typeof acquireProjectLock>> | undefined;
 const lifecycle = new ShutdownLifecycle(async () => {
   try { await stop?.(); } finally { try { await browser?.close(); } finally { try { store?.close(); } finally { await lock?.release(); } } }
  });
 const signal = () => { lifecycle.requestStop(); };
 process.on('SIGINT', signal); process.on('SIGTERM', signal);
 try {
  const { config, root } = await loadConfig(o.config);
   if (lifecycle.stopRequested) throw Error('Shutdown requested during startup');
  if (config.server.auth.mode === 'none' && !['127.0.0.1', 'localhost', '::1'].includes(config.server.host)) throw Error('Unauthenticated mode must be loopback');
  const db = await safePath(root, config.memory.database);
  lock = await acquireProjectLock(root, config.project.id, config.memory.database);
   if (lifecycle.stopRequested) throw Error('Shutdown requested during startup');
  await mkdir(path.dirname(db), { recursive: true }); store = new Store(db, config.project.id);
  await reconcile(await safePath(root, config.knowledge.path), store);
   if (lifecycle.stopRequested) throw Error('Shutdown requested during startup');
  browser = new BrowserController(config, root); await browser.start();
   if (lifecycle.stopRequested) throw Error('Shutdown requested during startup');
  await browser.navigate(config.project.base_url);
   if (lifecycle.stopRequested) throw Error('Shutdown requested during startup');
   stop = await serve(config, store, browser, { projectRoot:root,knowledgeRoot:await safePath(root,config.knowledge.path),watchKnowledge:Boolean(o.watchKnowledge),approver: async prompt => { if(!process.stdin.isTTY||!process.stdout.isTTY)return false;const rl=createInterface({input:process.stdin,output:process.stdout});try{return (await rl.question(prompt)).trim().toLowerCase()==='y';}finally{rl.close();} } });
  lifecycle.markReady();
  console.error(`UMB project ${config.project.id} listening at http://${config.server.host}:${config.server.port}/mcp`);
  await lifecycle.waitForStopRequest();
 } catch (e) { console.error(`Serve failed: ${(e as Error).message}`); process.exitCode = 1; }
 finally { process.off('SIGINT', signal); process.off('SIGTERM', signal); try { await lifecycle.shutdown(); } catch (e) { console.error(`Shutdown failed: ${(e as Error).message}`); process.exitCode = 1; } }
 });
 cli.command('mcp').option('--stdio','Use local subprocess stdio transport').option('--config <path>','Config file','umb.config.yaml').action(async o => {
  if(!o.stdio){console.error('Specify --stdio for the local subprocess transport.');process.exitCode=1;return;}
  let store:Store|undefined,browser:BrowserController|undefined,stop:(()=>Promise<void>)|undefined;
  let lock:Awaited<ReturnType<typeof acquireProjectLock>>|undefined;
  const lifecycle=new ShutdownLifecycle(async()=>{try{await stop?.();}finally{try{await browser?.close();}finally{try{store?.close();}finally{await lock?.release();}}}});
  const signal=()=>lifecycle.requestStop();process.on('SIGINT',signal);process.on('SIGTERM',signal);process.stdin.once('end',signal);
  try{
   const{config,root}=await loadConfig(o.config);if(lifecycle.stopRequested)throw Error('Shutdown requested during startup');
   const db=await safePath(root,config.memory.database);lock=await acquireProjectLock(root,config.project.id,config.memory.database);
   await mkdir(path.dirname(db),{recursive:true});store=new Store(db,config.project.id);
   await reconcile(await safePath(root,config.knowledge.path),store);if(lifecycle.stopRequested)throw Error('Shutdown requested during startup');
   browser=new BrowserController(config,root);await browser.start();if(lifecycle.stopRequested)throw Error('Shutdown requested during startup');
   await browser.navigate(config.project.base_url);if(lifecycle.stopRequested)throw Error('Shutdown requested during startup');
   stop=await serve(config,store,browser,{stdio:true,projectRoot:root,knowledgeRoot:await safePath(root,config.knowledge.path)});
   lifecycle.markReady();await lifecycle.waitForStopRequest();
  }catch(e){console.error(`MCP stdio failed: ${(e as Error).message}`);process.exitCode=1;}
  finally{process.off('SIGINT',signal);process.off('SIGTERM',signal);process.stdin.off('end',signal);try{await lifecycle.shutdown();}catch(e){console.error(`Shutdown failed: ${(e as Error).message}`);process.exitCode=1;}}
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
