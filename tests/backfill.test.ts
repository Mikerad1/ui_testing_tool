import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {Store} from '../src/memory/store.js';
import {backfillMemory} from '../src/memory/backfill.js';
import {runFixtureSql,testLearningWriter} from './helpers/learning.js';

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
    await assert.rejects(()=>backfillMemory(store!,failedWriter,{batchSize:1}),/Memory backfill failed safely/);
    const interrupted=store.db.prepare("SELECT id FROM memory_backfill_jobs WHERE project_id=? AND environment='legacy'").get('resume-project') as {id:string};
    const status=store.memoryBackfillSummary(interrupted.id);assert.equal(status.status,'interrupted');assert.equal(status.total,3);assert.equal(status.processed,1);assert.equal(status.pending,2);
    assert.equal(store.listCandidateObservations({source_kind:'backfill_edge'}).length,1);
    assert.equal(store.listCandidateObservations({source_kind:'backfill_node'}).some(row=>row.source_key==='node:resume-note'),false);
    const inputs:string[]=[],resumed=await backfillMemory(store,testLearningWriter(store,{inputs}),{batchSize:1});
    assert.equal(resumed.jobId,interrupted.id);assert.equal(resumed.status,'completed');assert.equal(resumed.processed,3);assert.equal(resumed.pending,0);assert.equal(inputs.length,2,'only the rows not atomically committed before interruption are reprocessed');
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

test('production CLI keeps bulk backfill disabled even when ordinary learning writes are enabled',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-backfill-cli-')),config=path.join(dir,'umb.config.yaml'),database=path.join(dir,'memory.sqlite');
  try{
    await writeFile(config,`version: 1\nproject: {id: backfill-cli, name: Backfill CLI, base_url: http://127.0.0.1:3000}\nmemory: {database: ${database}}\n`);
    const result=spawnSync(process.execPath,['--import','tsx',path.resolve('src/cli/index.ts'),'memory','backfill','--config',config],{cwd:process.cwd(),encoding:'utf8',timeout:30000});
    assert.notEqual(result.status,0);assert.match(result.stderr,/bulk rewriting existing records has not been authorized/);
    await assert.rejects(stat(database),{code:'ENOENT'});
  }finally{await rm(dir,{recursive:true,force:true});}
});
