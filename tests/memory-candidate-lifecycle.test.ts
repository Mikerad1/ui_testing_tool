import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {Store} from '../src/memory/store.js';
import {appendLifecycleEvent} from '../src/memory/schema-v15.js';
import {reconcile} from '../src/knowledge/reconcile.js';
import {testWriter} from './helpers/learning.js';
import {runFixtureSql} from './helpers/learning.js';

test('verification accepts only live agent proposals with passing same-scope assertion evidence',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-verify-guard-')),filename=path.join(dir,'memory.sqlite'),knowledge=path.join(dir,'knowledge');let store:Store|undefined,staging:Store|undefined;
  try{
    await mkdir(knowledge);store=await Store.open(filename,'lifecycle-project','local');staging=await Store.open(filename,'lifecycle-project','staging');
    const create=async(key:string)=>await testWriter(store!).propose({observation_id:`proposal-${key}`,type:'screen',stable_key:key,display_name:key}) as any;
    const evidence= (id:string, outcome='passed')=>{const run=store!.createRun();store!.addEvidence({run_id:run,subject_node_id:id,kind:'assertion',outcome});return run;};
    const proposal=await create('eligible');const run=evidence(proposal.id);assert.equal(store.verify(proposal.id,run,{approved:true,source:'local_approver'}),true);assert.equal(store.verify(proposal.id,run,{approved:true,source:'local_approver'}),false,'verified target cannot be verified again');
    const failed=await create('failed');assert.equal(store.verify(failed.id,evidence(failed.id,'failed'),{approved:true,source:'local_approver'}),false);
    const conflicted=await create('conflicted');runFixtureSql(filename,"UPDATE nodes SET conflict_status='conflict' WHERE id=?",conflicted.id);assert.equal(store.verify(conflicted.id,evidence(conflicted.id),{approved:true,source:'local_approver'}),false);
    const stale=await create('stale');runFixtureSql(filename,"UPDATE nodes SET verification_status='stale' WHERE id=?",stale.id);assert.equal(store.verify(stale.id,evidence(stale.id),{approved:true,source:'local_approver'}),false);
    const tombstone=await create('tombstone');runFixtureSql(filename,"UPDATE nodes SET tombstone=1 WHERE id=?",tombstone.id);assert.equal(store.verify(tombstone.id,evidence(tombstone.id),{approved:true,source:'local_approver'}),false);
    await writeFile(path.join(knowledge,'yaml.yaml'),'schema_version: 1\nkind: screen\nid: authored\nname: Authored\nroute: /authored\n');await reconcile(knowledge,store,testWriter(store));const authored=(store.getByTypeKey('screen','authored') as any).id;
    assert.equal(store.verify(authored,evidence(authored),{approved:true,source:'local_approver'}),false,'YAML-owned target is never verified by graph evidence');
    const foreignTarget=await testWriter(staging).propose({observation_id:'foreign-proposal',type:'screen',stable_key:'foreign',display_name:'Foreign'}) as any;const foreignRun=staging.createRun();staging.addEvidence({run_id:foreignRun,subject_node_id:foreignTarget.id,kind:'assertion',outcome:'passed'});assert.equal(store.verify(proposal.id,foreignRun,{approved:true,source:'local_approver'}),false,'foreign environment run is rejected');
  }finally{store?.close();staging?.close();await rm(dir,{recursive:true,force:true});}
});

test('supersede accepts only trusted live agent records and rejects YAML or invalid replacements',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-supersede-guard-')),filename=path.join(dir,'memory.sqlite'),knowledge=path.join(dir,'knowledge');let store:Store|undefined;
  try{
    await mkdir(knowledge);store=await Store.open(filename,'supersede-project','local');
    const create=async(key:string)=>await testWriter(store!).propose({observation_id:`sup-${key}`,type:'screen',stable_key:key,display_name:key}) as any;
    const verify=async(node:any)=>{const run=store!.createRun();store!.addEvidence({run_id:run,subject_node_id:node.id,kind:'assertion',outcome:'passed'});assert.equal(store!.verify(node.id,run,{approved:true,source:'local_approver'}),true);};
    const old=await create('old'),replacement=await create('replacement');await verify(old);await verify(replacement);
    assert.throws(()=>store!.supersede(old.id,old.id),/itself/);assert.throws(()=>store!.supersede('missing',replacement.id),/Old node/);assert.throws(()=>store!.supersede(old.id,'missing'),/Replacement/);
    const proposal=await create('proposal');assert.throws(()=>store!.supersede(proposal.id,replacement.id),/Old node/);assert.throws(()=>store!.supersede(old.id,proposal.id),/Replacement/);
    const conflicted=await create('conflicted');runFixtureSql(filename,"UPDATE nodes SET verification_status='verified',conflict_status='conflict' WHERE id=?",conflicted.id);assert.throws(()=>store!.supersede(conflicted.id,replacement.id),/Old node/);assert.throws(()=>store!.supersede(old.id,conflicted.id),/Replacement/);
    const stale=await create('stale');runFixtureSql(filename,"UPDATE nodes SET verification_status='stale' WHERE id=?",stale.id);assert.throws(()=>store!.supersede(stale.id,replacement.id),/Old node/);
    const tombstone=await create('tombstone');runFixtureSql(filename,"UPDATE nodes SET tombstone=1 WHERE id=?",tombstone.id);assert.throws(()=>store!.supersede(tombstone.id,replacement.id),/Old node/);
    const already=await create('already');runFixtureSql(filename,"UPDATE nodes SET verification_status='verified',tombstone=1,superseded_by=? WHERE id=?",replacement.id,already.id);assert.throws(()=>store!.supersede(already.id,replacement.id),/Old node/);
    await writeFile(path.join(knowledge,'yaml.yaml'),'schema_version: 1\nkind: screen\nid: authored\nname: Authored\nroute: /authored\n');await reconcile(knowledge,store,testWriter(store));const authored=(store.getByTypeKey('screen','authored') as any).id;
    assert.throws(()=>store!.supersede(authored,replacement.id),/Old node/);assert.throws(()=>store!.supersede(old.id,authored),/Replacement/);
    runFixtureSql(filename,"CREATE TRIGGER fail_lifecycle_event BEFORE INSERT ON memory_lifecycle_events BEGIN SELECT RAISE(ABORT,'forced lifecycle event failure'); END");
    assert.throws(()=>store!.supersede(old.id,replacement.id),/forced lifecycle event failure/);
    assert.deepEqual(store.db.prepare('SELECT verification_status,tombstone,superseded_by FROM nodes WHERE id=?').get(old.id),{verification_status:'verified',tombstone:0,superseded_by:null},'failed event append rolls back supersede state');
    assert.equal((store.db.prepare("SELECT count(*) count FROM memory_audit WHERE subject_node_id=? AND action='supersede'").get(old.id) as any).count,0);
    runFixtureSql(filename,'DROP TRIGGER fail_lifecycle_event');
    assert.equal(store.supersede(old.id,replacement.id),true);assert.equal(store.get(old.id),null);assert.equal((store.get(replacement.id) as any).id,replacement.id);
    const oldState=store.db.prepare('SELECT verification_status,tombstone,superseded_by FROM nodes WHERE id=?').get(old.id) as any;
    assert.deepEqual(oldState,{verification_status:'stale',tombstone:1,superseded_by:replacement.id},'superseded facts are no longer current verified facts');
    const event=store.db.prepare('SELECT * FROM memory_lifecycle_events WHERE entity_id=?').get(old.id) as any;
    assert.equal(event.entity_kind,'node');assert.equal(event.action,'superseded');assert.equal(event.from_state,'verified');assert.equal(event.to_state,'stale');assert.equal(event.reason_code,'superseded_by_replacement');assert.equal(event.related_entity_id,replacement.id);
    assert.throws(()=>runFixtureSql(filename,'UPDATE memory_lifecycle_events SET reason_code=? WHERE id=?','legacy_unknown',event.id),/immutable/);
    assert.throws(()=>runFixtureSql(filename,'DELETE FROM memory_lifecycle_events WHERE id=?',event.id),/immutable/);
    assert.equal((store.db.prepare('SELECT count(*) count FROM memory_lifecycle_events WHERE entity_id=?').get(old.id) as any).count,1);
    const native=new Database(filename);try{assert.throws(()=>appendLifecycleEvent(native,{projectId:store.projectId,environment:store.memoryEnvironment,entityKind:'node',entityId:old.id,action:'stale',fromState:'verified',toState:'stale',reasonCode:'legacy_unknown',context:{oversized:'x'.repeat(5000)}}),/exceeds 4096/);}finally{native.close();}
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
