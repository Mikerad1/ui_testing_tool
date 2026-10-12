import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { acquireProjectLock } from '../src/security/project-lock.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
class CapturingStdioTransport extends StdioClientTransport {
 stdout='';
 override async start():Promise<void>{await super.start();const child=(this as any)._process;child.stdout.on('data',(chunk:Buffer)=>{this.stdout+=chunk.toString('utf8');});}
}
test('stdio CLI serves MCP tools over official transport and releases resources on client close',{timeout:60000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-stdio-'));
 const app=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<html><title>test</title><body>ready</body></html>');});
 app.listen(0,'127.0.0.1');await once(app,'listening');const port=(app.address() as any).port;
 const config=path.join(root,'umb.config.yaml');
 await mkdir(path.join(root,'knowledge'),{recursive:true});
 await writeFile(config,`version: 1\nproject:\n  id: stdio-test\n  name: stdio-test\n  base_url: http://127.0.0.1:${port}\nserver:\n  host: 127.0.0.1\n  port: 7317\n  auth:\n    mode: token\n    token_env: UMB_MCP_TOKEN\nbrowser:\n  headless: true\n  allowed_origins:\n    - http://127.0.0.1:${port}\nmemory:\n  database: ./.umb/memory.sqlite\nknowledge:\n  path: ./knowledge\n`);
  const transport=new CapturingStdioTransport({command:process.execPath,args:['--import','tsx/esm',path.join(repo,'src/cli/index.ts'),'mcp','--stdio','--config',config],cwd:repo,env:{...process.env,UMB_MCP_TOKEN:'stdio-test-token'},stderr:'pipe'});
 let stderr='';transport.stderr?.on('data',(data:Buffer)=>{stderr+=data.toString();});
 const client=new Client({name:'stdio-test',version:'1.0.0'});
 try{
  await client.connect(transport);
   const listed=await client.listTools();assert.ok(listed.tools.some(tool=>tool.name==='browser_status'));
   const result=await client.callTool({name:'browser_status',arguments:{}});assert.ok(result.content?.length);
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
  await new Promise<void>(resolve=>app.close(()=>resolve()));await rm(root,{recursive:true,force:true});
 }
});

test('stdio CLI startup failure keeps stdout empty and reports only on stderr',{timeout:20000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-stdio-failure-'));const missing=path.join(root,'missing.yaml');
 const child=spawn(process.execPath,['--import','tsx/esm',path.join(repo,'src/cli/index.ts'),'mcp','--stdio','--config',missing],{cwd:repo,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',chunk=>{stdout+=chunk.toString();});child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
 try{const exit=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`startup failure timed out: ${stderr}`)),15000);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});assert.notEqual(exit,0);assert.equal(stdout,'');assert.match(stderr,/MCP stdio failed/i);}
 finally{if(child.exitCode===null)child.kill();await rm(root,{recursive:true,force:true});}
});
