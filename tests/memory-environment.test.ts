import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/memory/store.js';
import {reconcile} from '../src/knowledge/reconcile.js';
import {testWriter} from './helpers/learning.js';

test('memory graph, YAML ownership, runs, and evidence are isolated by immutable environment scope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-memory-env-'));
  const filename = path.join(root, 'memory.sqlite'), knowledge = path.join(root, 'knowledge');
  await mkdir(knowledge);
  await writeFile(path.join(knowledge, 'home.yaml'), 'schema_version: 1\nkind: screen\nid: home\nname: Home\nroute: /home\n');
  const workflowFile = path.join(knowledge, 'shared-workflow.yaml');
  const workflowYaml = (name: string) => `schema_version: 1\nkind: workflow\nid: shared-flow\nname: ${name}\nstart_screen: home\nsteps: [{id: open, action: wait, condition: url, target: /home}]\n`;
  const legacy = new Store(filename, 'shared-project');
  const staging = new Store(filename, 'shared-project', 'staging');
  const production = new Store(filename, 'shared-project', 'production');
  try {
    assert.equal(legacy.memoryEnvironment, 'legacy');
    assert.equal(staging.memoryEnvironment, 'staging');
    await reconcile(knowledge, legacy, testWriter(legacy));
    await reconcile(knowledge, staging, testWriter(staging));
    const originalScreenId = (staging.getByTypeKey('screen', 'home') as any).id;
    const movedDirectory = path.join(knowledge, 'moved');
    await mkdir(movedDirectory);
    await rm(path.join(knowledge, 'home.yaml'));
    await reconcile(knowledge, staging, testWriter(staging));
    await writeFile(path.join(movedDirectory, 'home.yaml'), 'schema_version: 1\nkind: screen\nid: home\nname: Home\nroute: /home\n');
    await reconcile(knowledge, staging, testWriter(staging));
    await rm(path.join(movedDirectory, 'home.yaml'));
    await writeFile(path.join(knowledge, 'home.yaml'), 'schema_version: 1\nkind: screen\nid: home\nname: Home\nroute: /home\n');
    await reconcile(knowledge, staging, testWriter(staging));
    assert.equal((staging.getByTypeKey('screen', 'home') as any).id, originalScreenId, 'moving a YAML record back reactivates its scoped ownership without changing its ID');
    const ownership=staging.db.prepare("SELECT source_path,tombstone FROM yaml_ownership WHERE project_id=? AND environment=? AND entity_type='screen' AND entity_key='home' ORDER BY source_path").all(staging.projectId,staging.memoryEnvironment) as Array<{source_path:string;tombstone:number}>;
    assert.deepEqual(ownership,[{source_path:'home.yaml',tombstone:0},{source_path:'moved/home.yaml',tombstone:1}]);
    assert.equal(ownership.filter(row=>row.tombstone===0).length,1,'exactly one source owns the active record');
    await writeFile(workflowFile, workflowYaml('Staging flow'));
    await reconcile(knowledge, staging, testWriter(staging));
    await writeFile(workflowFile, workflowYaml('Production flow'));
    await reconcile(knowledge, production, testWriter(production));

    const legacyScreen = legacy.getByTypeKey('screen', 'home') as any;
    const stagingScreen = staging.getByTypeKey('screen', 'home') as any;
    const productionScreen = production.getByTypeKey('screen', 'home') as any;
    assert.notEqual(legacyScreen.id, stagingScreen.id);
    assert.notEqual(stagingScreen.id, productionScreen.id);
    assert.equal(staging.get(legacyScreen.id), null);
    assert.equal(legacy.get(productionScreen.id), null);
    assert.equal(staging.export().nodes.some((node: any) => node.id === productionScreen.id), false);
    assert.equal(staging.search('Home').some((node: any) => node.id === productionScreen.id), false);
    assert.equal((staging.context().authored_guidance as any).items.some((node: any) => node.stable_key === 'home'), true);
    assert.equal(staging.recallWorkflowCandidates({goal: 'shared flow', currentUrl: 'http://localhost/home',trustYamlSeeds:true}).find((item: any) => item.workflow_id === 'shared-flow')?.name, 'Staging flow');
    assert.equal(production.recallWorkflowCandidates({goal: 'shared flow', currentUrl: 'http://localhost/home',trustYamlSeeds:true}).find((item: any) => item.workflow_id === 'shared-flow')?.name, 'Production flow');

    const stagingProposal = await testWriter(staging).propose({observation_id:'stage-node',type: 'screen', stable_key: 'same-agent-key', display_name: 'Stage item'});
    const productionProposal = await testWriter(production).propose({observation_id:'prod-node',type: 'screen', stable_key: 'same-agent-key', display_name: 'Prod item'});
    assert.equal((stagingProposal as any).conflict_status, 'none');
    assert.equal((productionProposal as any).conflict_status, 'none');
    await testWriter(staging).addEdge({observation_id:'stage-edge',from_id: stagingScreen.id, to_id: (stagingProposal as any).id, relation: 'NAVIGATES_TO'});
    await testWriter(production).addEdge({observation_id:'prod-edge',from_id: productionScreen.id, to_id: (productionProposal as any).id, relation: 'NAVIGATES_TO'});
    assert.equal((staging.listEdges() as any[]).filter((edge:any)=>edge.relation_type==='NAVIGATES_TO').length,1);
    assert.equal((production.listEdges() as any[]).filter((edge:any)=>edge.relation_type==='NAVIGATES_TO').length,1);
    assert.equal((staging.listConflicts() as any[]).length, 0);
    await assert.rejects(
      testWriter(staging).addEdge({observation_id:'cross-scope',from_id: stagingScreen.id, to_id: productionScreen.id, relation: 'NAVIGATES_TO'}),
      /Learning write failed safely/,
    );

    const stagingEvidenceBefore=(staging.stats() as any).evidence,productionEvidenceBefore=(production.stats() as any).evidence;
    const runId = staging.createRun('scope-test', 'workflow', {environment: 'production'});
    staging.addEvidence({run_id: runId, subject_node_id: stagingScreen.id, kind: 'workflow', outcome: 'passed'});
    staging.finishRun(runId, 'passed');
    assert.equal((staging.db.prepare('SELECT memory_environment,environment_json FROM runs WHERE id=?').get(runId) as any).memory_environment, 'staging');
    assert.equal(JSON.parse((staging.db.prepare('SELECT environment_json FROM runs WHERE id=?').get(runId) as any).environment_json).environment, 'production', 'untrusted run metadata does not select graph scope');
    assert.equal(production.getRunReport(runId), null);
    assert.deepEqual(production.readEvidence(stagingScreen.id), []);
    assert.equal((staging.stats() as any).evidence, stagingEvidenceBefore+1);
    assert.equal((production.stats() as any).evidence, productionEvidenceBefore);
    assert.throws(() => production.addEvidence({run_id: runId, subject_node_id: productionScreen.id, kind: 'outcome', outcome: 'passed'}), /Store environment/);
  } finally {
    legacy.close();
    staging.close();
    production.close();
    await rm(root, {recursive: true, force: true});
  }
});
