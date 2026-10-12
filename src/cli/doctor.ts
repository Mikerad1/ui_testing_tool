import { access } from 'node:fs/promises';
import net from 'node:net';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { loadConfig, safePath } from '../config/config.js';
import { validateKnowledge } from '../knowledge/reconcile.js';
import { CURRENT_SCHEMA_VERSION } from '../memory/store.js';

export type DoctorCheck={name:string;status:'ok'|'warning'|'fail';message:string};
export async function runDoctor(configPath:string):Promise<{ok:boolean;checks:DoctorCheck[]}>{
 const checks:DoctorCheck[]=[];const add=(name:string,status:DoctorCheck['status'],message:string)=>checks.push({name,status,message});
 let loaded:Awaited<ReturnType<typeof loadConfig>>;
 try{loaded=await loadConfig(configPath);add('config','ok','Configuration parsed successfully.');}catch{add('config','fail','Configuration could not be parsed or loaded.');return{ok:false,checks};}
 const {config,root}=loaded;
 for(const [name,target] of [['memory',config.memory.database],['knowledge',config.knowledge.path],['artifacts',config.artifacts?.directory??'./.umb/artifacts']] as const){try{await safePath(root,target);add(`${name}-path`,'ok',`${name} path is within the project root.`);}catch{add(`${name}-path`,'fail',`${name} path is unsafe.`);}}
 if(!['127.0.0.1','localhost','::1'].includes(config.server.host))add('server','fail','MCP server host must be loopback.');else add('server','ok','MCP server host is loopback and port is valid.');
 if(config.server.auth.mode==='token'&&!process.env[config.server.auth.token_env])add('token','fail','Required authentication token environment variable is not set.');else add('token','ok','Authentication configuration is available.');
 try{await validateKnowledge(await safePath(root,config.knowledge.path));add('knowledge','ok','Knowledge YAML documents and references are valid.');}catch{add('knowledge','fail','Knowledge YAML validation failed; inspect document syntax, schemas, and references.');}
 let dbPath='';try{dbPath=await safePath(root,config.memory.database);await access(dbPath);const db=new Database(dbPath,{readonly:true,fileMustExist:true});try{const quick=db.pragma('quick_check') as any[];const fk=db.pragma('foreign_key_check') as any[];const version=db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {version:number|null};if(quick.length!==1||quick[0].quick_check!=='ok')add('database-integrity','fail','SQLite quick_check reported a problem.');else add('database-integrity','ok','SQLite quick_check passed.');if(fk.length)add('database-foreign-keys','fail','SQLite foreign key check reported violations.');else add('database-foreign-keys','ok','SQLite foreign key check passed.');if(version.version!==CURRENT_SCHEMA_VERSION)add('database-schema','fail','Database schema is not at the current migration version.');else add('database-schema','ok','Database schema is current.');}finally{db.close();}}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')add('database','warning','Database is not initialized.');else add('database','fail','Database could not be checked.');}
 try{const browser=await chromium.launch({headless:true});try{const context=await browser.newContext();try{const page=await context.newPage();await page.close();}finally{await context.close();}}finally{await browser.close();}add('browser','ok','Headless Chromium launched successfully.');}catch{add('browser','fail','Headless Chromium could not be launched; verify its executable installation.');}
 try{await new Promise<void>((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(config.server.port,config.server.host,()=>server.close(e=>e?reject(e):resolve()));});add('mcp-port','ok','Configured MCP port is available.');}catch{add('mcp-port','fail','Configured MCP port is busy or unavailable; stop its current listener or choose another port.');}
 return{ok:!checks.some(c=>c.status==='fail'),checks};
}
