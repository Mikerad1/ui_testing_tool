import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/memory/store.js';
import {reconcile} from '../src/knowledge/reconcile.js';
import {testWriter} from './helpers/learning.js';

test('YAML edge versions preserve declaration ownership and semantic conflicts',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'yaml-edges-')),root=path.join(dir,'knowledge');
  let store:Store|undefined;
  try{
    await mkdir(root);store=new Store(path.join(dir,'db.sqlite'),'p');
    const app=path.join(root,'app.yaml'),home=path.join(root,'home.yaml'),next=path.join(root,'next.yaml'),other=path.join(root,'other.yaml'),nav=path.join(root,'nav.yaml');
    await writeFile(app,"schema_version: 1\nkind: application\nid: app\nname: App\nroute_patterns: [{screen: next, path: /one}, {screen: next, path: /two}]\n");
    await writeFile(home,"schema_version: 1\nkind: screen\nid: home\nname: Home\n");
    await writeFile(next,"schema_version: 1\nkind: screen\nid: next\nname: Next\n");
    await writeFile(other,"schema_version: 1\nkind: screen\nid: other\nname: Other\n");
    const navText=(authTo='next',includeGuest=true)=>`schema_version: 1\nkind: navigation_rules\nid: nav\nname: Nav\nrules:\n  - id: auth\n    from: home\n    to: ${authTo}\n    via: {action: navigate}\n    preconditions: [{state: authenticated}]\n    verify: {condition: url_matches, pattern: '/projects'}\n${includeGuest?`  - id: guest\n    from: home\n    to: next\n    via: {action: navigate}\n`:''}`;
    await writeFile(nav,navText());await reconcile(root, store, testWriter(store));
    const active=()=>store!.db.prepare("SELECT * FROM edges WHERE project_id='p' AND origin='yaml' AND tombstone=0").all() as any[];
    let routes=active().filter(e=>e.relation_type==='HAS_SCREEN'),rules=active().filter(e=>e.relation_type==='NAVIGATES_TO');
    assert.equal(routes.length,2);assert.equal(new Set(routes.map(e=>e.stable_key)).size,2);
    assert.equal(rules.length,2);assert.equal(new Set(rules.map(e=>e.stable_key)).size,2);
    const auth=rules.find(e=>e.stable_key.includes(':rule:auth:'))!;
    const guest=rules.find(e=>e.stable_key.includes(':rule:guest:'))!;
    const routeOne=routes.find(e=>JSON.parse(e.attributes_json).path==='/one')!;
    const routeTwo=routes.find(e=>JSON.parse(e.attributes_json).path==='/two')!;
    const homeId=auth.from_node_id,nextId=auth.to_node_id;
    const agent=await testWriter(store).addEdge({from_id:homeId,to_id:nextId,relation:'NAVIGATES_TO',attributes:{via:{action:'click'},rule_id:'auth'}}) as any;
    await reconcile(root, store, testWriter(store));
    const agentRow=store.db.prepare('SELECT * FROM edges WHERE id=?').get(agent.id) as any;
    assert.equal(agentRow.origin,'agent');assert.equal(agentRow.verification_status,'stale');assert.equal(agentRow.conflict_status,'conflict');
    const authAfter=active().find(e=>e.stable_key.includes(':rule:auth:'))!;
    assert.equal(authAfter.conflict_status,'conflict');assert.equal(authAfter.conflicting_edge_id,agent.id);
    assert.ok((store.listConflicts() as any[]).some(x=>x.id===agent.id||x.conflicting_edge_id===agent.id));

    await writeFile(nav,navText('other'));await reconcile(root, store, testWriter(store));
    const oldAuth=store.db.prepare('SELECT * FROM edges WHERE id=?').get(auth.id) as any;
    assert.equal(oldAuth.tombstone,1);
    const newAuth=active().find(e=>e.stable_key.includes(':rule:auth:'))!;
    assert.notEqual(newAuth.id,auth.id);assert.notEqual(newAuth.to_node_id,nextId);
    assert.equal((store.db.prepare('SELECT tombstone FROM edges WHERE id=?').get(agent.id) as any).tombstone,0);

    await writeFile(app,"schema_version: 1\nkind: application\nid: app\nname: App\nroute_patterns: [{screen: next, path: /two}]\n");
    await writeFile(nav,navText('other',false));await reconcile(root, store, testWriter(store));
    assert.equal((store.db.prepare('SELECT tombstone FROM edges WHERE id=?').get(guest.id) as any).tombstone,1);
    assert.equal((store.db.prepare('SELECT tombstone FROM edges WHERE id=?').get(routeOne.id) as any).tombstone,1);
    assert.equal((store.db.prepare('SELECT tombstone FROM edges WHERE id=?').get(routeTwo.id) as any).tombstone,0);
    assert.equal((store.db.prepare('SELECT tombstone FROM edges WHERE id=?').get(newAuth.id) as any).tombstone,0);
    assert.equal((store.db.prepare('SELECT tombstone FROM edges WHERE id=?').get(agent.id) as any).tombstone,0);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
