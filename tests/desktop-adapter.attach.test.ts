import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {readFile,mkdtemp,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopAdapter,DesktopAdapterError} from '../src/browser/desktop-adapter.js';
import type {Config} from '../src/config/config.js';

const png=await readFile(new URL('./fixtures/tauri-app/src-tauri/icons/icon.png',import.meta.url));
async function serve(handler:(url:string,method:string,res:import('node:http').ServerResponse)=>void){const server=createServer((req,res)=>handler(req.url??'',req.method??'',res));server.listen(0,'127.0.0.1');await once(server,'listening');return{server,port:(server.address() as {port:number}).port};}
function config(endpoint:string,session='bearer-like-session'):Config{return{provider:'desktop',project:{id:'attach-test',name:'attach test',base_url:'http://127.0.0.1'},browser:{headless:true,viewport:{width:800,height:600},allowed_origins:[]},desktop:{automation:{endpoint,session_id:session},visual:{},window:{screenshot_mode:'webview'}}} as unknown as Config;}
test('desktop adapter lazily attaches with GET screenshot and detach never deletes',async()=>{
  let calls:Array<{url:string;method:string}>=[];const fixture=await serve((url,method,res)=>{calls.push({url,method});res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({value:png.toString('base64')}));});
  const root=await mkdtemp(path.join(os.tmpdir(),'umb-attach-'));const adapter=new DesktopAdapter(config(`http://127.0.0.1:${fixture.port}`),root);
   try{await adapter.start();assert.deepEqual(calls,[]);const shot=await adapter.captureScreenshotBytes({kind:'webview'});assert.equal(shot.captureKind,'webview');assert.equal(shot.image.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.deepEqual(await readdir(root),[],'raw capture does not persist artifacts');assert.deepEqual(calls.map(c=>c.method),['GET']);assert.ok(calls[0]!.url.includes('/session/bearer-like-session/screenshot'));await assert.rejects(adapter.takeScreenshot(false),error=>error instanceof DesktopAdapterError&&error.code==='CAPABILITY_UNAVAILABLE');await assert.rejects(adapter.takeScreenshot({kind:'webview'}),error=>error instanceof DesktopAdapterError&&error.code==='PERSISTENCE_ERROR');await adapter.close();assert.deepEqual(calls.map(c=>c.method),['GET']);assert.equal(calls.some(c=>c.method==='DELETE'),false);await assert.rejects(adapter.captureScreenshotBytes({kind:'webview'}),/ATTACHMENT_UNAVAILABLE/);}
  finally{await new Promise<void>(resolve=>fixture.server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
test('desktop adapter rejects DNS loopback aliases, redirects, missing sessions, and window capture',async()=>{
  assert.throws(()=>new DesktopAdapter(config('http://localhost:4444')),/INVALID_ADAPTER_CONFIG/);
  let redirected=false;const target=await serve((_u,_m,res)=>{redirected=true;res.end('{}');});const redirect=await serve((_u,_m,res)=>{res.writeHead(302,{location:`http://127.0.0.1:${target.port}/x`}).end();});
   const missing=await serve((_u,_m,res)=>res.writeHead(404,{'content-type':'application/json'}).end(JSON.stringify({value:{error:'invalid session id',message:'private raw response'}})));const unknown=await serve((_u,_m,res)=>res.writeHead(404,{'content-type':'application/json'}).end(JSON.stringify({value:{error:'unknown command',message:'private raw response'}})));const root=await mkdtemp(path.join(os.tmpdir(),'umb-attach-errors-'));
  try{
     const redirectedAdapter=new DesktopAdapter(config(`http://127.0.0.1:${redirect.port}`));await assert.rejects(redirectedAdapter.captureScreenshotBytes({kind:'webview'}),/ATTACHMENT_UNAVAILABLE/);assert.equal(redirected,false);
      const absent=new DesktopAdapter(config(`http://127.0.0.1:${missing.port}`,'secret-session-id'));await assert.rejects(absent.captureScreenshotBytes({kind:'webview'}),error=>error instanceof DesktopAdapterError&&error.code==='SESSION_NOT_FOUND'&&!error.message.includes('secret-session-id')&&!error.message.includes('private raw response'));
      const unknownRoute=new DesktopAdapter(config(`http://127.0.0.1:${unknown.port}`));await assert.rejects(unknownRoute.captureScreenshotBytes({kind:'webview'}),error=>error instanceof DesktopAdapterError&&error.code==='REMOTE_COMMAND_FAILED'&&!error.message.includes('private raw response'));
    await assert.rejects(absent.takeScreenshot({kind:'window'}),error=>error instanceof DesktopAdapterError&&error.code==='CAPABILITY_UNAVAILABLE');
   }finally{await Promise.all([redirect.server,target.server,missing.server,unknown.server].map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));await rm(root,{recursive:true,force:true});}
 });

test('attached screenshot validates complete PNG structure before persisting any artifact',async()=>{
  const cases=[Buffer.from('89504e470d0a1a0a','hex'),png.subarray(0,32),(()=>{const bad=Buffer.from(png);bad.writeUInt32BE(0,16);return bad;})()];
  for(const bytes of cases){const fixture=await serve((_u,_m,res)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({value:bytes.toString('base64')}))),root=await mkdtemp(path.join(os.tmpdir(),'umb-attach-invalid-png-')),adapter=new DesktopAdapter(config(`http://127.0.0.1:${fixture.port}`),root);try{await assert.rejects(adapter.captureScreenshotBytes({kind:'webview'}),error=>error instanceof DesktopAdapterError&&error.code==='REMOTE_COMMAND_FAILED');assert.deepEqual(await readdir(root),[]);}finally{await new Promise<void>(resolve=>fixture.server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}}
});
