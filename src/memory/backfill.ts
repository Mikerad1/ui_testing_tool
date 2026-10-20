import {BackfillRecordReadError,type Store} from './store.js';
import {BackfillRejectedError, type LearningWriter} from './learning-writer.js';
import type {BackfillInvocationSummary,BackfillSummary} from './backfill-types.js';

export class MemoryBackfillError extends Error {
  constructor(readonly summary:BackfillSummary,readonly failureScope:'item'|'invocation'){super('Memory backfill failed safely');this.name='MemoryBackfillError';}
}
class BackfillAccountingError extends Error { constructor(){super('Backfill accounting invariant failed');this.name='BackfillAccountingError';} }
const counters=():BackfillInvocationSummary=>({scanned:0,migrated:0,merged:0,rejected:0,stale:0,failed:0,unchanged:0});
const withUnchanged=(summary:BackfillSummary,invocation:BackfillInvocationSummary):BackfillSummary=>{
  if(summary.processed<invocation.migrated)throw new BackfillAccountingError();
  invocation.unchanged=summary.processed-invocation.migrated;
  invocation.scanned+=invocation.unchanged;
  return{...summary,invocation:{...invocation}};
};

export async function backfillMemory(store:Store,writer:LearningWriter,options:{batchSize?:number}={}):Promise<BackfillSummary>{
  writer.assertBackfillEnabled();
  // Readiness failures happen before a durable job exists and carry no invocation summary.
  await writer.ensureReady();
  const fingerprint=await writer.pipelineFingerprint(),jobId=store.beginMemoryBackfill(fingerprint),batchSize=Math.max(1,Math.min(50,Math.trunc(options.batchSize??10)));
  const invocation=counters();
  try{
    let offset=0;
    for(;;){
      const records=store.memoryBackfillRecords(jobId,offset,batchSize);
      if(records.length===0)break;
      const hashes=[];
      for(const item of records){
        try{
          const redactedHash=item.kind==='node'?await writer.previewBackfillNode(item.record):await writer.previewBackfillEdge(item.record);
          hashes.push({entityKind:item.kind,entityId:item.record.id,redactedHash});
          // The durable processed status is cleared by the hash update when the
          // current redacted hash differs; unchanged counts are derived at exit.
        }catch(error){
          store.markMemoryBackfillPending(jobId,{entityKind:item.kind,entityId:item.record.id});
          if(!(error instanceof BackfillRejectedError)){
            // Persist completed previews from this page before deriving unchanged
            // from durable processed totals; the failed item remains pending.
            store.setMemoryBackfillRedactedHashes(jobId,hashes);
            invocation.scanned++;invocation.failed++;
            store.interruptMemoryBackfill(jobId);
            throw new MemoryBackfillError(withUnchanged(store.memoryBackfillSummary(jobId,invocation),invocation),'item');
          }
        }
      }
      store.setMemoryBackfillRedactedHashes(jobId,hashes);offset+=records.length;
    }
    let cursor:{entityKind:'node'|'edge';entityId:string}|undefined;
    for(;;){
      store.refreshMemoryBackfill(jobId);
      const batch=store.memoryBackfillBatch(jobId,batchSize,cursor);
      if(batch.length===0){if(store.memoryBackfillSummary(jobId,invocation).processed<invocation.migrated)throw new BackfillAccountingError();return withUnchanged(store.finishMemoryBackfill(jobId,invocation),invocation);}
      for(const item of batch){
        cursor={entityKind:item.kind,entityId:item.record.id};
        invocation.scanned++;
        try{
          const committed=item.kind==='node'?await writer.reprocessBackfillNode(jobId,item.record):await writer.reprocessBackfillEdge(jobId,item.record);
          if(committed)invocation.migrated++;else invocation.stale++;
        }catch(error){
          if(error instanceof BackfillRejectedError){invocation.rejected++;continue;}
          invocation.failed++;
          store.interruptMemoryBackfill(jobId);
          throw new MemoryBackfillError(withUnchanged(store.memoryBackfillSummary(jobId,invocation),invocation),'item');
        }
      }
    }
  }catch(error){
    if(error instanceof MemoryBackfillError)throw error;
    store.interruptMemoryBackfill(jobId);
    if(error instanceof BackfillAccountingError)throw error;
    if(error instanceof BackfillRecordReadError){invocation.scanned++;invocation.failed++;throw new MemoryBackfillError(withUnchanged(store.memoryBackfillSummary(jobId,invocation),invocation),'item');}
    throw new MemoryBackfillError(withUnchanged(store.memoryBackfillSummary(jobId,invocation),invocation),'invocation');
  }
}
