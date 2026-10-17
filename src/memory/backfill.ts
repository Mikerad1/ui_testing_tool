import type {Store} from './store.js';
import type {LearningWriter} from './learning-writer.js';
import type {BackfillSummary} from './backfill-types.js';

export async function backfillMemory(store:Store,writer:LearningWriter,options:{batchSize?:number}={}):Promise<BackfillSummary>{
  await writer.ensureReady();
  const fingerprint=await writer.pipelineFingerprint(),jobId=store.beginMemoryBackfill(fingerprint),batchSize=Math.max(1,Math.min(50,Math.trunc(options.batchSize??10)));
  try{
    let offset=0;
    for(;;){
      const records=store.memoryBackfillRecords(jobId,offset,batchSize);
      if(records.length===0)break;
      const hashes=[];
      for(const item of records){
        const redactedHash=item.kind==='node'?await writer.previewBackfillNode(item.record):await writer.previewBackfillEdge(item.record);
        hashes.push({entityKind:item.kind,entityId:item.record.id,redactedHash});
      }
      store.setMemoryBackfillRedactedHashes(jobId,hashes);offset+=records.length;
    }
    for(;;){
      store.refreshMemoryBackfill(jobId);
      const batch=store.memoryBackfillBatch(jobId,batchSize);
      if(batch.length===0)return store.finishMemoryBackfill(jobId);
      for(const item of batch){
        if(item.kind==='node')await writer.reprocessBackfillNode(jobId,item.record);
        else await writer.reprocessBackfillEdge(jobId,item.record);
      }
    }
  }catch{
    store.interruptMemoryBackfill(jobId);
    throw new Error('Memory backfill failed safely');
  }
}
