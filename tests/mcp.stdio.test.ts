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
 await writeFile(config,`version: 1\nproject:\n  id: stdio-test\n  name: stdio-test\n  base_url: http://127.0.0.1:${port}\nserver:\n  host: 127.0.0.1\n  port: 7317\n  auth:\n    mode: token\n    token_env: UMB_MCP_TOKEN\nbrowser:\n  headless: true\n  allowed_origins:\n    - http://127.0.0.1:${port}\nmemory:\n  database: ./.umb/memory.sqlite\nknowledge:\n  path: ./knowledge\n`);
  const transport=new CapturingStdioTransport({command:process.execPath,args:['--import','tsx/esm',path.join(repo,'src/cli/index.ts'),'mcp','--stdio','--config',config],cwd:repo,env:{...process.env,UMB_MCP_TOKEN:'stdio-test-token'},stderr:'pipe'});
 let stderr='';transport.stderr?.on('data',(data:Buffer)=>{stderr+=data.toString();});
 const client=new Client({name:'stdio-test',version:'1.0.0'});
 try{
  await client.connect(transport);
      const listed=await client.listTools();assert.ok(listed.tools.some(tool=>tool.name==='browser_status'));assert.ok(listed.tools.some(tool=>tool.name==='browser_refresh'));assert.ok(listed.tools.some(tool=>tool.name==='browser_set_viewport'));
      const proposeSchema=listed.tools.find(tool=>tool.name==='memory_propose')!.inputSchema as any,edgeSchema=listed.tools.find(tool=>tool.name==='memory_add_edge')!.inputSchema as any;
       assert(proposeSchema.required.includes('observation_id'));assert(proposeSchema.required.includes('evidence_refs'));assert(edgeSchema.required.includes('observation_id'));assert(edgeSchema.required.includes('evidence_refs'));
     const result=await client.callTool({name:'browser_status',arguments:{}});assert.equal((result as any).structuredContent.data.application_ready,false);
    const unavailable=await client.callTool({name:'browser_snapshot',arguments:{}});assert.equal((unavailable as any).structuredContent.error.code,'application_not_ready');assert.match((unavailable as any).structuredContent.error.message,/not ready.*browser_refresh/i);
    const failedRefresh=await client.callTool({name:'browser_refresh',arguments:{}});assert.equal(failedRefresh.isError,true);assert.match((failedRefresh as any).structuredContent.error.message,/start the application.*browser_refresh/i);
    assert.equal((await client.callTool({name:'browser_status',arguments:{}}) as any).structuredContent.data.application_ready,false);
      assert.equal((await client.callTool({name:'memory_stats',arguments:{}}) as any).structuredContent.ok,true);
      const search=await client.callTool({name:'memory_search',arguments:{query:'stdio-test'}}) as any;assert.equal(Array.isArray(search.structuredContent.data),true);assert.equal(search.structuredContent.data[0].stable_key,'stdio-test');assert.equal(search.structuredContent.pagination.status,'complete');assert.equal('pagination' in search.structuredContent.data,false);
        const beforeLearningWrite=(await client.callTool({name:'memory_stats',arguments:{}}) as any).structuredContent.data.nodes;
        const evidenceStore=new Store(path.join(root,'.umb/memory.sqlite'),'stdio-test');
        let evidenceRef:any;
        try{const subject=evidenceStore.applicationSubject()!;const assertion=evidenceStore.recordAssertion({session_id:'stdio-contract',subject_node_id:subject.id,passed:true,observed_count:1});evidenceRef={evidence_id:(assertion.evidence as any).id,run_id:assertion.id,subject_node_id:subject.id};}finally{evidenceStore.close();}
        const missingEvidence=await client.callTool({name:'memory_propose',arguments:{observation_id:'missing-evidence',type:'screen',stable_key:'missing-evidence',display_name:'Missing evidence'}}) as any;assert.equal(missingEvidence.isError,true);assert.equal(missingEvidence.structuredContent.error.code,'invalid_input');
        const blockedLearningWrite=await client.callTool({name:'memory_propose',arguments:{observation_id:'no-nlp',type:'screen',stable_key:'no-nlp',display_name:'NO_NLP_SECRET_SENTINEL',evidence_refs:[evidenceRef]}}) as any;
        assert.equal(blockedLearningWrite.isError,true);assert.equal(blockedLearningWrite.structuredContent.ok,false);assert(!JSON.stringify(blockedLearningWrite).includes('NO_NLP_SECRET_SENTINEL'));
        const duplicate=await client.callTool({name:'memory_propose',arguments:{observation_id:'duplicate-ref',type:'screen',stable_key:'duplicate-ref',display_name:'Duplicate',evidence_refs:[evidenceRef,evidenceRef]}}) as any;assert.equal(duplicate.isError,true);
        const duplicateCase=await client.callTool({name:'memory_propose',arguments:{observation_id:'duplicate-case-ref',type:'screen',stable_key:'duplicate-case-ref',display_name:'Duplicate case',evidence_refs:[evidenceRef,{...evidenceRef,evidence_id:evidenceRef.evidence_id.toUpperCase()}]}}) as any;assert.equal(duplicateCase.isError,true);
        const oversized=await client.callTool({name:'memory_propose',arguments:{observation_id:'oversized-refs',type:'screen',stable_key:'oversized-refs',display_name:'Oversized',evidence_refs:Array(6).fill(evidenceRef)}}) as any;assert.equal(oversized.isError,true);
     assert.equal((await client.callTool({name:'memory_stats',arguments:{}}) as any).structuredContent.data.nodes,beforeLearningWrite);
    const appReady=new Promise<void>(resolve=>app.listen(port,'127.0.0.1',resolve));await appReady;
    const refreshed=await client.callTool({name:'browser_refresh',arguments:{}});assert.equal((refreshed as any).structuredContent.data.application_ready,true);
     const readyStatus=await client.callTool({name:'browser_status',arguments:{}});assert.equal((readyStatus as any).structuredContent.data.application_ready,true);
    const resized=await client.callTool({name:'browser_set_viewport',arguments:{width:1024,height:768}});assert.equal((resized as any).structuredContent.ok,true);assert.deepEqual((resized as any).structuredContent.data.viewport,{width:1024,height:768});
    const invalidViewport=await client.callTool({name:'browser_set_viewport',arguments:{width:10001,height:768}});assert.equal(invalidViewport.isError,true);
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
    const evidenceStore=new Store(path.join(root,'memory.sqlite'),'stdio-drain');let evidenceRef:any;try{const subject=evidenceStore.applicationSubject()!;const assertion=evidenceStore.recordAssertion({session_id:'stdio-drain-test',subject_node_id:subject.id,passed:true,observed_count:1});evidenceRef={evidence_id:(assertion.evidence as any).id,run_id:assertion.id,subject_node_id:subject.id};}finally{evidenceStore.close();}
    const write=client.callTool({name:'memory_propose',arguments:{observation_id:'drain-observation',type:'screen',stable_key:'drain-note',display_name:'Drain note',evidence_refs:[evidenceRef]}});
   const deadline=Date.now()+10000;
   while(Date.now()<deadline){try{if((await readFile(log,'utf8')).includes('analyze-start'))break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
  assert((await readFile(log,'utf8')).includes('analyze-start'),'sidecar analysis began before shutdown');
  const child=(transport as any)._process;
  const exited=once(child,'exit');
  child.stdin.end();
  await exited;
  await write.catch(()=>undefined); // The client has disconnected; the assertion is persistence and teardown order.
  const events=(await readFile(log,'utf8')).trim().split('\n');
  assert.deepEqual(events,['analyze-start','analyze-done','shutdown']);
  const store=new Store(path.join(root,'memory.sqlite'),'stdio-drain');
   try{assert(store.getByTypeKey('screen','drain-note'),'active learning write committed before shutdown');}finally{store.close();}
 }finally{
  await client.close().catch(()=>{});
  await transport.close().catch(()=>{});
  await rm(root,{recursive:true,force:true});
 }
});
