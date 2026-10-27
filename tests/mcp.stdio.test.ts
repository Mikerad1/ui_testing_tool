import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { acquireProjectLock } from '../src/security/project-lock.js';
import { Store } from '../src/memory/store.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
class CapturingStdioTransport extends StdioClientTransport {
 stdout='';
 override async start():Promise<void>{await super.start();const child=(this as any)._process;child.stdout.on('data',(chunk:Buffer)=>{this.stdout+=chunk.toString('utf8');});}
}
test('stdio CLI serves MCP tools over official transport and releases resources on client close',{timeout:60000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-stdio-'));
  const app=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<html><title>test</title><body>ready</body></html>');});
  app.listen(0,'127.0.0.1');await once(app,'listening');const port=(app.address() as any).port;await new Promise<void>(resolve=>app.close(()=>resolve()));
 const config=path.join(root,'umb.config.yaml');
 await mkdir(path.join(root,'knowledge'),{recursive:true});
  await writeFile(config,`version: 1\nprovider: desktop\nproject:\n  id: stdio-test\n  name: stdio-test\n  base_url: http://127.0.0.1:${port}\nserver:\n  host: 127.0.0.1\n  port: 7317\n  auth:\n    mode: token\n    token_env: UMB_MCP_TOKEN\nbrowser:\n  headless: true\nmemory:\n  database: ./.umb/memory.sqlite\nknowledge:\n  path: ./knowledge\ndesktop:\n  mode: managed\n  enabled: false\n`);
  const transport=new CapturingStdioTransport({command:process.execPath,args:['--import','tsx/esm',path.join(repo,'src/cli/index.ts'),'mcp','--stdio','--config',config],cwd:repo,env:{...process.env,UMB_MCP_TOKEN:'stdio-test-token'},stderr:'pipe'});
 let stderr='';transport.stderr?.on('data',(data:Buffer)=>{stderr+=data.toString();});
 const client=new Client({name:'stdio-test',version:'1.0.0'});
 try{
  await client.connect(transport);
       const listed=await client.listTools();assert.equal(listed.tools.some(tool=>tool.name.startsWith('browser_')),false,'managed mode does not construct or publish BrowserAdapter routes');
       for(const name of ['ui_capabilities','ui_project_inspect','ui_session_start','ui_screenshot','ui_tree','ui_capabilities','ui_project_inspect','ui_session_start','ui_screenshot','ui_tree'])assert.ok(listed.tools.some(tool=>tool.name===name),`${name} is discoverable`);
       const desktopInspect=await client.callTool({name:'ui_project_inspect',arguments:{}}) as any;assert.equal(desktopInspect.structuredContent.data.tauri,false);assert.equal(desktopInspect.structuredContent.data.buildCommandConfigured,false);
       const desktopStart=await client.callTool({name:'ui_session_start',arguments:{}}) as any;assert.equal(desktopStart.isError,true);assert.equal(desktopStart.structuredContent.error.code,'desktop_disabled');
         const saveTool=listed.tools.find(tool=>tool.name==='memory_save')!,saveSchema=saveTool.inputSchema as any;
         assert.deepEqual(saveSchema.required,['content']);assert.ok(saveSchema.properties.content);assert.ok(saveSchema.properties.title);assert.match(saveTool.description!,/immediately persistent.*available through normal memory retrieval/i);
         for(const removed of ['memory_propose','memory_verify','memory_add_edge','memory_supersede','memory_candidates'])assert.equal(listed.tools.some(tool=>tool.name===removed),false,`${removed} is not registered`);
          const managedTestVisual=['test_assert','test_run_workflow','test_report','visual_screenshot','visual_baseline_save','visual_baseline_read','visual_compare','visual_finding_create','visual_finding_list','visual_finding_update','visual_review'];for(const name of managedTestVisual)assert.equal(listed.tools.filter(tool=>tool.name===name).length,1,`${name} is registered once in managed mode`);
         assert.match(listed.tools.find(tool=>tool.name==='memory_get_node')!.description!,/including saved MCP learnings/i);assert.match(listed.tools.find(tool=>tool.name==='memory_path')!.description!,/including saved MCP learnings/i);
     assert.equal((await client.callTool({name:'ui_session_status',arguments:{}}) as any).structuredContent.error.code,'desktop_disabled');
      assert.equal((await client.callTool({name:'memory_stats',arguments:{}}) as any).structuredContent.ok,true);
      const search=await client.callTool({name:'memory_search',arguments:{query:'stdio-test'}}) as any;assert.equal(Array.isArray(search.structuredContent.data),true);assert.equal(search.structuredContent.data[0].stable_key,'stdio-test');assert.equal(search.structuredContent.pagination.status,'complete');assert.equal('pagination' in search.structuredContent.data,false);
        const beforeLearningWrite=(await client.callTool({name:'memory_stats',arguments:{}}) as any).structuredContent.data.nodes;
          const blockedLearningWrite=await client.callTool({name:'memory_save',arguments:{content:'NO_NLP_SECRET_SENTINEL'}}) as any;
          assert.equal(blockedLearningWrite.isError,true);assert.equal(blockedLearningWrite.structuredContent.ok,false);assert.equal(blockedLearningWrite.structuredContent.error.code,'learning_writes_disabled');assert.match(blockedLearningWrite.structuredContent.error.message,/memory\.persistent_learning_writes: true.*restart UMB/i);assert(!JSON.stringify(blockedLearningWrite).includes('NO_NLP_SECRET_SENTINEL'));
     assert.equal((await client.callTool({name:'memory_stats',arguments:{}}) as any).structuredContent.data.nodes,beforeLearningWrite);
   await new Promise(resolve=>setTimeout(resolve,20));
   const frames=transport.stdout.split('\n').filter(line=>line.length>0);assert.ok(frames.length>=3,'expected initialize/list/tools protocol frames');
   for(const frame of frames){const message=JSON.parse(frame);assert.equal(message.jsonrpc,'2.0',`non-protocol stdout line: ${frame}`);}
  const pid=transport.pid;assert.ok(pid);
  await client.close();
  const deadline=Date.now()+15000;let alive=true;while(Date.now()<deadline){try{process.kill(pid,0);await new Promise(resolve=>setTimeout(resolve,100));}catch{alive=false;break;}}
  assert.equal(alive,false,`stdio child did not exit; stderr=${stderr}`);
  const lock=await acquireProjectLock(root,'stdio-test','./.umb/memory.sqlite');await lock.release();
 }finally{
  try{await client.close();}catch{}
  await transport.close().catch(()=>{});
   if(app.listening)await new Promise<void>(resolve=>app.close(()=>resolve()));await rm(root,{recursive:true,force:true});
 }
});

test('stdio CLI startup failure keeps stdout empty and reports only on stderr',{timeout:20000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-stdio-failure-'));const missing=path.join(root,'missing.yaml');
 const child=spawn(process.execPath,['--import','tsx/esm',path.join(repo,'src/cli/index.ts'),'mcp','--stdio','--config',missing],{cwd:repo,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',chunk=>{stdout+=chunk.toString();});child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
 try{const exit=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`startup failure timed out: ${stderr}`)),15000);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});assert.notEqual(exit,0);assert.equal(stdout,'');assert.match(stderr,/MCP stdio failed/i);}
  finally{if(child.exitCode===null)child.kill();await rm(root,{recursive:true,force:true});}
 });

test('stdio shutdown drains an active learning write before sidecar and Store teardown',{timeout:30000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-stdio-drain-'));
 const log=path.join(root,'sidecar.log'),fixture=path.join(repo,'tests/fixtures/stdio-learning-server.ts');
 const transport=new CapturingStdioTransport({command:process.execPath,args:['--import','tsx/esm',fixture,root,log],cwd:repo,env:process.env,stderr:'pipe'});
  const client=new Client({name:'stdio-drain-test',version:'1'});
  try{
   await client.connect(transport);
     const saved=await client.callTool({name:'memory_save',arguments:{content:'Use the account menu to open project settings.'}}) as any;
     assert.equal(saved.structuredContent.data.saved,true);assert.equal(saved.structuredContent.data.immediately_available,true);assert.equal('verification_status' in saved.structuredContent.data,false);assert.equal('pending' in saved.structuredContent.data,false);
     const write=client.callTool({name:'memory_save',arguments:{content:'A pending learning drains before shutdown.',title:'Shutdown drain'}});
   const deadline=Date.now()+10000;
   while(Date.now()<deadline){try{if((await readFile(log,'utf8')).includes('analyze-start'))break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
  assert((await readFile(log,'utf8')).includes('analyze-start'),'sidecar analysis began before shutdown');
  const child=(transport as any)._process;
  const exited=once(child,'exit');
  child.stdin.end();
  await exited;
   await write.catch(()=>undefined); // The second client call is interrupted; its write must still drain.
  const events=(await readFile(log,'utf8')).trim().split('\n');
   assert.deepEqual(events,['analyze-start','analyze-done','analyze-start','analyze-done','shutdown']);
    const store=new Store(path.join(root,'memory.sqlite'),'stdio-drain','local');
     try{const note=store.getTrustedNode(saved.structuredContent.data.id);assert.equal(note.type,'note');assert.equal('verification_status' in note,false);assert.equal(JSON.parse(note.attributes_json).content,'Use the account menu to open project settings.');assert(store.search('settings').some((row:any)=>row.id===note.id),'saved note is normally searchable after reopen');const searched=store.searchPage('settings').data.find((row:any)=>row.id===note.id);assert(searched);assert.equal('verification_status' in searched,false,'search does not expose note lifecycle state');assert.equal(note.project_id,'stdio-drain');assert.equal(note.environment,'local');assert(store.context().trusted_facts.some((row:any)=>row.id===note.id&&!('verification_status' in row)),'context does not present a pending lifecycle state');assert(store.export().nodes.some((row:any)=>row.id===note.id&&!('verification_status' in row)),'exports do not present a pending lifecycle state');
       const anchor=store.applicationSubject()!,raw=new Database(path.join(root,'memory.sqlite'));raw.prepare('INSERT INTO edges(id,project_id,environment,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,stable_key) VALUES(?,?,?,?,?,?,?,?,?,?)').run('test-note-neighbor','stdio-drain','local',anchor.id,note.id,'NOTE_REFERENCE','{}','human','verified','test-note-neighbor');raw.close();const neighbor=store.neighbors(anchor.id).find((item:any)=>item.neighbor.id===note.id)?.neighbor;assert(neighbor);assert.equal('verification_status' in neighbor,false,'neighbors do not expose note lifecycle state');
     }finally{store.close();}
 }finally{
  await client.close().catch(()=>{});
  await transport.close().catch(()=>{});
  await rm(root,{recursive:true,force:true});
 }
});
