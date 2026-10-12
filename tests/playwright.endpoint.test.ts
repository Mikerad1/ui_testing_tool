import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer, connect as connectTcp, type Socket } from 'node:net';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { acquireProjectLock } from '../src/security/project-lock.js';
import { startAuthenticatedWebSocketProxy } from '../src/playwright/endpoint.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const token='a-secure-endpoint-token-long-enough-for-test';
function rejectHandshake(url:string,headers:Record<string,string>|undefined,expected:number):Promise<void>{return new Promise((resolve,reject)=>{const socket=new WebSocket(url,{headers});socket.once('open',()=>{socket.terminate();reject(new Error('Unexpected WebSocket connection'));});socket.once('unexpected-response',(_req,res)=>{res.resume();res.once('end',()=>res.statusCode===expected?resolve():reject(new Error(`Expected ${expected}, got ${res.statusCode}`)));});socket.once('error',error=>{if(!socket.listenerCount('unexpected-response'))reject(error);});});}
function waitExit(proc:ReturnType<typeof spawn>,timeoutMs:number,details:()=>string):Promise<number|null>{return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`process exit timeout: ${details()}`)),timeoutMs);proc.once('exit',code=>{clearTimeout(timer);resolve(code);});});}

test('authenticated local Playwright endpoint enforces one client and releases lock on shutdown',{timeout:90000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-endpoint-'));const config=path.join(root,'umb.config.yaml');
 await mkdir(path.join(root,'knowledge'),{recursive:true});await writeFile(config,'version: 1\nproject:\n  id: endpoint-test\n  name: endpoint-test\n  base_url: http://127.0.0.1:3000\nserver:\n  host: 127.0.0.1\n  port: 7317\n  auth:\n    mode: token\n    token_env: UMB_MCP_TOKEN\nbrowser:\n  headless: true\n  allowed_origins:\n    - http://127.0.0.1:3000\nmemory:\n  database: ./.umb/memory.sqlite\nknowledge:\n  path: ./knowledge\n');
 const child=spawn(process.execPath,['--import','tsx/esm',path.join(repo,'src/cli/index.ts'),'playwright','endpoint','--config',config],{cwd:repo,env:{...process.env,UMB_PLAYWRIGHT_ENDPOINT_TOKEN:token},stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr?.on('data',chunk=>{stderr+=chunk.toString();});let endpoint='';let client:import('playwright').Browser|undefined;
 try{
  const deadline=Date.now()+45000;while(Date.now()<deadline&&!endpoint){const match=/Playwright endpoint available at (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(stderr);if(match)endpoint=match[1]!;if(child.exitCode!==null)throw Error(`endpoint process exited ${child.exitCode}: ${stderr}`);await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(endpoint,`endpoint startup timed out: ${stderr}`);
  const parsed=new URL(endpoint);assert.equal(parsed.hostname,'127.0.0.1');
  await rejectHandshake(endpoint,undefined,401);await rejectHandshake(endpoint,{Authorization:'Bearer wrong-token'},401);
  await rejectHandshake(`${parsed.origin}/wrong-path`,{Authorization:`Bearer ${token}`},404);
  client=await chromium.connect(endpoint,{headers:{Authorization:`Bearer ${token}`}});
  const context=await client.newContext(),page=await context.newPage();await page.setContent('<title>attached-ok</title>');assert.equal(await page.title(),'attached-ok');
  await rejectHandshake(endpoint,{Authorization:`Bearer ${token}`},409);
  await context.close();await client.close();client=undefined;
  const releasedBy=Date.now()+5000;let second:import('playwright').Browser|undefined;
  while(Date.now()<releasedBy&&!second){try{second=await chromium.connect(endpoint,{headers:{Authorization:`Bearer ${token}`}});}catch{await new Promise(resolve=>setTimeout(resolve,30));}}
  assert.ok(second,'later client should connect after upstream close completes');await second.close();
  await assert.rejects(acquireProjectLock(root,'endpoint-test','./.umb/memory.sqlite'),/locked/);
  const contender=spawn(process.execPath,['--import','tsx/esm',path.join(repo,'src/cli/index.ts'),'mcp','--stdio','--config',config],{cwd:repo,env:{...process.env,UMB_MCP_TOKEN:'endpoint-test-token'},stdio:['ignore','pipe','pipe']});let contenderErr='';contender.stderr?.on('data',chunk=>{contenderErr+=chunk.toString();});
  const contenderCode=await waitExit(contender,15000,()=>contenderErr);assert.notEqual(contenderCode,0);assert.match(contenderErr,/locked by PID|already locked/i);
  child.stdin.end();const exitCode=await waitExit(child,20000,()=>stderr);assert.equal(exitCode,0,`endpoint child exit; stderr=${stderr}`);
  const lock=await acquireProjectLock(root,'endpoint-test','./.umb/memory.sqlite');await lock.release();
 }finally{
  await client?.close().catch(()=>{});if(child.exitCode===null)child.kill();await new Promise(resolve=>setTimeout(resolve,100));await rm(root,{recursive:true,force:true});
 }
});

test('proxy shutdown destroys an authenticated raw socket during a stalled upstream handshake',{timeout:10000},async()=>{
 const upstream=createTcpServer();const accepted:Socket[]=[];upstream.on('connection',socket=>accepted.push(socket));upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const upstreamPort=(upstream.address() as import('node:net').AddressInfo).port;
 const proxy=await startAuthenticatedWebSocketProxy(`ws://127.0.0.1:${upstreamPort}/hang`,'hanging-upstream-test-token-long-enough');
 const address=new URL(proxy.endpoint);const client=connectTcp(Number(address.port),'127.0.0.1');let received='';client.on('data',chunk=>{received+=chunk.toString();});
 const downstreamClosed=once(client,'close');
 client.write(`GET ${address.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer hanging-upstream-test-token-long-enough\r\n\r\n`);
 try{
  await once(upstream,'connection');assert.equal(proxy.hasActiveClient(),true);
  const started=Date.now();await proxy.close();await Promise.race([downstreamClosed,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('raw downstream remained open after proxy shutdown')),2000))]);
  assert.ok(Date.now()-started<2000);assert.equal(proxy.hasActiveClient(),false);assert.ok(accepted.every(socket=>socket.destroyed));
 }finally{client.destroy();await proxy.close();for(const socket of accepted)socket.destroy();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});

test('lease remains held until upstream close handshake and downstream socket closure',{timeout:10000},async()=>{
 const upstream=createHttpServer();let closeSeen!:()=>void,closeCompleted!:()=>void;
 const sawClose=new Promise<void>(resolve=>{closeSeen=resolve;}),upstreamClosed=new Promise<void>(resolve=>{closeCompleted=resolve;});let connections=0;
 upstream.on('upgrade',(req,socket)=>{
  connections++;const accept=createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data',data=>{if((data[0]!&0x0f)!==8)return;
   if(connections===1){closeSeen();setTimeout(()=>{socket.end(Buffer.from([0x88,0x00]));closeCompleted();},400);}
   else{socket.end(Buffer.from([0x88,0x00]));}
  });
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const upstreamPort=(upstream.address() as import('node:net').AddressInfo).port;
 const proxy=await startAuthenticatedWebSocketProxy(`ws://127.0.0.1:${upstreamPort}/ws`,'delayed-close-token-long-enough-for-proxy-test');let clientA:WebSocket|undefined,clientB:WebSocket|undefined;
 const connectClient=async()=>{const ws=new WebSocket(proxy.endpoint,{headers:{Authorization:'Bearer delayed-close-token-long-enough-for-proxy-test'}});await once(ws,'open');return ws;};
 try{
  clientA=await connectClient();clientA.close();await sawClose;
  assert.equal(proxy.hasActiveClient(),true,'lease must remain held while upstream close is pending');
  await rejectHandshake(proxy.endpoint,{Authorization:'Bearer delayed-close-token-long-enough-for-proxy-test'},409);
  await upstreamClosed;
  const deadline=Date.now()+1000;while(proxy.hasActiveClient()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(proxy.hasActiveClient(),false,'lease releases after both close events');
  clientB=await connectClient();assert.equal(connections,2);clientB.close();
 }finally{
  clientA?.terminate();clientB?.terminate();await proxy.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));
 }
});
