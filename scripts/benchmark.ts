import { cpus, totalmem } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { Store } from '../src/memory/store.js';
import { reconcile } from '../src/knowledge/reconcile.js';
import { loadConfig } from '../src/config/config.js';
import { BrowserController } from '../src/browser/controller.js';
import { serve } from '../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const parsedArgs = new Map<string, string | boolean>();
const addArgs = (tokens: string[]) => {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith('--')) continue;
    const equals = token.indexOf('=');
    const key = equals < 0 ? token : token.slice(0, equals);
    if (equals >= 0) parsedArgs.set(key, token.slice(equals + 1));
    else if (tokens[i + 1] !== undefined && !tokens[i + 1]!.startsWith('--')) parsedArgs.set(key, tokens[++i]!);
    else parsedArgs.set(key, true);
  }
};
addArgs(process.argv.slice(2));
if (process.env.npm_config_argv) {
  try {
    const npmArgs = JSON.parse(process.env.npm_config_argv) as { original?: unknown };
    if (Array.isArray(npmArgs.original)) {
      const original = npmArgs.original.filter((x): x is string => typeof x === 'string');
      const separator = original.lastIndexOf('--');
      if (separator >= 0) addArgs(original.slice(separator + 1));
      else {
        const scriptIndex = original.lastIndexOf('benchmark');
        if (scriptIndex >= 0) addArgs(original.slice(scriptIndex + 1));
      }
    }
  } catch { /* npm may omit or change the optional legacy argument metadata */ }
}
const cliValue = (name: string) => parsedArgs.get(name);
const quick = cliValue('--quick') === true || cliValue('--quick') === 'true' || process.env.npm_config_quick === 'true';
// npm 11 on Windows may encode unknown forwarded flags as npm_config_<flag>=true
// while placing their separate values at the end of process.argv.
const looseValues = process.argv.slice(2).filter(token => !token.startsWith('--'));
for (const [index, name] of ['--reps', '--warmups'].entries()) {
  const envName = `npm_config_${name.slice(2)}`;
  if (!parsedArgs.has(name) && process.env[envName] === 'true' && looseValues[index] !== undefined) {
    parsedArgs.set(name, looseValues[index]!);
  }
}
const value = (name: string, fallback: number) => {
  const cli = cliValue(name);
  const envName = `npm_config_${name.slice(2).replaceAll('-', '_')}`;
  const raw = typeof cli === 'string' ? cli : process.env[envName] ?? fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const reps = Math.max(1, value('--reps', quick ? 1 : 5));
const warmups = value('--warmups', 1);
const failures: string[] = [];
const timed = async (fn: () => Promise<unknown> | unknown) => { const start = performance.now(); await fn(); return performance.now() - start; };
const summary = (raw: number[]) => { const sorted = [...raw].sort((a,b)=>a-b); return {raw_ms:raw,median_ms:sorted.length?sorted[Math.floor((sorted.length-1)/2)]:null,p95_ms:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]??null:null}; };
const listen = (server: ReturnType<typeof createServer>, port = 0) => new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
const closeHttp = (server?: ReturnType<typeof createServer>) => new Promise<void>(resolve=>{if(!server?.listening)return resolve();server.close(()=>resolve());});
const temp = await mkdtemp(path.join(tmpdir(),'umb-benchmark-'));
let fixtureServer: ReturnType<typeof createServer> | undefined;
let mcpStop: (()=>Promise<void>)|undefined, client: Client|undefined, transport: StreamableHTTPClientTransport|undefined;
let commandStore: Store|undefined, graphStore: Store|undefined, browser: BrowserController|undefined;
const result: any = {schema_version:1,mode:quick?'quick':'full',environment:{commit_sha:null,dirty:null,os:os.platform(),release:os.release(),arch:os.arch(),node:process.version,npm:null,cpu_model:cpus()[0]?.model??null,cpu_cores:cpus().length,ram_bytes:totalmem(),sqlite_version:null,playwright_version:null,chromium_version:null},fixture_sizes:{yaml_files:100,graph_nodes:quick?null:10000,graph_edges:quick?null:30000,commands:100},repetitions:{samples:reps,warmups},benchmarks:{},failures};
try {
  try { result.environment.commit_sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();result.environment.dirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(); } catch {}
  result.environment.npm=process.env.npm_config_npm_version??null;
  result.environment.sqlite_version=process.versions.sqlite??null;
  try { result.environment.playwright_version=(await import('playwright/package.json',{with:{type:'json'}}) as any).default.version; } catch {}
  const fixture=path.join(temp,'site'); await mkdir(fixture);
  await writeFile(path.join(fixture,'index.html'),'<button data-testid="counter" id="counter">0</button><script>document.querySelector("button").onclick=()=>document.querySelector("button").textContent=String(+document.querySelector("button").textContent+1)</script>');
  fixtureServer=createServer(async(_q,r)=>{r.setHeader('content-type','text/html');r.end(await readFile(path.join(fixture,'index.html')));}); await listen(fixtureServer);
  const url=`http://127.0.0.1:${(fixtureServer.address() as any).port}`;
  const project=path.join(temp,'project');await mkdir(project);const cfg=path.join(project,'umb.config.yaml');
  const portServer=createServer();await listen(portServer);const mcpPort=(portServer.address() as any).port;await closeHttp(portServer);
  await writeFile(cfg,`version: 1\nproject:\n  id: benchmark\n  name: Benchmark\n  base_url: ${url}\nserver:\n  host: 127.0.0.1\n  port: ${mcpPort}\n  auth:\n    mode: none\nbrowser:\n  headless: true\n  allowed_origins: []\nmemory:\n  database: ./.umb/memory.sqlite\nknowledge:\n  path: ./umb-knowledge\n`);
  const configMs=await timed(()=>loadConfig(cfg));const {config}=await loadConfig(cfg);
  let phaseStore!:Store;const storeMs=await timed(()=>{phaseStore=new Store(path.join(temp,'phase.sqlite'),'phase');});phaseStore.close();
  const knowledge=path.join(project,'umb-knowledge');await mkdir(knowledge);for(let i=0;i<100;i++)await writeFile(path.join(knowledge,`screen-${String(i).padStart(3,'0')}.yaml`),`schema_version: 1\nid: screen-${i}\nname: Screen ${i}\nkind: screen\n`);
  const yamlStore=new Store(path.join(temp,'yaml.sqlite'),'yamlbench');const initial:number[]=[],unchanged:number[]=[];
  // First import is distinct; later measured passes are unchanged reconciliation.
  initial.push(await timed(()=>reconcile(knowledge,yamlStore)));for(let i=0;i<reps;i++)unchanged.push(await timed(()=>reconcile(knowledge,yamlStore)));
  result.benchmarks.yaml_reconcile={initial_import:summary(initial),unchanged_pass:summary(unchanged),files:100,documents:100};yamlStore.close();

  browser=new BrowserController(config,project);let launchMs=0,navigationMs=0;const snapshots:number[]=[];
  launchMs=await timed(()=>browser!.start());result.environment.chromium_version=browser.browser.version();
  navigationMs=await timed(()=>browser!.navigate(url));for(let i=0;i<warmups;i++)await browser.snapshot({mode:'compact'});for(let i=0;i<reps;i++)snapshots.push(await timed(()=>browser!.snapshot({mode:'compact'})));
  commandStore=new Store(path.join(temp,'commands.sqlite'),'benchmark');
  const listenerMs=await timed(async()=>{mcpStop=await serve(config,commandStore!,browser!);});
  client=new Client({name:'umb-benchmark',version:'1.0.0'});transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`));await client.connect(transport);
  let expectedRevision=browser.revision;const commandSamples:number[]=[];let commandErrors=0;
  for(let i=0;i<100;i++){
    const elapsedStart=performance.now();
    try {
      const response:any=await client.callTool({name:'ui_click',arguments:{target:{by:'test_id',value:'counter'},expected_revision:expectedRevision}});
      const envelope=response.structuredContent as any;
      if(response.isError||!envelope?.ok||envelope.error)throw Error(JSON.stringify(envelope??response));
      expectedRevision=Number(envelope.state_revision);if(!Number.isInteger(expectedRevision))throw Error('missing state_revision');
    } catch(error) { commandErrors++;failures.push(`mcp_command_${i+1}: ${String(error)}`); }
    commandSamples.push(performance.now()-elapsedStart);
  }
  const counter=await browser.page.getByTestId('counter').innerText();
  const integrity=commandStore.db.prepare('PRAGMA integrity_check').get() as Record<string,string>;
  const fk=commandStore.db.prepare('PRAGMA foreign_key_check').all();
  if(counter!=='100')failures.push(`final counter expected 100, observed ${counter}`);
  if(integrity.integrity_check!=='ok')failures.push(`SQLite integrity_check: ${JSON.stringify(integrity)}`);
  if(fk.length)failures.push(`SQLite foreign_key_check returned ${fk.length} rows`);
  result.benchmarks.control_plane_startup={config_load_ms:configMs,store_open_migrate_ms:storeMs,mcp_listener_startup_ms:listenerMs};
  result.benchmarks.chromium={launch_ms:launchMs,navigation_ms:navigationMs,compact_snapshot:summary(snapshots)};
  result.benchmarks.mcp_session={commands:100,tool:'ui_click',sequential:true,per_call:summary(commandSamples),total_elapsed_ms:commandSamples.reduce((a,b)=>a+b,0),failure_count:commandErrors,validation:{final_counter:Number(counter),expected_counter:100,integrity_check:integrity.integrity_check,foreign_key_check_rows:fk.length,passed:counter==='100'&&integrity.integrity_check==='ok'&&fk.length===0&&commandErrors===0}};

  if(!quick){
    graphStore=new Store(path.join(temp,'graph.sqlite'),'graph');const ids:string[]=[];
    const seed=await timed(()=>{const tx=graphStore!.db.transaction(()=>{for(let i=0;i<10000;i++){const id=`node-${i}`;ids.push(id);graphStore!.db.prepare('INSERT INTO nodes(id,project_id,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'graph','node',id,id,`node ${i}`,'{}','human','verified',1);}for(let i=0;i<30000;i++){const a=i%10000,b=(i*7+1)%10000;graphStore!.db.prepare('INSERT INTO edges(id,project_id,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,stable_key) VALUES(?,?,?,?,?,?,?,?,?)').run(`edge-${i}`,'graph',ids[a]!,ids[b]!,'LINK','{}','human','verified',`edge-${i}`);}});tx();});
    const queryFns:Record<string,()=>unknown>={search:()=>graphStore!.search('node 50'),neighbors:()=>graphStore!.neighbors(ids[0]!),bounded_path:()=>graphStore!.path(ids[0]!,ids[35]!,5)};
    const queryResults:any={};
    for(const [name,fn] of Object.entries(queryFns)){
      const cold:number[]=[];for(let i=0;i<reps;i++){graphStore.db.pragma('shrink_memory');cold.push(await timed(fn));}
      for(let i=0;i<warmups;i++)fn();const warm:number[]=[];for(let i=0;i<reps;i++)warm.push(await timed(fn));
      queryResults[name]={sqlite_connection_page_cache_cold:summary(cold),warm:summary(warm)};
    }
    result.benchmarks.graph={seed_ms:seed,nodes:10000,edges:30000,warmups, cold_definition:'PRAGMA shrink_memory before each first query; OS filesystem cache may remain warm',queries:queryResults};
  }
} catch(error) { failures.push(`benchmark: ${String(error)}`); }
finally {
  try { await client?.close(); } catch(error) { failures.push(`client_cleanup: ${String(error)}`); }
  try { await transport?.close(); } catch {}
  try { await mcpStop?.(); } catch(error) { failures.push(`mcp_cleanup: ${String(error)}`); }
  try { await browser?.close(); } catch(error) { failures.push(`browser_cleanup: ${String(error)}`); }
  try { graphStore?.close(); } catch {}
  try { commandStore?.close(); } catch {}
  await closeHttp(fixtureServer);
  await rm(temp,{recursive:true,force:true});
}
result.failures=failures;
process.stdout.write(JSON.stringify(result,null,2)+'\n');
if(failures.length)process.exitCode=1;
