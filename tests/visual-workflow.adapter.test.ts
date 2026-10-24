import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopAdapter} from '../src/browser/desktop-adapter.js';
import {PlaywrightBrowserAdapter} from '../src/browser/controller.js';
import {VisualWorkflow,type VisualArtifact,type VisualRepository} from '../src/browser/visual-workflow.js';
import type {ScreenshotRequest,ScreenshotResult} from '../src/browser/adapter.js';
import type {Config} from '../src/config/config.js';
import {Store} from '../src/memory/store.js';

function crc32(data:Buffer){let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;}
function png(color:[number,number,number]){const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length,0);type.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([type,data])),8+data.length);return out;};const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,...color]))),chunk('IEND',Buffer.alloc(0))]);}
class MemoryVisualRepository implements VisualRepository{
  artifacts=new Map<string,Buffer>();baselines=new Map<string,Record<string,unknown>>();findings=new Map<string,Record<string,any>>();comparisons=new Map<string,Record<string,any>>();
  saveBaseline(input:Record<string,any>){const old=this.getBaseline(input.baselineKey);if(old&&(input.replace!==true||input.expectedRevision!==old.revision))throw Error('REVISION_CONFLICT');const revision=old?Number(old.revision)+1:1,record={...input,revision,capture_kind:input.captureKind,profile_json:JSON.stringify(input.profile),artifact_ref:input.artifact.ref,artifact_sha256:input.artifact.sha256,artifact_bytes:input.artifact.bytes};this.baselines.set(input.baselineKey,record);return record;}
  getBaseline(key:string,revision?:number){const value=this.baselines.get(key);return value&&(!revision||value.revision===revision)?value:null;}
  createComparison(input:Record<string,any>){const id=randomUUID(),record={id,...input,baseline_key:input.baselineKey,baseline_revision:input.baselineRevision,after_ref:input.after.ref,after_sha256:input.after.sha256,after_bytes:input.after.bytes,diff_ref:input.diff.ref,diff_sha256:input.diff.sha256,diff_bytes:input.diff.bytes,finding_ids:input.findingIds??[]};this.comparisons.set(id,record);return record;}
  getComparison(id:string){return this.comparisons.get(id)??null;}
  createFinding(input:Record<string,any>){const id=randomUUID(),record={id,...input,status:'open',state_version:1,screenshot_ref:input.screenshot.ref,screenshot_sha256:input.screenshot.sha256,screenshot_bytes:input.screenshot.bytes};this.findings.set(id,record);return record;}
  listFindings(query:any){return[...this.findings.values()].filter(f=>!query.status||f.status===query.status).slice(0,query.limit??100);}
  updateFinding(input:Record<string,any>){const old=this.findings.get(input.id);if(!old)throw Error('not found');if(old.state_version!==input.expectedVersion)throw Error('REVISION_CONFLICT');const next={...old,...input,status:input.status,state_version:old.state_version+1};this.findings.set(input.id,next);return next;}
  async readArtifact(ref:string,sha256:string,bytes:number){const data=this.artifacts.get(ref);if(!data||data.length!==bytes||createHash('sha256').update(data).digest('hex')!==sha256)throw Error('PERSISTENCE_ERROR');return data;}
  async writeArtifact(data:Buffer):Promise<VisualArtifact>{const ref=`.umb-managed/desktop/${randomUUID()}.png`;this.artifacts.set(ref,data);return{ref,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length};}
  async removeArtifact(ref:string){this.artifacts.delete(ref);}
}
class StoreVisualRepository extends MemoryVisualRepository{
  constructor(private store:Store){super();}
  override saveBaseline(input:Record<string,any>){return this.store.saveDesktopBaseline(input as any);}
  override getBaseline(key:string,revision?:number){return this.store.getDesktopBaseline(key,revision);}
  override createComparison(input:Record<string,any>){return this.store.createDesktopVisualComparison(input as any);}
  override getComparison(id:string){return this.store.getDesktopComparison(id);}
  override createFinding(input:Record<string,any>){return this.store.createDesktopVisualFinding(input as any);}
  override listFindings(query:any){return this.store.listDesktopVisualFindings(query);}
  override updateFinding(input:Record<string,any>){return this.store.updateDesktopVisualFinding(input as any);}
}

for(const provider of ['browser','desktop'] as const)test(`${provider} adapter exposes shared visual workflows and revision CAS`,async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'umb-visual-contract-'));const config={provider,project:{id:'visual-test',name:'visual test',base_url:'http://127.0.0.1:3000'},browser:{headless:true,viewport:{width:800,height:600},allowed_origins:[]},desktop:{automation:{endpoint:'http://127.0.0.1:4444',session_id:'operator-fixture-session'},window:{screenshot_mode:'webview'},visual:{}},artifacts:{directory:'artifacts'}} as unknown as Config;
  const store=await Store.open(path.join(root,'memory.sqlite'),`visual-test-${provider}`,'local');const repo=new StoreVisualRepository(store),screens=[png([4,5,6]),png([4,5,6]),png([4,5,6]),png([70,80,90])];let index=0;
  const capture=async(_request:ScreenshotRequest):Promise<ScreenshotResult>=>{const image=screens[Math.min(index++,screens.length-1)]!,ref=`.umb-managed/desktop/capture-${index}.png`,sha256=createHash('sha256').update(image).digest('hex');repo.artifacts.set(ref,image);return{artifactPath:ref,artifactRef:ref,sha256,bytes:image.length,width:1,height:1,captureKind:'webview',image};};
  const workflow=new VisualWorkflow(repo,capture);const adapter=provider==='browser'?new PlaywrightBrowserAdapter(config,root):new DesktopAdapter(config,root);(adapter as any).setVisualWorkflow(workflow);
  try{
    assert.deepEqual(adapter.capabilities.screenshotKinds,['webview']);const shot=await adapter.takeScreenshot({kind:'webview'});assert.equal(shot.image?.length,screens[0]!.length);
    const saved=await adapter.createBaseline({baselineKey:`${provider}-baseline`,captureKind:'webview',profile:{viewport:1},approval_attestation:'approved'});assert.equal(saved.revision,1);
    assert.equal((await adapter.readBaseline({baselineKey:`${provider}-baseline`})).revision,1);
    const unchanged=await adapter.compareWithBaseline({baselineKey:`${provider}-baseline`,captureKind:'webview',profile:{viewport:1}});assert.equal((unchanged.metrics as any).changedPixels,0);
    const changed=await adapter.compareWithBaseline({baselineKey:`${provider}-baseline`,captureKind:'webview',profile:{viewport:1}});assert.ok((changed.metrics as any).changedPixels>0);
    const finding=await adapter.createFinding({screen:'fixture',severity:'high',confidence:1,category:'contrast',observedIssue:'test issue',screenshotRef:shot.artifactRef,screenshotSha256:shot.sha256,screenshotBytes:shot.bytes});assert.equal((await adapter.listFindings({})).length,1);
    const updated=await adapter.updateFinding({id:String(finding.id),expectedVersion:1,status:'in_progress'});assert.equal(updated.state_version,2);
    await assert.rejects(adapter.updateFinding({id:String(finding.id),expectedVersion:1,status:'reopened'}),/REVISION_CONFLICT/);
    await assert.rejects(adapter.createBaseline({baselineKey:`${provider}-baseline`,captureKind:'webview',profile:{viewport:1},approval_attestation:'approved'}),/REVISION_CONFLICT/);
  }finally{await adapter.close();store.close();await rm(root,{recursive:true,force:true});}
});
