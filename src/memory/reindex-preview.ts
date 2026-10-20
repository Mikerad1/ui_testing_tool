import Database from 'better-sqlite3';
import { open } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { hashBackfillEdge, hashBackfillNode } from './content-fingerprint.js';
import type { BackfillEdgeRecord, BackfillNodeRecord } from './backfill-types.js';
import { CURRENT_SCHEMA_VERSION } from './store.js';

export type MemoryPreviewSummary={scanned:number;would_migrate:number;would_merge:0;rejected:number;stale:number;failed:number;unchanged:number;scan_limit:number;truncated:boolean};
export type PreviewAnalyzer={ensureReady():Promise<void>;pipelineFingerprint():Promise<string>;analyzeNode(record:BackfillNodeRecord):Promise<string>;analyzeEdge(record:BackfillEdgeRecord):Promise<string>;close():Promise<void>};
type PreviewRow={kind:'node';id:string;type:string;stable_key:string;display_name:string;attributes_json:string;oversize:boolean}|{kind:'edge';id:string;from_node_id:string;to_node_id:string;relation_type:string;attributes_json:string;oversize:boolean};
type Row={kind:'node';record:BackfillNodeRecord}|{kind:'edge';record:BackfillEdgeRecord};
const MAX_RECORD_BYTES=64*1024,MAX_TOTAL_BYTES=4*1024*1024;
type JournalMode='wal'|'non-wal';
const fail=()=>new Error('Memory reindex preview failed safely. Check the existing database and WAL sidecars, then retry.');

async function assertSafeWalFiles(filename:string,expectedMode?:JournalMode):Promise<JournalMode>{
  let main;
  let mode:JournalMode;
  try{main=await open(filename,'r');const header=Buffer.alloc(20);const {bytesRead}=await main.read(header,0,20,0);if(bytesRead<20)throw fail();
    mode=header[18]===2&&header[19]===2?'wal':'non-wal';
  }catch{throw fail();}finally{await main?.close().catch(()=>{});}
  if(mode==='wal'||expectedMode==='wal')for(const suffix of ['-wal','-shm']){
    let handle;
    try{handle=await open(`${filename}${suffix}`,'r');const info=await handle.stat();if(!info.isFile())throw fail();const byte=Buffer.alloc(1);await handle.read(byte,0,1,0);}
    catch{throw fail();}finally{await handle?.close().catch(()=>{});}
  }
  return mode;
}
function openReadOnly(filename:string,expectedMode:JournalMode){const db=new Database(filename,{readonly:true,fileMustExist:true});try{
  db.pragma('query_only = ON');const mode=String(db.pragma('journal_mode',{simple:true})).toLowerCase()==='wal'?'wal':'non-wal';if(mode!==expectedMode)throw fail();return db;
}catch(error){db.close();throw error;}}
function buildRows(filename:string,project:string,environment:string,limit:number,mode:JournalMode):{rows:Array<Row|undefined>;truncated:boolean}{
  let db:Database.Database|undefined;
  try{
    db=openReadOnly(filename,mode);
    const tx=db.transaction(()=>{
      const history=db!.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{version:number}>;
      if(history.length!==CURRENT_SCHEMA_VERSION||history.some((row,index)=>row.version!==index+1))throw fail();
      const result:Array<PreviewRow>=[];let total=0,truncated=false;
      const collect=(rows:Iterable<PreviewRow>)=>{
        for(const row of rows){
          if(result.length>=limit+1){truncated=true;break;}
          const rawBytes=Buffer.byteLength(row.attributes_json,'utf8');
          const overhead=row.kind==='node'?Buffer.byteLength(row.id+row.type+row.stable_key+row.display_name,'utf8'):Buffer.byteLength(row.id+row.from_node_id+row.to_node_id+row.relation_type,'utf8');
          if(row.oversize){result.push(row);continue;}
          if(rawBytes+overhead>MAX_RECORD_BYTES){result.push({...row,oversize:true});continue;}
          if(total+rawBytes+overhead>MAX_TOTAL_BYTES){truncated=true;break;}
          total+=rawBytes+overhead;result.push(row);
        }
      };
      const nodes=db!.prepare(`WITH bounded AS (
        SELECT id AS source_id,type,stable_key,display_name,attributes_json,
          length(CAST(id AS BLOB))+length(CAST(type AS BLOB))+length(CAST(stable_key AS BLOB))+length(CAST(display_name AS BLOB))+length(CAST(attributes_json AS BLOB)) record_bytes
        FROM nodes WHERE project_id=? AND environment=?
      ) SELECT CASE WHEN record_bytes<=? THEN source_id ELSE NULL END id,
        CASE WHEN record_bytes<=? THEN type ELSE NULL END type,
        CASE WHEN record_bytes<=? THEN stable_key ELSE NULL END stable_key,
        CASE WHEN record_bytes<=? THEN display_name ELSE NULL END display_name,
        CASE WHEN record_bytes<=? THEN attributes_json ELSE NULL END attributes_json,record_bytes
        FROM bounded ORDER BY source_id LIMIT ?`).iterate(project,environment,MAX_RECORD_BYTES,MAX_RECORD_BYTES,MAX_RECORD_BYTES,MAX_RECORD_BYTES,MAX_RECORD_BYTES,limit+1) as Iterable<{id:string|null;type:string|null;stable_key:string|null;display_name:string|null;attributes_json:string|null;record_bytes:number}>;
      // The projection never returns identity or JSON values for over-limit records.
      collect((function*(){for(const row of nodes)yield{kind:'node',id:row.id??'',type:row.type??'',stable_key:row.stable_key??'',display_name:row.display_name??'',attributes_json:row.attributes_json??'',oversize:row.record_bytes>MAX_RECORD_BYTES};})());
      if(result.length<limit+1&&!truncated){
        const edges=db!.prepare(`WITH bounded AS (
          SELECT id AS source_id,from_node_id,to_node_id,relation_type,attributes_json,
            length(CAST(id AS BLOB))+length(CAST(from_node_id AS BLOB))+length(CAST(to_node_id AS BLOB))+length(CAST(relation_type AS BLOB))+length(CAST(attributes_json AS BLOB)) record_bytes
          FROM edges WHERE project_id=? AND environment=?
        ) SELECT CASE WHEN record_bytes<=? THEN source_id ELSE NULL END id,
          CASE WHEN record_bytes<=? THEN from_node_id ELSE NULL END from_node_id,
          CASE WHEN record_bytes<=? THEN to_node_id ELSE NULL END to_node_id,
          CASE WHEN record_bytes<=? THEN relation_type ELSE NULL END relation_type,
          CASE WHEN record_bytes<=? THEN attributes_json ELSE NULL END attributes_json,record_bytes
          FROM bounded ORDER BY source_id LIMIT ?`).iterate(project,environment,MAX_RECORD_BYTES,MAX_RECORD_BYTES,MAX_RECORD_BYTES,MAX_RECORD_BYTES,MAX_RECORD_BYTES,limit+1-result.length) as Iterable<{id:string|null;from_node_id:string|null;to_node_id:string|null;relation_type:string|null;attributes_json:string|null;record_bytes:number}>;
        collect((function*(){for(const row of edges)yield{kind:'edge',id:row.id??'',from_node_id:row.from_node_id??'',to_node_id:row.to_node_id??'',relation_type:row.relation_type??'',attributes_json:row.attributes_json??'',oversize:row.record_bytes>MAX_RECORD_BYTES};})());
      }
      const hasMore=result.length>limit;return{rows:result.slice(0,limit).map(row=>{
        if(row.oversize)return undefined;
        try{
          const attributes=JSON.parse(row.attributes_json);
          if(row.kind==='node')return{kind:'node',record:{id:row.id,type:row.type,stable_key:row.stable_key,display_name:row.display_name,attributes,payloadHash:hashBackfillNode({type:row.type,stable_key:row.stable_key,display_name:row.display_name,attributes}),redactedHash:''}} as Row;
          return{kind:'edge',record:{id:row.id,from_id:row.from_node_id,to_id:row.to_node_id,relation:row.relation_type,attributes,payloadHash:hashBackfillEdge({from_id:row.from_node_id,to_id:row.to_node_id,relation:row.relation_type,attributes}),redactedHash:''}} as Row;
        }catch{return undefined;}
      }),truncated:hasMore||truncated};
    });
    return tx();
  }catch{throw fail();}finally{db?.close();}
}
async function currentState(filename:string,project:string,environment:string,item:Row,pipeline:string,redactedHash:string,mode:JournalMode):Promise<{payloadHash:string;unchanged:boolean}|undefined>{
  await assertSafeWalFiles(filename,mode);
  let db:Database.Database|undefined;
  try{
    db=openReadOnly(filename,mode);
    const tx=db.transaction(()=>{
      let payloadHash:string|undefined;
      if(item.kind==='node'){
        const row=db!.prepare(`SELECT CASE WHEN length(CAST(type AS BLOB))<=? THEN type ELSE NULL END type,
          CASE WHEN length(CAST(stable_key AS BLOB))<=? THEN stable_key ELSE NULL END stable_key,
          CASE WHEN length(CAST(display_name AS BLOB))<=? THEN display_name ELSE NULL END display_name,
          CASE WHEN length(CAST(attributes_json AS BLOB))<=? THEN attributes_json ELSE NULL END attributes_json,
          length(CAST(attributes_json AS BLOB)) attr_bytes,length(CAST(type AS BLOB))+length(CAST(stable_key AS BLOB))+length(CAST(display_name AS BLOB)) fields_bytes
          FROM nodes WHERE project_id=? AND environment=? AND id=?`).get(MAX_RECORD_BYTES,MAX_RECORD_BYTES,MAX_RECORD_BYTES,MAX_RECORD_BYTES,project,environment,item.record.id) as {type:string|null;stable_key:string|null;display_name:string|null;attributes_json:string|null;attr_bytes:number;fields_bytes:number}|undefined;
        if(row&&row.attr_bytes+row.fields_bytes<=MAX_RECORD_BYTES&&row.attributes_json!==null&&row.type!==null&&row.stable_key!==null&&row.display_name!==null){
          try{const attributes=JSON.parse(row.attributes_json);payloadHash=hashBackfillNode({type:row.type,stable_key:row.stable_key,display_name:row.display_name,attributes});}catch{return undefined;}
        }
      }else{
        const row=db!.prepare(`SELECT CASE WHEN length(CAST(from_node_id AS BLOB))<=? THEN from_node_id ELSE NULL END from_node_id,
          CASE WHEN length(CAST(to_node_id AS BLOB))<=? THEN to_node_id ELSE NULL END to_node_id,
          CASE WHEN length(CAST(relation_type AS BLOB))<=? THEN relation_type ELSE NULL END relation_type,
          CASE WHEN length(CAST(attributes_json AS BLOB))<=? THEN attributes_json ELSE NULL END attributes_json,
          length(CAST(attributes_json AS BLOB)) attr_bytes,length(CAST(from_node_id AS BLOB))+length(CAST(to_node_id AS BLOB))+length(CAST(relation_type AS BLOB)) fields_bytes
          FROM edges WHERE project_id=? AND environment=? AND id=?`).get(MAX_RECORD_BYTES,MAX_RECORD_BYTES,MAX_RECORD_BYTES,MAX_RECORD_BYTES,project,environment,item.record.id) as {from_node_id:string|null;to_node_id:string|null;relation_type:string|null;attributes_json:string|null;attr_bytes:number;fields_bytes:number}|undefined;
        if(row&&row.attr_bytes+row.fields_bytes<=MAX_RECORD_BYTES&&row.attributes_json!==null&&row.from_node_id!==null&&row.to_node_id!==null&&row.relation_type!==null){
          try{const attributes=JSON.parse(row.attributes_json);payloadHash=hashBackfillEdge({from_id:row.from_node_id,to_id:row.to_node_id,relation:row.relation_type,attributes});}catch{return undefined;}
        }
      }
      if(!payloadHash)return undefined;
      const processed=Boolean(db!.prepare(`SELECT 1 FROM memory_backfill_items i JOIN memory_backfill_jobs j
        ON j.project_id=i.project_id AND j.environment=i.environment AND j.id=i.job_id
        WHERE i.project_id=? AND i.environment=? AND j.pipeline_fingerprint=? AND i.entity_kind=? AND i.entity_id=?
          AND i.payload_hash=? AND i.redacted_hash=? AND i.status='processed' LIMIT 1`).get(project,environment,pipeline,item.kind,item.record.id,payloadHash,redactedHash));
      return{payloadHash,unchanged:processed};
    });
    return tx();
  }catch{throw fail();}finally{db?.close();}
}
export async function previewMemoryReindex(filename:string,project:string,environment:string,limit:number,analyzer:PreviewAnalyzer):Promise<MemoryPreviewSummary>{
  if(!Number.isInteger(limit)||limit<1||limit>1000)throw fail();
  const journalMode=await assertSafeWalFiles(filename);
  const snapshot=buildRows(filename,project,environment,limit,journalMode);
  const summary:MemoryPreviewSummary={scanned:0,would_migrate:0,would_merge:0,rejected:0,stale:0,failed:0,unchanged:0,scan_limit:limit,truncated:snapshot.truncated};
  try{await analyzer.ensureReady();}catch{await analyzer.close();throw fail();}
  try{
    const pipeline=await analyzer.pipelineFingerprint();if(!/^[a-f0-9]{64}$/.test(pipeline))throw fail();
    for(const item of snapshot.rows){summary.scanned++;if(!item){summary.rejected++;continue;}let analyzed:string|undefined;
      try{analyzed=item.kind==='node'?await analyzer.analyzeNode(item.record):await analyzer.analyzeEdge(item.record);}catch{summary.failed++;continue;}
      if(!/^[a-f0-9]{64}$/.test(analyzed)){summary.rejected++;continue;}
      let latest:{payloadHash:string;unchanged:boolean}|undefined;
      try{latest=await currentState(filename,project,environment,item,pipeline,analyzed,journalMode);}catch{summary.failed++;continue;}
      if(!latest||latest.payloadHash!==item.record.payloadHash){summary.stale++;continue;}
      if(latest.unchanged)summary.unchanged++;else summary.would_migrate++;
    }
  }finally{await analyzer.close();}
  return summary;
}
