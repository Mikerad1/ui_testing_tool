import { createHash } from 'node:crypto';
import { comparePngs } from '../desktop/png-diff.js';
import type { BaselineReadRequest, BaselineRequest, BaselineResult, ComparisonRequest, ComparisonResult, FindingInput, FindingResult, FindingUpdate, FindingsQuery, FindingsResult, ScreenshotRequest, ScreenshotResult } from './adapter.js';

export type VisualArtifact={ref:string;sha256:string;bytes:number};
/** Deliberately narrow persistence boundary; Store remains the only implementation. */
export interface VisualRepository {
  saveBaseline(input:Record<string,unknown>):Record<string,unknown>;
  getBaseline(key:string,revision?:number):Record<string,unknown>|null;
  createComparison(input:Record<string,unknown>):Record<string,unknown>;
  getComparison(id:string):Record<string,unknown>|null;
  createFinding(input:Record<string,unknown>):Record<string,unknown>;
  listFindings(query:FindingsQuery):Record<string,unknown>[];
  updateFinding(input:Record<string,unknown>):Record<string,unknown>;
  readArtifact(ref:string,sha256:string,bytes:number):Promise<Buffer>;
  writeArtifact(bytes:Buffer):Promise<VisualArtifact>;
  removeArtifact(ref:string):Promise<void>;
}
export type VisualCapture=(request:ScreenshotRequest)=>Promise<ScreenshotResult>;
export class VisualWorkflowError extends Error {constructor(readonly code:'REVISION_CONFLICT'|'PERSISTENCE_ERROR'|'CAPABILITY_UNAVAILABLE'|'REMOTE_COMMAND_FAILED',message:string){super(`${code}: ${message}`);this.name='VisualWorkflowError';}}

export class VisualWorkflow {
  constructor(private repository:VisualRepository,private capture:VisualCapture){}
  takeScreenshot(request:ScreenshotRequest){return this.capture(request);}
  async createBaseline(request:BaselineRequest):Promise<BaselineResult>{
    const latest=this.repository.getBaseline(request.baselineKey);
    if(latest&&(request.replace!==true||request.expectedRevision!==latest.revision))throw new VisualWorkflowError('REVISION_CONFLICT','replacing a baseline requires replace=true and its current expected revision');
    if(!latest&&(request.replace===true||request.expectedRevision!==undefined))throw new VisualWorkflowError('REVISION_CONFLICT','a new baseline cannot specify replacement confirmation or expected revision');
    const shot=await this.capture({kind:request.captureKind,profile:request.profile}),ref=shot.artifactRef;
    try{await this.repository.readArtifact(ref,shot.sha256,shot.bytes);return{...this.repository.saveBaseline({baselineKey:request.baselineKey,captureKind:request.captureKind,profile:request.profile??{},artifact:{ref,sha256:shot.sha256,bytes:shot.bytes},width:shot.width,height:shot.height,approval_attestation:request.approval_attestation,...(request.replace!==undefined?{replace:request.replace}:{}),...(request.expectedRevision!==undefined?{expectedRevision:request.expectedRevision}:{})}),image:shot.image};}
    catch(error){return this.rollback(error,[ref]);}
  }
  async readBaseline(request:BaselineReadRequest):Promise<BaselineResult>{const baseline=this.repository.getBaseline(request.baselineKey,request.revision);if(!baseline)throw Error('Baseline not found');try{const image=await this.repository.readArtifact(String(baseline.artifact_ref),String(baseline.artifact_sha256),Number(baseline.artifact_bytes));return{...baseline,image};}catch{throw new VisualWorkflowError('PERSISTENCE_ERROR','baseline artifact verification failed');}}
  async compareWithBaseline(request:ComparisonRequest):Promise<ComparisonResult>{
    const baseline=this.repository.getBaseline(request.baselineKey);if(!baseline)throw Error('Baseline not found');
    if(baseline.capture_kind!==request.captureKind||String(baseline.profile_json)!==stableJson(request.profile??{}))throw Error('Comparison capture kind and profile must exactly match the latest baseline');
    const before=await this.repository.readArtifact(String(baseline.artifact_ref),String(baseline.artifact_sha256),Number(baseline.artifact_bytes));
    const shot=await this.capture({kind:request.captureKind,profile:request.profile});let afterRef='',diffRef='';
    try{
      const after=await this.repository.readArtifact(shot.artifactRef,shot.sha256,shot.bytes);afterRef=shot.artifactRef;
      const result=comparePngs(before,after,{threshold:request.threshold??0});const diff=await this.repository.writeArtifact(result.diff);diffRef=diff.ref;await this.repository.readArtifact(diff.ref,diff.sha256,diff.bytes);
      const comparison=this.repository.createComparison({baselineKey:request.baselineKey,baselineRevision:Number(baseline.revision),captureKind:request.captureKind,profile:request.profile??{},after:{ref:shot.artifactRef,sha256:shot.sha256,bytes:shot.bytes},diff,metrics:result.metrics,findingIds:request.findingIds});
      return{comparison,baseline_ref:baseline.artifact_ref,after_ref:shot.artifactRef,diff_ref:diff.ref,metrics:result.metrics,imageBundle:[{name:'baseline',bytes:before},{name:'after',bytes:after},{name:'diff',bytes:result.diff}]};
    }catch(error){return this.rollback(error,[afterRef,diffRef,shot.artifactRef]);}
  }
  async listFindings(query:FindingsQuery):Promise<FindingsResult>{return this.repository.listFindings(query);}
  async createFinding(input:FindingInput):Promise<FindingResult>{await this.repository.readArtifact(input.screenshotRef,input.screenshotSha256,input.screenshotBytes);return this.repository.createFinding({screen:input.screen,severity:input.severity,confidence:input.confidence,category:input.category,observedIssue:input.observedIssue,screenshot:{ref:input.screenshotRef,sha256:input.screenshotSha256,bytes:input.screenshotBytes},...(input.region?{region:input.region}:{}),...(input.selector?{selector:input.selector}:{}),...(input.remediation?{remediation:input.remediation}:{}),...(input.verificationMethod?{verificationMethod:input.verificationMethod}:{})});}
  async updateFinding(input:FindingUpdate&{expectedVersion:number}):Promise<FindingResult>{if(input.status==='resolved'){if(!input.comparisonId||!input.assessment)throw Error('Resolution requires a linked comparison and caller-reported assessment');const comparison=this.repository.getComparison(input.comparisonId);if(!comparison||!Array.isArray(comparison.finding_ids)||!comparison.finding_ids.includes(input.id))throw Error('The supplied comparison is not linked to this finding');const baseline=this.repository.getBaseline(String(comparison.baseline_key),Number(comparison.baseline_revision));if(!baseline)throw Error('Comparison baseline evidence record is missing');await this.repository.readArtifact(String(baseline.artifact_ref),String(baseline.artifact_sha256),Number(baseline.artifact_bytes));await this.repository.readArtifact(String(comparison.after_ref),String(comparison.after_sha256),Number(comparison.after_bytes));await this.repository.readArtifact(String(comparison.diff_ref),String(comparison.diff_sha256),Number(comparison.diff_bytes));}
    try{return this.repository.updateFinding({id:input.id,expectedVersion:input.expectedVersion,status:input.status,...(input.note!==undefined?{note:input.note}:{}),...(input.assessment!==undefined?{assessment:input.assessment}:{}),...(input.comparisonId!==undefined?{comparisonId:input.comparisonId}:{})});}catch(error){if(error instanceof Error&&/revision_conflict/i.test(error.message))throw new VisualWorkflowError('REVISION_CONFLICT','finding changed since it was read');throw new VisualWorkflowError('PERSISTENCE_ERROR','finding transition could not be persisted');}}
  private async rollback(error:unknown,refs:string[]):Promise<never>{const failures:unknown[]=[];for(const ref of [...new Set(refs.filter(Boolean))])try{await this.repository.removeArtifact(ref);}catch(e){failures.push(e);}if(failures.length){const original=error instanceof Error?error.message:'visual operation failed',cleanup=failures.map(e=>e instanceof Error?e.message:'cleanup failed').join('; ');throw new VisualWorkflowError('PERSISTENCE_ERROR',`${original}; artifact rollback failed: ${cleanup}`);}if(error instanceof VisualWorkflowError)throw error;if(error instanceof Error&&/revision_conflict/i.test(error.message))throw new VisualWorkflowError('REVISION_CONFLICT','visual revision changed concurrently');throw new VisualWorkflowError('PERSISTENCE_ERROR','visual persistence operation failed');}
}
function stableJson(input:unknown):string{const sort=(value:any):any=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])])):value;return JSON.stringify(sort(input??{}));}
export function artifactSha256(bytes:Buffer){return createHash('sha256').update(bytes).digest('hex');}
