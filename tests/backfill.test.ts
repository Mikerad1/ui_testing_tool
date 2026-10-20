import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {Store} from '../src/memory/store.js';
import {backfillMemory} from '../src/memory/backfill.js';
import {previewMemoryReindex,type PreviewAnalyzer} from '../src/memory/reindex-preview.js';
import {hashBackfillNode} from '../src/memory/content-fingerprint.js';
import {memoryBackfillEnabled,persistentLearningWritesEnabled} from '../src/memory/runtime.js';
import {loadConfig} from '../src/config/config.js';
import {runFixtureSql,testLearningWriter} from './helpers/learning.js';

function assertInvocationAccounting(summary:{invocation:{scanned:number;migrated:number;merged:number;rejected:number;stale:number;failed:number;unchanged:number}}){
  const counts=summary.invocation;
  assert.equal(counts.scanned,counts.migrated+counts.merged+counts.rejected+counts.stale+counts.failed+counts.unchanged);
}

async function seedLegacyGraph(store:Store,filename:string){
  const app=store.applicationSubject()!.id;
  runFixtureSql(filename,"INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES('legacy-note',? ,?,'note','legacy-note','legacy-note','Old note','{\"private\":\"BACKFILL_SENTINEL\",\"summary\":\"Home open\"}','agent','proposed',0.5)",store.projectId,store.memoryEnvironment);
  runFixtureSql(filename,"INSERT INTO edges(id,project_id,environment,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,stable_key) VALUES('legacy-edge',?,?,?,'legacy-note','MENTIONS','{\"private\":\"EDGE_SENTINEL\",\"summary\":\"Home\",\"action\":\"open\"}','agent','proposed','legacy-edge')",store.projectId,store.memoryEnvironment,app);
}

test('memory backfill is redacted, durable, resumable, idempotent, and scoped',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-backfill-')),filename=path.join(dir,'memory.sqlite');
  const staging=new Store(filename,'backfill-project','staging');let production:Store|undefined;
  try{
    await seedLegacyGraph(staging,filename);
    const inputs:string[]=[],writer=testLearningWriter(staging,{inputs,sensitivePaths:['/attributes/private'],candidateMentions:true});
    const first=await backfillMemory(staging,writer,{batchSize:1});
    assert.equal(first.status,'completed');assert.equal(first.total,3);assert.equal(first.processed,3);assert.equal(first.pending,0);
    assert.deepEqual(first.invocation,{scanned:3,migrated:3,merged:0,rejected:0,stale:0,failed:0,unchanged:0});
    assertInvocationAccounting(first);
    assert.equal(inputs.length,3);assert(inputs.every(input=>!input.includes('BACKFILL_SENTINEL')&&!input.includes('EDGE_SENTINEL')));
    const node=staging.get('legacy-note') as any,edge=(staging.listEdges() as any[]).find(row=>row.id==='legacy-edge') as any;
    assert.equal(node.id,'legacy-note');assert.equal(node.display_name,'Old note');assert.equal(JSON.stringify(node.attributes_json).includes('BACKFILL_SENTINEL'),false);
    assert.equal(JSON.stringify(edge.attributes_json).includes('EDGE_SENTINEL'),false);
    const nodeObservation=staging.listCandidateObservations({source_kind:'backfill_node'}).find(row=>row.source_key==='node:legacy-note')!;
    const edgeObservation=staging.listCandidateObservations({source_kind:'backfill_edge'}).find(row=>row.source_key==='edge:legacy-edge')!;
    const firstJobFingerprint=(staging.db.prepare('SELECT pipeline_fingerprint FROM memory_backfill_jobs WHERE id=?').get(first.jobId) as any).pipeline_fingerprint;
    assert.equal(nodeObservation.pipeline_fingerprint,firstJobFingerprint);assert.equal(edgeObservation.pipeline_fingerprint,firstJobFingerprint);
    assert.match(nodeObservation.source_revision_hash,/^[a-f0-9]{64}$/);
    assert.equal(nodeObservation.status,'proposed');assert.deepEqual(nodeObservation.links,[]);assert.equal(nodeObservation.extraction_ready,true);
    assert.equal(edgeObservation.status,'proposed');assert.deepEqual(edgeObservation.links,[]);
    for(const observation of [nodeObservation,edgeObservation]){
      assert.equal(JSON.stringify(observation).includes('BACKFILL_SENTINEL'),false);assert.equal(JSON.stringify(observation).includes('EDGE_SENTINEL'),false);
      for(const mention of observation.entities as any[])assert.equal(Array.from(observation.redacted_source_text!).slice(mention.start,mention.end).join(''),mention.text);
    }
    const edgeCandidates=edgeObservation.entities as any[],edgeRelations=edgeObservation.relations as any[];
    assert.equal(edgeRelations[0].from_candidate_id,edgeCandidates[0].id);assert.equal(edgeRelations[0].to_candidate_id,edgeCandidates[1].id);
    assert.equal(Array.from(edgeObservation.redacted_source_text!).slice(edgeRelations[0].evidence.start,edgeRelations[0].evidence.end).join(''),edgeRelations[0].evidence.text);
    const repeat=await backfillMemory(staging,writer,{batchSize:1});
    assert.equal(repeat.jobId,first.jobId);assert.equal(repeat.status,'completed');assert.equal(repeat.processed,3);assert.equal(inputs.length,3,'completed rows are not sent through NLP twice');
    assert.deepEqual(repeat.invocation,{scanned:3,migrated:0,merged:0,rejected:0,stale:0,failed:0,unchanged:3});
    assertInvocationAccounting(repeat);
    assert.equal(staging.listCandidateObservations({source_kind:'backfill_node'}).length,2,'same source/revision/pipeline replay is idempotent');
    const changedWriter=testLearningWriter(staging,{patternsDigest:'c'.repeat(64),modelVersion:'2.0',candidateMentions:true,sensitivePaths:['/attributes/private']});
    const changed=await backfillMemory(staging,changedWriter,{batchSize:1});
    assert.notEqual(changed.jobId,first.jobId);assert.equal(changed.status,'completed');
    const changedJobFingerprint=(staging.db.prepare('SELECT pipeline_fingerprint FROM memory_backfill_jobs WHERE id=?').get(changed.jobId) as any).pipeline_fingerprint;
    assert.notEqual(changedJobFingerprint,firstJobFingerprint);
    assert.equal(staging.listCandidateObservations({source_kind:'backfill_node'}).length,4);
    const versions=staging.listCandidateObservations({source_kind:'backfill_node'}).filter(row=>row.source_key==='node:legacy-note');
    assert.equal(versions.length,2);assert.notEqual(versions[0]!.pipeline_fingerprint,versions[1]!.pipeline_fingerprint);
    production=new Store(filename,'backfill-project','production');
    const productionSummary=await backfillMemory(production,testLearningWriter(production));
    assert.equal(productionSummary.total,1,'another environment only sees its own application anchor');
    assert.equal(production.get('legacy-note'),null);
    assert.deepEqual(production.listEdges(),[]);
  }finally{staging.close();production?.close();await rm(dir,{recursive:true,force:true});}
});

test('interrupted memory backfill resumes pending rows without replaying committed rows',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-backfill-resume-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=new Store(filename,'resume-project');
    const app=store.applicationSubject()!.id;
    runFixtureSql(filename,"INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES('resume-note','resume-project','legacy','note','resume-note','resume-note','Resume note','{}','agent','proposed',0.5)");
    runFixtureSql(filename,"INSERT INTO edges(id,project_id,environment,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,stable_key) VALUES('resume-edge','resume-project','legacy',?,'resume-note','MENTIONS','{}','agent','proposed','resume-edge')",app);
    const failedWriter=testLearningWriter(store,{failAtAnalysis:2});
    let failure:any;try{await backfillMemory(store,failedWriter,{batchSize:1});}catch(error){failure=error;}
    assert.match(failure.message,/Memory backfill failed safely/);assert.equal(failure.failureScope,'item');assert.deepEqual(failure.summary.invocation,{scanned:2,migrated:1,merged:0,rejected:0,stale:0,failed:1,unchanged:0});
    assertInvocationAccounting(failure.summary);
    const interrupted=store.db.prepare("SELECT id FROM memory_backfill_jobs WHERE project_id=? AND environment='legacy'").get('resume-project') as {id:string};
    const status=store.memoryBackfillSummary(interrupted.id);assert.equal(status.status,'interrupted');assert.equal(status.total,3);assert.equal(status.processed,1);assert.equal(status.pending,2);
    assert.equal(store.listCandidateObservations({source_kind:'backfill_edge'}).length,1);
    assert.equal(store.listCandidateObservations({source_kind:'backfill_node'}).some(row=>row.source_key==='node:resume-note'),false);
    const inputs:string[]=[],resumed=await backfillMemory(store,testLearningWriter(store,{inputs}),{batchSize:1});
    assert.equal(resumed.jobId,interrupted.id);assert.equal(resumed.status,'completed');assert.equal(resumed.processed,3);assert.equal(resumed.pending,0);assert.equal(inputs.length,2,'only the rows not atomically committed before interruption are reprocessed');
    assertInvocationAccounting(resumed);
    assert.deepEqual(store.db.pragma('foreign_key_check'),[]);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('backfill empty rules persist normalized-only observations and graph/ledger/item rollback together',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-backfill-observation-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=new Store(filename,'backfill-observation');
    runFixtureSql(filename,"INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES('backfill-empty','backfill-observation','legacy','note','backfill-empty','backfill-empty','Empty rules','{\"value\":\"safe\"}','agent','proposed',0.5)");
    const empty=await backfillMemory(store,testLearningWriter(store,{emptyPatterns:true}),{batchSize:1});
    const observation=store.listCandidateObservations({source_kind:'backfill_node'}).find(row=>row.source_key==='node:backfill-empty')!;
    assert.equal(observation.extraction_ready,false);assert.deepEqual(observation.entities,[]);assert.deepEqual(observation.relations,[]);assert.equal(observation.status,'proposed');
    const original=JSON.parse((store.get('backfill-empty') as any).attributes_json);
    const triggerDb=new Database(filename);triggerDb.exec("CREATE TRIGGER fail_backfill_observation BEFORE INSERT ON memory_candidate_observations WHEN NEW.source_kind='backfill_node' AND NEW.source_key='node:backfill-empty' AND NEW.patterns_digest='"+'d'.repeat(64)+"' BEGIN SELECT RAISE(ABORT,'forced observation failure'); END");triggerDb.close();
    const changedWriter=testLearningWriter(store,{patternsDigest:'d'.repeat(64),emptyPatterns:true});
    await assert.rejects(()=>backfillMemory(store!,changedWriter,{batchSize:1}),/Memory backfill failed safely/);
    const after=JSON.parse((store.get('backfill-empty') as any).attributes_json);
    assert.deepEqual(after,original);
    const failedJob=store.db.prepare("SELECT id,status FROM memory_backfill_jobs WHERE project_id=? AND pipeline_fingerprint<>? ORDER BY created_at DESC LIMIT 1").get('backfill-observation',observation.pipeline_fingerprint) as any;
    assert.equal(store.memoryBackfillSummary(failedJob.id).status,'interrupted');
    assert.equal(store.listCandidateObservations({source_kind:'backfill_node'}).filter(row=>row.source_key==='node:backfill-empty').length,1);
    assert.equal(store.db.prepare("SELECT status FROM memory_backfill_items WHERE project_id=? AND job_id=? AND entity_kind='node' AND entity_id='backfill-empty'").get('backfill-observation',failedJob.id).status,'pending');
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('backfill reports content changed during NLP as stale and resumes next invocation',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-backfill-race-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=new Store(filename,'race-project');
    runFixtureSql(filename,"INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES('race-note','race-project','legacy','note','race-note','race-note','Race note','{\"summary\":\"before\"}','agent','proposed',0.5)");
    let changed=false,targetAnalyses=0;
    const writer=testLearningWriter(store,{onAnalyze(text){
      if(!text.includes('race-note'))return;
      targetAnalyses+=1;
      if(changed)return;
      changed=true;
      runFixtureSql(filename,"UPDATE nodes SET attributes_json='{\"summary\":\"after\"}' WHERE project_id='race-project' AND environment='legacy' AND id='race-note'");
    }});
    const summary=await backfillMemory(store,writer,{batchSize:1});
    assert.equal(summary.status,'running');assert.equal(summary.pending,1);assert.equal(targetAnalyses,1);
    assert.deepEqual(summary.invocation,{scanned:2,migrated:1,merged:0,rejected:0,stale:1,failed:0,unchanged:0});
    assertInvocationAccounting(summary);
    const resumed=await backfillMemory(store,writer,{batchSize:1});
    assert.equal(resumed.status,'completed');assert.equal(resumed.pending,0);assert.equal(targetAnalyses,2,'stale item is retried on the next invocation');
    assertInvocationAccounting(resumed);
    const node=store.get('race-note') as any;
    assert.equal(JSON.parse(node.attributes_json).summary,'after');
    const item=store.db.prepare("SELECT status FROM memory_backfill_items WHERE project_id=? AND environment='legacy' AND job_id=? AND entity_kind='node' AND entity_id='race-note'").get('race-project',summary.jobId) as {status:string};
    assert.equal(item.status,'processed');
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('backfill classifies deterministic redaction rejection separately from item failure',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-backfill-rejected-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=new Store(filename,'rejected-project');
    runFixtureSql(filename,"INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES('oversized-note','rejected-project','legacy','note','oversized-note','oversized-note','Oversized',?,'agent','proposed',0.5)",JSON.stringify({text:'x'.repeat(70_000)}));
    const summary=await backfillMemory(store,testLearningWriter(store),{batchSize:1});
    assert.equal(summary.invocation.rejected,1);assert.equal(summary.invocation.failed,0);assert.equal(summary.invocation.merged,0);assert.equal(summary.invocation.unchanged,0);
    assertInvocationAccounting(summary);
    assert.equal(summary.pending,1,'rejected item remains resumable');
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('backfill reports invocation-scoped read failure without attributing an item',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-backfill-read-failure-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=new Store(filename,'read-failure-project');
    (store as any).memoryBackfillRecords=()=>{throw Error('database page read failed');};
    let failure:any;try{await backfillMemory(store,testLearningWriter(store));}catch(error){failure=error;}
    assert.equal(failure.failureScope,'invocation');assert.equal(failure.summary.status,'interrupted');
    assert.deepEqual(failure.summary.invocation,{scanned:0,migrated:0,merged:0,rejected:0,stale:0,failed:0,unchanged:0});
    assertInvocationAccounting(failure.summary);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('production CLI keeps bulk backfill disabled even when ordinary learning writes are enabled',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-backfill-cli-')),config=path.join(dir,'umb.config.yaml'),database=path.join(dir,'memory.sqlite');
  try{
    assert.equal(memoryBackfillEnabled(),false,'bulk backfill remains separately gated');
    await writeFile(config,`version: 1\nproject: {id: backfill-cli, name: Backfill CLI, base_url: http://127.0.0.1:3000}\nmemory: {database: ${database}, persistent_learning_writes: true}\n`);
    assert.equal(persistentLearningWritesEnabled((await loadConfig(config)).config),true,'the CLI project explicitly opts into ordinary learning writes');
    const result=spawnSync(process.execPath,['--import','tsx',path.resolve('src/cli/index.ts'),'memory','backfill','--config',config],{cwd:process.cwd(),encoding:'utf8',timeout:30000});
    assert.notEqual(result.status,0);assert.match(result.stderr,/bulk rewriting existing records has not been authorized/);
    await assert.rejects(stat(database),{code:'ENOENT'});
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('read-only reindex preview classifies bounded records and leaves project state untouched',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-reindex-preview-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=new Store(filename,'preview-project');
    runFixtureSql(filename,"INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES('preview-current','preview-project','legacy','note','preview-current','preview-current','Current','{}','agent','proposed',0.5),('preview-change','preview-project','legacy','note','preview-change','preview-change','Change','{}','agent','proposed',0.5),('preview-reject','preview-project','legacy','note','preview-reject','preview-reject','Reject','{}','agent','proposed',0.5),('preview-stale','preview-project','legacy','note','preview-stale','preview-stale','Stale','{}','agent','proposed',0.5)");
    const samePipeline='f'.repeat(64),processedHash='c'.repeat(64),payloadHash=hashBackfillNode({type:'note',stable_key:'preview-current',display_name:'Current',attributes:{}});
    runFixtureSql(filename,"INSERT INTO memory_backfill_jobs(id,project_id,environment,pipeline_fingerprint,status,created_at,updated_at) VALUES('preview-job','preview-project','legacy',?,'completed','now','now')",samePipeline);
    runFixtureSql(filename,"INSERT INTO memory_backfill_items(project_id,environment,job_id,entity_kind,entity_id,payload_hash,redacted_hash,status,updated_at) VALUES('preview-project','legacy','preview-job','node','preview-current',?,?,'processed','now')",payloadHash,processedHash);
    const before=store.db.prepare("SELECT (SELECT count(*) FROM memory_backfill_jobs) jobs,(SELECT count(*) FROM memory_backfill_items) items,(SELECT count(*) FROM memory_candidate_observations) observations,(SELECT count(*) FROM nodes) nodes,(SELECT count(*) FROM edges) edges").get();
    const fileState=async()=>{const fs=await import('node:fs/promises'),result=new Map<string,string>();for(const file of [filename,`${filename}-wal`,`${filename}-shm`])try{result.set(path.basename(file),createHash('sha256').update(await fs.readFile(file)).digest('hex'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}return result;};
    const analyzer:PreviewAnalyzer={ensureReady:async()=>{},close:async()=>{},analyzeNode:async record=>{
      if(record.id==='preview-stale')runFixtureSql(filename,"UPDATE nodes SET display_name='Changed during preview' WHERE id='preview-stale'");
      if(record.id==='preview-reject')return 'not-a-hash';
      return record.id==='preview-current'?processedHash:'a'.repeat(64);
    },analyzeEdge:async()=> 'a'.repeat(64),pipelineFingerprint:async()=>samePipeline};
    const summary=await previewMemoryReindex(filename,'preview-project','legacy',20,analyzer);
    assert.deepEqual(summary,{scanned:5,would_migrate:2,would_merge:0,rejected:1,stale:1,failed:0,unchanged:1,scan_limit:20,truncated:false});
    const after=store.db.prepare("SELECT (SELECT count(*) FROM memory_backfill_jobs) jobs,(SELECT count(*) FROM memory_backfill_items) items,(SELECT count(*) FROM memory_candidate_observations) observations,(SELECT count(*) FROM nodes) nodes,(SELECT count(*) FROM edges) edges").get();
    assert.deepEqual(after,before);
    let analyzed=0;
    const bytesBefore=await fileState();
    const limited=await previewMemoryReindex(filename,'preview-project','legacy',1,{...analyzer,analyzeNode:async record=>{analyzed++;return record.payloadHash;}});
    assert.equal(limited.scanned,1);assert.equal(limited.truncated,true);assert.equal(limited.scan_limit,1);assert.equal(analyzed,1);
    assert.deepEqual(await fileState(),bytesBefore,'preview preserves the main database and WAL/SHM bytes');
    const newPipeline=await previewMemoryReindex(filename,'preview-project','legacy',20,{...analyzer,pipelineFingerprint:async()=>'e'.repeat(64),analyzeNode:async record=>record.id==='preview-current'?processedHash:'a'.repeat(64)});
    assert.equal(newPipeline.unchanged,0,'a different analyzer pipeline cannot reuse prior processed status');
    assert.equal(newPipeline.would_migrate,5);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('preview missing database and failed NLP readiness are inert',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-reindex-inert-')),filename=path.join(dir,'missing.sqlite');
  try{
    const analyzer:PreviewAnalyzer={ensureReady:async()=>{},pipelineFingerprint:async()=>'d'.repeat(64),analyzeNode:async()=> 'a'.repeat(64),analyzeEdge:async()=> 'a'.repeat(64),close:async()=>{}};
    await assert.rejects(()=>previewMemoryReindex(filename,'p','legacy',5,analyzer));
    assert.deepEqual(await import('node:fs/promises').then(fs=>fs.readdir(dir)),[]);
    const existing=path.join(dir,'existing.sqlite'),store=new Store(existing,'preview-readiness');
    try{
      const before=store.db.prepare('SELECT count(*) count FROM nodes').get();
      const unavailable:PreviewAnalyzer={...analyzer,ensureReady:async()=>{throw Error('NLP unavailable');}};
      await assert.rejects(()=>previewMemoryReindex(existing,'preview-readiness','legacy',5,unavailable));
      assert.deepEqual(store.db.prepare('SELECT count(*) count FROM nodes').get(),before);
    }finally{store.close();}
    const walDb=path.join(dir,'wal.sqlite'),walStore=new Store(walDb,'preview-wal');walStore.close();
    const header=await import('node:fs/promises').then(fs=>fs.readFile(walDb));assert.equal(header[18],2,'fixture is WAL mode');
    const beforeEntries=(await import('node:fs/promises').then(fs=>fs.readdir(dir))).sort();
    await assert.rejects(()=>previewMemoryReindex(walDb,'preview-wal','legacy',5,analyzer));
    assert.deepEqual((await import('node:fs/promises').then(fs=>fs.readdir(dir))).sort(),beforeEntries);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('preview bounds oversized JSON before parsing or analyzer handoff',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-reindex-huge-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined;
  try{
    store=new Store(filename,'preview-huge');
    runFixtureSql(filename,"INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES('huge-node','preview-huge','legacy','note','huge-node','huge-node','Huge',?,'agent','proposed',0.5)",JSON.stringify({blob:'x'.repeat(100_000)}));
    let analyzed=0;
    const analyzer:PreviewAnalyzer={ensureReady:async()=>{},pipelineFingerprint:async()=>'d'.repeat(64),analyzeNode:async record=>{analyzed++;assert.notEqual(record.id,'huge-node');return 'a'.repeat(64);},analyzeEdge:async()=> 'a'.repeat(64),close:async()=>{}};
    const result=await previewMemoryReindex(filename,'preview-huge','legacy',10,analyzer);
    assert.equal(result.rejected,1);assert.equal(result.scanned,2);assert.equal(analyzed,1);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
