import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {Store,type DesktopArtifactRecord,type DesktopBaselineRecord,type DesktopComparisonRecord,type DesktopFindingRecord} from '../src/memory/store.js';
import {migrateDesktopVisualLoopV18} from '../src/memory/schema-v18.js';

const artifact=(name:string):DesktopArtifactRecord=>({ref:`.umb-managed/desktop/${name}.png`,sha256:'a'.repeat(64),bytes:1024});
function baseline(override:Partial<DesktopBaselineRecord>={}):DesktopBaselineRecord{return{
  baselineKey:'settings-main',captureKind:'window',profile:{display:'primary'},artifact:artifact('baseline'),width:1200,height:800,approval_attestation:'approved',...override,
};}
function finding(override:Partial<DesktopFindingRecord>={}):DesktopFindingRecord{return{
  screen:'Settings',severity:'high',confidence:0.9,category:'layout',observedIssue:'The save button overlaps the footer.',screenshot:artifact('finding'),...override,
};}
function comparison(override:Partial<DesktopComparisonRecord>={}):DesktopComparisonRecord{return{
  baselineKey:'settings-main',baselineRevision:1,captureKind:'window',profile:{display:'primary'},after:artifact('after'),diff:artifact('diff'),metrics:{changed_pixels:12,threshold:5},...override,
};}

test('schema v18 migration rolls back all DDL when an object conflicts',()=>{
  const database=new Database(':memory:');
  try{
    database.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(17,'v17');
      CREATE TABLE desktop_visual_findings(conflict TEXT);`);
    assert.throws(()=>migrateDesktopVisualLoopV18(database));
    assert.equal((database.prepare('SELECT count(*) count FROM schema_migrations WHERE version=18').get() as {count:number}).count,0);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='desktop_baseline_revisions'").get(),undefined);
  }finally{database.close();}
});

test('v18 visual records are scoped, immutable and use baseline CAS plus finding lifecycle CAS',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-desktop-store-')),filename=path.join(dir,'memory.sqlite');
  let store:Store|undefined,otherEnvironment:Store|undefined,otherProject:Store|undefined;
  try{
    store=await Store.open(filename,'visual-project','local');
    otherEnvironment=await Store.open(filename,'visual-project','staging');
    otherProject=await Store.open(filename,'other-visual-project','local');
    assert.equal((store.db.prepare('SELECT max(version) version FROM schema_migrations').get() as {version:number}).version,18);
    assert.throws(()=>store!.saveDesktopBaseline({...baseline(),approval_attestation:'pending'} as any),/caller approval attestation/);
    assert.throws(()=>store!.saveDesktopBaseline({...baseline(),artifact:{...artifact('bad'),'ref':'../escape.png'}}),/project-root-relative/);
    assert.throws(()=>store!.saveDesktopBaseline({...baseline(),artifact:{...artifact('bad'),'ref':'desktop/bad.png'}}),/project-root-relative/);
    assert.throws(()=>store!.saveDesktopBaseline(baseline({width:8192,height:8192})),/2,097,152 pixel limit/);
    const first=store.saveDesktopBaseline(baseline()) as any;
    assert.equal(first.revision,1);
    assert.throws(()=>store!.saveDesktopBaseline(baseline()),/explicit replacement/);
    assert.throws(()=>store!.saveDesktopBaseline(baseline({replace:true,expectedRevision:9})),/revision_conflict/);
    const second=store.saveDesktopBaseline(baseline({replace:true,expectedRevision:1,artifact:{...artifact('baseline-2'),ref:'artifacts/.umb-managed/desktop/baseline-2.png'}})) as any;
    assert.equal(second.revision,2);
    assert.equal(second.artifact_ref,'artifacts/.umb-managed/desktop/baseline-2.png');
    assert.equal(store.getDesktopBaseline('settings-main',1)?.artifact_ref,artifact('baseline').ref);
    assert.equal(otherEnvironment.getDesktopBaseline('settings-main'),null);
    assert.equal(otherProject.getDesktopBaseline('settings-main'),null);
    assert.throws(()=>store!.db.prepare('UPDATE desktop_baseline_revisions SET width=1 WHERE baseline_key=?').run('settings-main'),/read-only/);

    const reported=store.createDesktopVisualFinding(finding()) as any;
    assert.equal(reported.status,'open');assert.equal(reported.state_version,1);
    const before=store.createDesktopVisualComparison(comparison({baselineRevision:2,findingIds:[reported.id]})) as any;
    otherEnvironment.saveDesktopBaseline(baseline({artifact:artifact('staging-baseline')}));
    otherEnvironment.createDesktopVisualFinding(finding({screenshot:artifact('staging-finding')}));
    otherEnvironment.createDesktopVisualComparison(comparison({after:artifact('staging-after'),diff:artifact('staging-diff')}));
    const refs=store.listDesktopArtifactReferences();
    assert.deepEqual(new Set(refs),new Set([artifact('baseline').ref,'artifacts/.umb-managed/desktop/baseline-2.png',artifact('finding').ref,artifact('after').ref,artifact('diff').ref,artifact('staging-baseline').ref,artifact('staging-finding').ref,artifact('staging-after').ref,artifact('staging-diff').ref]));
    assert.deepEqual(before.finding_ids,[reported.id]);
    assert.throws(()=>store!.updateDesktopVisualFinding({id:reported.id,expectedVersion:1,status:'resolved'}),/assessment/);
    assert.throws(()=>store!.updateDesktopVisualFinding({id:reported.id,expectedVersion:1,status:'resolved',assessment:'Looks fixed',comparisonId:'00000000-0000-4000-8000-000000000001'}),/linked/);
    const resolved=store.updateDesktopVisualFinding({id:reported.id,expectedVersion:1,status:'resolved',assessment:'The agent inspected the linked comparison and confirmed the overlap is absent.',comparisonId:before.id}) as any;
    assert.equal(resolved.status,'resolved');assert.equal(resolved.state_version,2);
    assert.throws(()=>store!.updateDesktopVisualFinding({id:reported.id,expectedVersion:1,status:'reopened'}),/revision_conflict/);
    const reopened=store.updateDesktopVisualFinding({id:reported.id,expectedVersion:2,status:'reopened',note:'Reappeared in the latest review.'}) as any;
    assert.equal(reopened.status,'reopened');assert.equal(reopened.state_version,3);
    assert.equal((reopened.events as any[]).length,3);
    assert.equal(otherEnvironment.getDesktopVisualFinding(reported.id),null);
    assert.equal(otherProject.getDesktopVisualFinding(reported.id),null);
    const closedStore=store;closedStore.close();store=undefined;
    assert.throws(()=>closedStore.listDesktopArtifactReferences());
  }finally{
    store?.close();otherEnvironment?.close();otherProject?.close();
    await rm(dir,{recursive:true,force:true});
  }
});

test('future schema versions are rejected without changing database bytes or schema',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-future-store-')),filename=path.join(dir,'memory.sqlite');
  let store:Store|undefined;
  try{
    store=await Store.open(filename,'future-project','local');store.close();store=undefined;
    const database=new Database(filename);
    try{database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(999,?)').run('future');}finally{database.close();}
    const bytesBefore=await readFile(filename);
    const schemaBefore=(()=>{const db=new Database(filename,{readonly:true});try{return db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();}finally{db.close();}})();
    await assert.rejects(Store.open(filename,'future-project','local'),/newer than this binary/);
    assert.deepEqual(await readFile(filename),bytesBefore);
    const schemaAfter=(()=>{const db=new Database(filename,{readonly:true});try{return db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();}finally{db.close();}})();
    assert.deepEqual(schemaAfter,schemaBefore);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
