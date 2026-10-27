import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Store} from '../src/memory/store.js';
import {BrowserController} from '../src/browser/controller.js';
import {serve} from '../src/mcp/server.js';
import type {Config} from '../src/config/config.js';

async function listen(server:Server){server.listen(0,'127.0.0.1');await once(server,'listening');return(server.address() as any).port as number;}
async function close(server:Server){if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}

test('no-Jira browser quick-start tools record a passing assertion under a temporary project',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'umb-quick-start-'));
  const app=createServer((_request,response)=>response.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Quick start fixture</title><h1>Local app</h1>'));
  let store:Store|undefined,browser:BrowserController|undefined,envName:string|undefined;
  let stop:(()=>Promise<void>)|undefined,transport:StreamableHTTPClientTransport|undefined,client:Client|undefined;
  try{
    const appPort=await listen(app),mcpProbe=createServer(),mcpPort=await listen(mcpProbe);await close(mcpProbe);
    const token=`quick-start-${process.pid}-${Date.now()}`;envName=`UMB_QUICK_START_${process.pid}_${Date.now()}`;process.env[envName]=token;
    const knowledge=path.join(temp,'knowledge');await mkdir(knowledge);
    const config:Config={version:1,project:{id:'quick-start-fixture',name:'Quick start fixture',base_url:`http://127.0.0.1:${appPort}`},server:{host:'127.0.0.1',port:mcpPort,auth:{mode:'token',token_env:envName}},browser:{headless:true,viewport:{width:800,height:600},allowed_origins:[]},memory:{database:path.join(temp,'memory.sqlite')},knowledge:{path:knowledge}};
    store=new Store(config.memory.database,config.project.id);browser=new BrowserController(config,temp);
    const subject=store.applicationSubject();
    assert(subject,'temporary fixture application subject created');
    await browser.start();
    stop=await serve(config,store,browser,{idleTimeoutMs:10000});
    const base=`http://127.0.0.1:${mcpPort}/mcp`;
    transport=new StreamableHTTPClientTransport(new URL(base),{requestInit:{headers:{authorization:`Bearer ${token}`}}});
    client=new Client({name:'umb-quick-start-fixture',version:'1.0.0'});
    await client.connect(transport);
    const call=async(name:string,args:Record<string,unknown>={})=>client!.callTool({name,arguments:args});
    const status=await call('ui_status');assert.equal((status as any).structuredContent.ok,true);
    const nav=await call('ui_navigate',{url:config.project.base_url,wait_until:'domcontentloaded',timeout_ms:10000});assert.notEqual(nav.isError,true,JSON.stringify(nav));
    const snapshot=await call('ui_snapshot');assert.notEqual(snapshot.isError,true,JSON.stringify(snapshot));
    const assertion=await call('test_assert',{condition:'url_matches',expected:`127.0.0.1:${appPort}`});
    assert.notEqual(assertion.isError,true,JSON.stringify(assertion));
    const data=(assertion as any).structuredContent.data;
    assert.equal(data.status,'PASS');assert(data.run_id);assert(data.evidence_refs?.length);
    const evidence=store.readEvidence(subject.id,data.run_id) as Array<{id:string;artifact_ref:string|null}>;
    assert.equal(evidence.length,1);assert.equal(evidence[0]?.id,data.evidence_refs[0].evidence_id);
  }finally{
    await client?.close();await transport?.close();if(stop)await stop();await browser?.close();store?.close();
    await close(app);if(envName)delete process.env[envName];await rm(temp,{recursive:true,force:true});
  }
});
