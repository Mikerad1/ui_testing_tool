import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Store} from '../src/memory/store.js';
import {serve} from '../src/mcp/server.js';
import type {Config} from '../src/config/config.js';

async function port(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const value=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return value;}

const browserTools=['ui_errors','ui_navigate','ui_set_viewport','ui_screenshot','ui_snapshot','ui_find','ui_click','ui_fill','ui_type','ui_press','ui_select','ui_keyboard','ui_upload','ui_scroll','ui_wait_for','ui_tabs','ui_tab_select','ui_tab_create','ui_tab_close','ui_back','ui_forward','ui_status','ui_refresh'];
const attachedTools=['ui_status','ui_refresh','ui_find','ui_snapshot','ui_click','ui_wait_for','ui_screenshot','ui_navigate','ui_back','ui_forward','ui_fill','ui_type','ui_press','ui_select','ui_keyboard','ui_scroll','ui_upload'];

for(const provider of ['browser','desktop'] as const)test(`ui_* exposes ${provider} browser-tool visibility, schemas, and dispatch`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-ui-alias-')),listenPort=await port(),url=provider==='desktop'?'tauri://localhost/':'http://127.0.0.1:3000/';
  const config={version:1,provider,project:{id:`ui-alias-${provider}`,name:'UI alias fixture',base_url:provider==='desktop'?'tauri://localhost':'http://127.0.0.1:3000'},server:{host:'127.0.0.1',port:listenPort,auth:{mode:'none'}},browser:{headless:true,viewport:{width:800,height:600},allowed_origins:provider==='desktop'?['tauri://localhost']:[]},memory:{database:path.join(root,'memory.sqlite')},knowledge:{path:path.join(root,'knowledge')},artifacts:{directory:'artifacts'},desktop:{...(provider==='desktop'?{mode:'attached'}:{}),enabled:false,automation:{endpoint:'http://127.0.0.1:4444',session_id:'test-owned-session'},window:{screenshot_mode:'webview'},visual:{capture_on_failure:false}}} as unknown as Config;
 const store=await Store.open(config.memory.database,config.project.id,'legacy'),dispatches:string[]=[];
   const baseBrowser:any={revision:0,workflowCapabilities:provider==='desktop'?{actions:['navigate','click','fill','type','press','select','scroll'],waits:['visible'],assertions:['text:exact'],locatorStrategies:['css'],failureCapture:['screenshot'],routeChecks:false,supportsPressKey:(key:string)=>key==='ArrowUp'}:undefined,currentUrl:()=>url,status:async()=>{dispatches.push('status:[]');return{tabId:'fixture',url,title:'UI alias fixture',loading:false,pendingDialog:null,lastPageError:null,revision:0,viewport:{width:800,height:600}};}};
  const browser=new Proxy(baseBrowser,{get(target,key,receiver){if(Reflect.has(target,key))return Reflect.get(target,key,receiver);if(typeof key==='string')return async(...args:any[])=>{dispatches.push(`${key}:${JSON.stringify(args)}`);return{method:key,args};};}});
 let stopped:(()=>Promise<void>)|undefined,client:Client|undefined,transport:StreamableHTTPClientTransport|undefined;
 try{
  stopped=await serve(config,store,browser,{projectRoot:root});
  transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listenPort}/mcp`),{fetch:async(input,init)=>fetch(input,{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),accept:'application/json, text/event-stream'}})});
  client=new Client({name:'ui-alias-test',version:'1'});await client.connect(transport);
    const listed=(await client.listTools()).tools,names=new Set(listed.map(item=>item.name)),schemas=new Map(listed.map(item=>[item.name,item.inputSchema])),expected=provider==='desktop'?attachedTools:browserTools;
    assert.deepEqual([...names].filter(name=>name.startsWith('ui_')).sort(),[...expected].sort(),`${provider} publishes exactly its generic browser operations`);
    assert.equal([...names].some(name=>name.startsWith('browser_')),false,'legacy browser names are absent');assert.equal([...names].some(name=>name.startsWith('desktop_')),false,'legacy desktop names are absent');
   const ready=await client.callTool({name:'ui_refresh',arguments:{}}) as any;assert.equal(ready.isError,undefined,'readiness initialized before operation dispatch');dispatches.length=0;
   const argsByOperation:Record<string,any>={errors:{},navigate:{url},set_viewport:{width:800,height:600},screenshot:{},snapshot:{},find:{by:'css',value:'#fixture'},click:{target:{by:'css',value:'#fixture'}},fill:{target:{by:'css',value:'#fixture'},value:'safe'},type:{target:{by:'css',value:'#fixture'},value:'safe'},press:{target:{by:'css',value:'#fixture'},value:provider==='desktop'?'ArrowUp':'Enter'},select:{target:{by:'css',value:'#fixture'},value:'option'},keyboard:{key:'ArrowUp'},upload:{target:{by:'css',value:'#fixture'},project_relative_path:'fixture.txt'},scroll:{direction:'down',amount:1},wait_for:{condition:'visible',target:{by:'css',value:'#fixture'}},tabs:{},tab_select:{id:'fixture'},tab_create:{url},tab_close:{id:'fixture'},back:{},forward:{}};
    const invoke=expected.filter(name=>name!=='ui_refresh'&&name!=='ui_status');
    for(const name of invoke){const operation=name.slice('ui_'.length),args=argsByOperation[operation]??{},before=dispatches.length;const result=await client.callTool({name,arguments:args}) as any;assert.equal(result.isError,undefined,`${name} dispatches successfully with safe mock args: ${JSON.stringify(result.structuredContent??result.content)}`);assert.ok(dispatches.length>before,`${name} reaches the fake provider`);}
    for(const name of ['ui_status','ui_refresh']){const before=dispatches.length,result=await client.callTool({name,arguments:{}}) as any;assert.equal(result.isError,undefined,`${name} dispatches successfully`);assert.ok(dispatches.length>before,`${name} reaches the fake provider`);}
 }finally{await client?.close().catch(()=>undefined);await transport?.close().catch(()=>undefined);await stopped?.().catch(()=>undefined);store.close();await rm(root,{recursive:true,force:true});}
});
