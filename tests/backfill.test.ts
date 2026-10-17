import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/memory/store.js';
import {backfillMemory} from '../src/memory/backfill.js';
import {runFixtureSql,testLearningWriter} from './helpers/learning.js';

async function seedLegacyGraph(store:Store,filename:string){
  const app=store.applicationSubject()!.id;
  runFixtureSql(filename,"INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES('legacy-note',? ,?,'note','legacy-note','legacy-note','Old note','{\"private\":\"BACKFILL_SENTINEL\",\"summary\":\"keep\"}','agent','proposed',0.5)",store.projectId,store.memoryEnvironment);
  runFixtureSql(filename,"INSERT INTO edges(id,project_id,environment,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,stable_key) VALUES('legacy-edge',?,?,?,'legacy-note','MENTIONS','{\"private\":\"EDGE_SENTINEL\"}','agent','proposed','legacy-edge')",store.projectId,store.memoryEnvironment,app);
}

test('memory backfill is redacted, durable, resumable, idempotent, and scoped',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-backfill-')),filename=path.join(dir,'memory.sqlite');
  const staging=new Store(filename,'backfill-project','staging');let production:Store|undefined;
  try{
    await seedLegacyGraph(staging,filename);
    const inputs:string[]=[],writer=testLearningWriter(staging,{inputs,sensitivePaths:['/attributes/private']});
    const first=await backfillMemory(staging,writer,{batchSize:1});
    assert.equal(first.status,'completed');assert.equal(first.total,3);assert.equal(first.processed,3);assert.equal(first.pending,0);
    assert.equal(inputs.length,3);assert(inputs.every(input=>!input.includes('BACKFILL_SENTINEL')&&!input.includes('EDGE_SENTINEL')));
    const node=staging.get('legacy-note') as any,edge=(staging.listEdges() as any[]).find(row=>row.id==='legacy-edge') as any;
    assert.equal(node.id,'legacy-note');assert.equal(node.display_name,'Old note');assert.equal(JSON.stringify(node.attributes_json).includes('BACKFILL_SENTINEL'),false);
    assert.equal(JSON.stringify(edge.attributes_json).includes('EDGE_SENTINEL'),false);
    const repeat=await backfillMemory(staging,writer,{batchSize:1});
    assert.equal(repeat.jobId,first.jobId);assert.equal(repeat.status,'completed');assert.equal(repeat.processed,3);assert.equal(inputs.length,3,'completed rows are not sent through NLP twice');
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
    await assert.rejects(()=>backfillMemory(store!,failedWriter,{batchSize:1}),/Memory backfill failed safely/);
    const interrupted=store.db.prepare("SELECT id FROM memory_backfill_jobs WHERE project_id=? AND environment='legacy'").get('resume-project') as {id:string};
    const status=store.memoryBackfillSummary(interrupted.id);assert.equal(status.status,'interrupted');assert.equal(status.total,3);assert.equal(status.processed,1);assert.equal(status.pending,2);
    const inputs:string[]=[],resumed=await backfillMemory(store,testLearningWriter(store,{inputs}),{batchSize:1});
    assert.equal(resumed.jobId,interrupted.id);assert.equal(resumed.status,'completed');assert.equal(resumed.processed,3);assert.equal(resumed.pending,0);assert.equal(inputs.length,2,'only the rows not atomically committed before interruption are reprocessed');
    assert.deepEqual(store.db.pragma('foreign_key_check'),[]);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('backfill detects content changed during NLP and retries the current version',async()=>{
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
    assert.equal(summary.status,'completed');assert.equal(summary.pending,0);assert.equal(targetAnalyses,2,'stale NLP output is discarded and reprocessed against the changed payload');
    const node=store.get('race-note') as any;
    assert.equal(JSON.parse(node.attributes_json).summary,'after');
    const item=store.db.prepare("SELECT status FROM memory_backfill_items WHERE project_id=? AND environment='legacy' AND job_id=? AND entity_kind='node' AND entity_id='race-note'").get('race-project',summary.jobId) as {status:string};
    assert.equal(item.status,'processed');
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('production CLI exposes the backfill command but refuses writes before the Phase 1C release gate',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-backfill-cli-')),config=path.join(dir,'umb.config.yaml'),database=path.join(dir,'memory.sqlite');
  try{
    await writeFile(config,`version: 1\nproject: {id: backfill-cli, name: Backfill CLI, base_url: http://127.0.0.1:3000}\nmemory: {database: ${database}}\n`);
    const result=spawnSync(process.execPath,['--import','tsx',path.resolve('src/cli/index.ts'),'memory','backfill','--config',config],{cwd:process.cwd(),encoding:'utf8',timeout:30000});
    assert.notEqual(result.status,0);assert.match(result.stderr,/disabled until the Phase 1 offline release gate passes/);
    await assert.rejects(stat(database),{code:'ENOENT'});
  }finally{await rm(dir,{recursive:true,force:true});}
});
