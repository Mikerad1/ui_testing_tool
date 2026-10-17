import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rename,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/memory/store.js';
import {reconcile} from '../src/knowledge/reconcile.js';
import {testLearningWriter} from './helpers/learning.js';

const screen=(id:string,name:string,element=false)=>`schema_version: 1\nkind: screen\nid: ${id}\nname: ${name}\n${element?`elements: [{id: submit, description: Send form, locator: {by: test_id, value: submit}}]\n`:''}`;

test('validated YAML record fingerprints skip only NLP and retain full reconciliation for change, move, and deletion',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'umb-yaml-fingerprint-')),knowledge=path.join(root,'knowledge'),filename=path.join(root,'memory.sqlite');
  await mkdir(knowledge);const home=path.join(knowledge,'home.yaml'),settings=path.join(knowledge,'settings.yaml');
  await writeFile(home,screen('home','Home',true));await writeFile(settings,screen('settings','Settings'));
  const store=new Store(filename,'yaml-fingerprint'),inputs:string[]=[],writer=testLearningWriter(store,{inputs});
  try{
    await reconcile(knowledge,store,writer);assert.equal(inputs.length,2);
    const homeId=(store.getByTypeKey('screen','home') as any).id,elementId=(store.getByTypeKey('ui_element','screen:home/submit') as any).id;
    assert.equal((store.listEdges(homeId) as any[]).some(edge=>edge.relation_type==='CONTAINS'&&edge.to_node_id===elementId),true);
    const fingerprints=()=>store.db.prepare('SELECT document_kind,document_id,source_path,raw_hash,redacted_hash,preparation_key FROM yaml_record_fingerprints WHERE project_id=? AND environment=? ORDER BY document_kind,document_id').all(store.projectId,store.memoryEnvironment);
    const firstFingerprints=fingerprints();assert.equal(firstFingerprints.length,2);

    await reconcile(knowledge,store,writer);assert.equal(inputs.length,2,'identical validated and redacted records reuse NLP normalization');
    await writeFile(settings,screen('settings','Settings changed'));
    await reconcile(knowledge,store,writer);assert.equal(inputs.length,3,'only the changed top-level record is reprocessed');
    assert.equal((store.getByTypeKey('screen','settings') as any).display_name,'Settings changed');
    assert.equal((store.getByTypeKey('screen','home') as any).id,homeId);
    assert.equal((store.listEdges(homeId) as any[]).some(edge=>edge.relation_type==='CONTAINS'&&edge.to_node_id===elementId),true,'a cache hit remains in the complete graph plan');

    const movedDir=path.join(knowledge,'moved');await mkdir(movedDir);await rename(home,path.join(movedDir,'home.yaml'));
    await reconcile(knowledge,store,writer);assert.equal(inputs.length,3,'moving an unchanged record can reuse its scoped cached normalization');
    assert.equal((store.getByTypeKey('screen','home') as any).id,homeId);
    assert.equal((store.db.prepare("SELECT source_path,tombstone FROM yaml_ownership WHERE project_id=? AND environment=? AND entity_type='screen' AND entity_key='home' AND tombstone=0").get(store.projectId,store.memoryEnvironment) as any).source_path,'moved/home.yaml');

    const beforeInvalid=JSON.stringify({nodes:store.db.prepare('SELECT id,attributes_json,tombstone FROM nodes WHERE project_id=? AND environment=? ORDER BY id').all(store.projectId,store.memoryEnvironment),fingerprints:fingerprints()});
    await writeFile(path.join(movedDir,'home.yaml'),'schema_version: 1\nkind: screen\nid: home\nname: Invalid\nunknown: forbidden\n');
    await assert.rejects(()=>reconcile(knowledge,store,writer));
    assert.equal(JSON.stringify({nodes:store.db.prepare('SELECT id,attributes_json,tombstone FROM nodes WHERE project_id=? AND environment=? ORDER BY id').all(store.projectId,store.memoryEnvironment),fingerprints:fingerprints()}),beforeInvalid,'invalid YAML cannot update graph or cache state');

    await writeFile(path.join(movedDir,'home.yaml'),screen('home','Home',true));await reconcile(knowledge,store,writer);
    await rm(path.join(movedDir,'home.yaml'));await reconcile(knowledge,store,writer);
    assert.equal(store.get(homeId),null,'record deletion still tombstones the complete desired state');
    assert.equal((store.listEdges(homeId) as any[]).length,0,'nested edge deletion is not skipped by the fingerprint cache');
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('YAML fingerprints invalidate for redaction policy and NLP profile changes',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'umb-yaml-policy-')),knowledge=path.join(root,'knowledge');await mkdir(knowledge);
  await writeFile(path.join(knowledge,'home.yaml'),screen('home','Sensitive label'));
  const store=new Store(path.join(root,'memory.sqlite'),'yaml-policy');
  try{
    const baseline:string[]=[],baselineWriter=testLearningWriter(store,{inputs:baseline});await reconcile(knowledge,store,baselineWriter);assert.equal(baseline.length,1);
    const unchanged:string[]=[],unchangedWriter=testLearningWriter(store,{inputs:unchanged});await reconcile(knowledge,store,unchangedWriter);assert.equal(unchanged.length,0,'same pipeline profile reuses the safe prepared record');
    const repeated:string[]=[],redactedWriter=testLearningWriter(store,{inputs:repeated,sensitivePaths:['/name']});await reconcile(knowledge,store,redactedWriter);assert.equal(repeated.length,1,'redaction-policy change invalidates prepared data');
    assert.equal((store.getByTypeKey('screen','home') as any).display_name,'[REDACTED]');
    const rulesChanged:string[]=[],newRules=testLearningWriter(store,{inputs:rulesChanged,rules:'rules-v2'});await reconcile(knowledge,store,newRules);assert.equal(rulesChanged.length,1,'NLP rules change invalidates prepared data');
    const protocolChanged:string[]=[],newProtocol=testLearningWriter(store,{inputs:protocolChanged,protocol:3});await reconcile(knowledge,store,newProtocol);assert.equal(protocolChanged.length,1,'NLP protocol change invalidates prepared data');
    const modelChanged:string[]=[],newModel=testLearningWriter(store,{inputs:modelChanged,model:'different-model'});await reconcile(knowledge,store,newModel);assert.equal(modelChanged.length,1,'NLP model change invalidates prepared data');
    const baselineProfile=await testLearningWriter(store,{model:'different-model',modelVersion:'3.8.0'}).pipelineFingerprint();
    const modelVersionChanged:string[]=[],newModelVersion=testLearningWriter(store,{inputs:modelVersionChanged,model:'different-model',modelVersion:'3.8.1'});
    assert.notEqual(await newModelVersion.pipelineFingerprint(),baselineProfile,'exact model version participates in the NLP profile fingerprint');
    await reconcile(knowledge,store,newModelVersion);assert.equal(modelVersionChanged.length,1,'model-version change invalidates cached YAML normalization');
    const projectionChanged:string[]=[],projectionWriter=testLearningWriter(store,{inputs:projectionChanged,model:'different-model',modelVersion:'3.8.1'});
    const projectionInput=await projectionWriter.validateYamlDocument({schema_version:1,kind:'screen',id:'home',name:'[REDACTED]'}, {sourcePath:'home.yaml',documentKind:'screen',documentId:'home',rawHash:(store.db.prepare("SELECT raw_hash FROM yaml_record_fingerprints WHERE project_id=? AND environment=? AND document_kind='screen' AND document_id='home'").get(store.projectId,store.memoryEnvironment) as any).raw_hash,projectionVersion:'yaml-projection-v2'},value=>value);
    await projectionWriter.normalizeYamlDocument(projectionInput);
    assert.equal(projectionChanged.length,1,'YAML projection version is part of the preparation key');
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('all redacted records and cross-document references validate before any YAML cache lookup',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'umb-yaml-preflight-')),knowledge=path.join(root,'knowledge');await mkdir(knowledge);const home=path.join(knowledge,'home.yaml');
  await writeFile(home,screen('home','Home'));
  const store=new Store(path.join(root,'memory.sqlite'),'yaml-preflight'),inputs:string[]=[],writer=testLearningWriter(store,{inputs});
  try{
    await reconcile(knowledge,store,writer);assert.equal(inputs.length,1);
    let lookups=0;const originalLookup=store.getYamlRecordNormalization.bind(store);
    store.getYamlRecordNormalization=(fingerprint)=>{lookups++;return originalLookup(fingerprint);};
    await writeFile(path.join(knowledge,'application.yaml'),'schema_version: 1\nkind: application\nid: app\nname: App\nroute_patterns: [{screen: absent, path: /absent}]\n');
    await assert.rejects(()=>reconcile(knowledge,store,writer),/Knowledge reference is missing/);
    assert.equal(lookups,0,'invalid complete source inventory cannot read even a valid cached normalization');
    assert.equal(inputs.length,1,'invalid cross-document references cannot trigger NLP analysis');

    await rm(path.join(knowledge,'application.yaml'));
    await writeFile(path.join(knowledge,'sensitive.yaml'),'schema_version: 1\nkind: screen\nid: sensitive\nname: Sensitive\nelements: [{id: submit, description: Send form, locator: {by: test_id, value: submit}, sensitive: true}]\n');
    const redactingWriter=testLearningWriter(store,{sensitivePaths:['/elements/0/sensitive']}),lookup=store.getYamlRecordNormalization.bind(store);let attemptedLookups=0;
    store.getYamlRecordNormalization=(fingerprint)=>{attemptedLookups++;return lookup(fingerprint);};
    await assert.rejects(()=>reconcile(knowledge,store,redactingWriter),/Redacted knowledge document failed validation/);
    assert.equal(attemptedLookups,0,'every document must pass redacted schema validation before cache reads begin');
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('effective configured secret rotation changes the redaction fingerprint without storing secret values',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'umb-yaml-secret-policy-')),knowledge=path.join(root,'knowledge');await mkdir(knowledge);
  await writeFile(path.join(knowledge,'home.yaml'),screen('home','Ordinary label'));
  const store=new Store(path.join(root,'memory.sqlite'),'yaml-secret-policy');
  try{
    const first:string[]=[],firstWriter=testLearningWriter(store,{inputs:first,sensitiveValuesEnv:['MEMORY_SECRET'],env:{MEMORY_SECRET:'first-private-value'}});
    await reconcile(knowledge,store,firstWriter);assert.equal(first.length,1);
    const afterRotation:string[]=[],rotatedWriter=testLearningWriter(store,{inputs:afterRotation,sensitiveValuesEnv:['MEMORY_SECRET'],env:{MEMORY_SECRET:'second-private-value'}});
    await reconcile(knowledge,store,rotatedWriter);assert.equal(afterRotation.length,1,'changing the effective redaction value invalidates a cached NLP result');
    const persisted=JSON.stringify(store.db.prepare('SELECT * FROM yaml_record_fingerprints WHERE project_id=?').all('yaml-secret-policy'));
    assert(!persisted.includes('first-private-value'));assert(!persisted.includes('second-private-value'));
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('YAML preparation fingerprints and cached normalization are isolated by environment',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'umb-yaml-env-')),knowledge=path.join(root,'knowledge'),filename=path.join(root,'memory.sqlite');await mkdir(knowledge);await writeFile(path.join(knowledge,'home.yaml'),screen('home','Home'));
  const staging=new Store(filename,'yaml-env','staging'),production=new Store(filename,'yaml-env','production');
  try{
    const stagingInputs:string[]=[],productionInputs:string[]=[];
    await reconcile(knowledge,staging,testLearningWriter(staging,{inputs:stagingInputs}));
    await reconcile(knowledge,production,testLearningWriter(production,{inputs:productionInputs}));
    assert.equal(stagingInputs.length,1);assert.equal(productionInputs.length,1,'a different environment must not hit the first environment cache');
    assert.equal((staging.getByTypeKey('screen','home') as any).id!==(production.getByTypeKey('screen','home') as any).id,true);
    assert.deepEqual(staging.db.prepare('SELECT environment FROM yaml_record_fingerprints WHERE project_id=? ORDER BY environment').all('yaml-env'),[{environment:'production'},{environment:'staging'}]);
    const repeated:string[]=[];await reconcile(knowledge,production,testLearningWriter(production,{inputs:repeated}));assert.equal(repeated.length,0,'the matching environment can reuse its own normalization');
  }finally{staging.close();production.close();await rm(root,{recursive:true,force:true});}
});
