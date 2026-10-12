import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {loadConfig,type Config} from '../src/config/config.js';
import {BrowserController} from '../src/browser/controller.js';
import {browserTypeFor,type BrowserEngine} from '../src/browser/engine.js';

const engines:BrowserEngine[]=['chromium','firefox','webkit'];
const missingExecutable=(error:unknown)=>/Executable doesn't exist|Please run.*playwright install|browserType\.launch:.*executable/i.test(error instanceof Error?error.message:String(error));

test('engine adapter selects supported types and preserves Chromium fallback',()=>{
 assert.equal(browserTypeFor(undefined).name(),'chromium');
 for(const engine of engines)assert.equal(browserTypeFor(engine).name(),engine);
 assert.throws(()=>browserTypeFor('unknown'),/Unsupported browser engine/);
});

test('browser engine config defaults to Chromium and strictly validates alternatives',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-engine-config-')),file=path.join(root,'umb.config.yaml');
 try{const prefix=`version: 1\nproject:\n  id: engine-config\n  name: Engine config\n  base_url: http://127.0.0.1:3000\nbrowser:\n`;
  await writeFile(file,`${prefix}  headless: true\n`);assert.equal((await loadConfig(file)).config.browser.engine,'chromium');
  await writeFile(file,`${prefix}  engine: webkit\n`);assert.equal((await loadConfig(file)).config.browser.engine,'webkit');
  await writeFile(file,`${prefix}  engine: gecko\n`);await assert.rejects(loadConfig(file));
 }finally{await rm(root,{recursive:true,force:true});}
});

for(const engine of engines)test(`${engine} BrowserController common-capability smoke`,{timeout:60000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),`umb-engine-${engine}-`));let foreignRequests=0;
 const foreign=createServer((_req,res)=>{foreignRequests++;res.writeHead(200,{'content-type':'text/html'}).end('foreign');});foreign.listen(0,'127.0.0.1');await once(foreign,'listening');const foreignPort=(foreign.address() as any).port;
 const app=createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:`http://127.0.0.1:${foreignPort}/blocked`}).end();return;}res.writeHead(200,{'content-type':'text/html'}).end('<title>engine fixture</title><label for="entry">Value</label><input id="entry"><button data-testid="action" onclick="document.querySelector(\'[data-testid=result]\').textContent=\'Done\'">Go</button><p data-testid="result"></p><a target="_blank" data-testid="redirect" href="/redirect">redirect</a>');});app.listen(0,'127.0.0.1');await once(app,'listening');const appPort=(app.address() as any).port,origin=`http://127.0.0.1:${appPort}`;
 const config:Config={version:1,project:{id:`engine-${engine}`,name:'Engine smoke',base_url:origin},server:{host:'127.0.0.1',port:7317,auth:{mode:'none',token_env:'UMB_MCP_TOKEN'}},browser:{engine,headless:true,viewport:{width:800,height:600},allowed_origins:[origin],diagnostics:{console_errors:false,page_errors:false,failed_requests:false,http_errors:false,capacity:100}},artifacts:{directory:'./artifacts',redact_sensitive:true,max_file_bytes:1000000,max_total_bytes:5000000,max_count:20,max_age_days:1},memory:{database:'./memory.sqlite'},knowledge:{path:'./knowledge'}};
 const controller=new BrowserController(config,root);
 try{
  try{await controller.start();}catch(error){if(missingExecutable(error)&&process.env.UMB_REQUIRE_ALL_ENGINES!=='1'){t.skip(`${engine} executable is not installed locally`);return;}throw error;}
  await controller.navigate(origin);assert.equal(await controller.page.title(),'engine fixture');
  await controller.page.getByLabel('Value',{exact:true}).fill('ready');await controller.act('click',{by:'test_id',value:'action'});assert.equal(await controller.page.getByTestId('result').innerText(),'Done');
  const snapshot=await controller.snapshot({mode:'full'});assert.match(String(snapshot.accessibility),/engine fixture|Value|Go/);
  const screenshot=await controller.takeScreenshot();assert.equal(typeof screenshot.artifactPath,'string');
  await controller.act('click',{by:'test_id',value:'redirect'});assert.equal(foreignRequests,0,'navigation redirect outside the configured origins is blocked');
 }finally{await controller.close().catch(()=>{});for(const server of [app,foreign])await new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});await rm(root,{recursive:true,force:true});}
});
