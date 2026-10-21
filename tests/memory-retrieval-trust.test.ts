import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/memory/store.js';
import {reconcile} from '../src/knowledge/reconcile.js';
import {fixtureEdge,runFixtureSql,testWriter} from './helpers/learning.js';

test('public retrieval is trusted-only by default and labels current YAML seed guidance on opt-in',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-retrieval-trust-')),knowledge=path.join(root,'knowledge'),filename=path.join(root,'memory.sqlite');let store:Store|undefined,other:Store|undefined;
  try{
    await mkdir(knowledge);
    const docs=[
      {schema_version:1,kind:'application',id:'app',name:'App',route_patterns:[{screen:'home',path:'/home'},{screen:'account',path:'/account'}]},
      {schema_version:1,kind:'screen',id:'home',name:'Home',route:'/home'},
      {schema_version:1,kind:'screen',id:'login',name:'Login',route:'/login'},
      {schema_version:1,kind:'screen',id:'account',name:'Account',route:'/account'},
      {schema_version:1,kind:'screen',id:'conflicted',name:'Conflicted',route:'/conflicted'},
      {schema_version:1,kind:'screen',id:'stale',name:'Stale',route:'/stale'},
      {schema_version:1,kind:'screen',id:'deleted',name:'Deleted',route:'/deleted'},
      {schema_version:1,kind:'navigation_rules',id:'routes',name:'Routes',rules:[
        {id:'home-login',from:'home',to:'login',via:{action:'navigate'}},
        {id:'login-account',from:'login',to:'account',via:{action:'navigate'}},
        {id:'account-stale',from:'account',to:'stale',via:{action:'navigate'}},
      ]},
      {schema_version:1,kind:'workflow',id:'account-flow',name:'Account flow',start_screen:'account',steps:[{id:'open-account',action:'wait',condition:'url',target:'/account'}]},
      {schema_version:1,kind:'workflow',id:'conflicted-flow',name:'Conflicted flow',start_screen:'account',steps:[{id:'open-conflict',action:'wait',condition:'url',target:'/account'}]},
      {schema_version:1,kind:'workflow',id:'stale-flow',name:'Stale flow',start_screen:'account',steps:[{id:'open-stale',action:'wait',condition:'url',target:'/account'}]},
      {schema_version:1,kind:'workflow',id:'deleted-flow',name:'Deleted flow',start_screen:'account',steps:[{id:'open-deleted',action:'wait',condition:'url',target:'/account'}]},
    ];
    for(const [index,doc] of docs.entries())await writeFile(path.join(knowledge,`${index}.yaml`),JSON.stringify(doc));
    store=new Store(filename,'retrieval-project');await reconcile(knowledge,store,testWriter(store));
    const node=(key:string)=>(store!.getByTypeKey('screen',key) as any).id;
    const home=node('home'),login=node('login'),account=node('account'),conflicted=node('conflicted'),stale=node('stale'),deleted=node('deleted');
    const yamlNav=(from:string,to:string)=>store!.db.prepare("SELECT e.id FROM edges e JOIN nodes f ON f.id=e.from_node_id JOIN nodes t ON t.id=e.to_node_id WHERE e.project_id=? AND e.environment=? AND e.relation_type='NAVIGATES_TO' AND f.canonical_key=? AND t.canonical_key=? AND e.origin='yaml'").get(store!.projectId,store!.memoryEnvironment,from,to) as {id:string};
    runFixtureSql(filename,"UPDATE nodes SET verification_status='verified' WHERE project_id=? AND id IN (?,?)",store.projectId,home,login);
    for(const edge of [yamlNav('home','login'),yamlNav('login','account')])runFixtureSql(filename,"UPDATE edges SET verification_status='verified' WHERE project_id=? AND id=?",store.projectId,edge.id);
    runFixtureSql(filename,"UPDATE nodes SET conflict_status='conflict' WHERE project_id=? AND id=?",store.projectId,conflicted);
    runFixtureSql(filename,"UPDATE nodes SET verification_status='stale' WHERE project_id=? AND id=?",store.projectId,stale);
    runFixtureSql(filename,"UPDATE nodes SET tombstone=1 WHERE project_id=? AND id=?",store.projectId,deleted);
    const proposed=await testWriter(store).propose({observation_id:'read-proposed',type:'screen',stable_key:'proposal',display_name:'Proposal'} ) as any;
    const proposedEdge=await testWriter(store).addEdge({observation_id:'read-proposed-edge',from_id:home,to_id:proposed.id,relation:'NAVIGATES_TO'}) as any;
    const conflictedWorkflow=(store.getByTypeKey('workflow','conflicted-flow') as any).id,staleWorkflow=(store.getByTypeKey('workflow','stale-flow') as any).id,deletedWorkflow=(store.getByTypeKey('workflow','deleted-flow') as any).id;
    runFixtureSql(filename,"UPDATE nodes SET conflict_status='conflict' WHERE project_id=? AND id=?",store.projectId,conflictedWorkflow);
    runFixtureSql(filename,"UPDATE nodes SET verification_status='stale' WHERE project_id=? AND id=?",store.projectId,staleWorkflow);
    runFixtureSql(filename,"UPDATE nodes SET tombstone=1 WHERE project_id=? AND id=?",store.projectId,deletedWorkflow);
    const conflictEdge=fixtureEdge(store,filename,home,login,'NAVIGATES_TO',{}, {origin:'agent',stableKey:'conflicted-route'});
    runFixtureSql(filename,"UPDATE edges SET conflict_status='conflict' WHERE project_id=? AND id=?",store.projectId,conflictEdge.id);
    const staleEdge=fixtureEdge(store,filename,account,home,'NAVIGATES_TO',{}, {origin:'agent',stableKey:'stale-route'});
    runFixtureSql(filename,"UPDATE edges SET verification_status='stale' WHERE project_id=? AND id=?",store.projectId,staleEdge.id);
    const conflictNodeEdge=fixtureEdge(store,filename,home,conflicted,'NAVIGATES_TO',{}, {origin:'agent',stableKey:'conflicted-node-route'});
    runFixtureSql(filename,"UPDATE edges SET verification_status='verified' WHERE project_id=? AND id=?",store.projectId,conflictNodeEdge.id);
    const staleNodeEdge=fixtureEdge(store,filename,home,stale,'NAVIGATES_TO',{}, {origin:'agent',stableKey:'stale-node-route'});
    runFixtureSql(filename,"UPDATE edges SET verification_status='verified' WHERE project_id=? AND id=?",store.projectId,staleNodeEdge.id);
    const tombstonedNodeEdge=fixtureEdge(store,filename,home,deleted,'NAVIGATES_TO',{}, {origin:'agent',stableKey:'deleted-node-route'});
    runFixtureSql(filename,"UPDATE edges SET verification_status='verified' WHERE project_id=? AND id=?",store.projectId,tombstonedNodeEdge.id);
    const tombstoneEdge=fixtureEdge(store,filename,home,login,'NAVIGATES_TO',{}, {origin:'agent',stableKey:'tombstoned-route'});
    runFixtureSql(filename,"UPDATE edges SET verification_status='verified',tombstone=1 WHERE project_id=? AND id=?",store.projectId,tombstoneEdge.id);
    const otherRelation=fixtureEdge(store,filename,home,account,'CONTAINS',{}, {origin:'agent',stableKey:'non-navigation'});
    runFixtureSql(filename,"UPDATE edges SET verification_status='verified' WHERE project_id=? AND id=?",store.projectId,otherRelation.id);

    const context=store.context();
    assert(context.trusted_facts.some((item:any)=>item.id===home));assert(context.trusted_facts.some((item:any)=>item.id===login));
     assert(!context.trusted_facts.some((item:any)=>[account,conflicted,stale,deleted].includes(item.id)));assert(context.trusted_facts.some((item:any)=>item.id===proposed.id&&item.trust_basis==='agent_learned'));
    assert.equal(context.authored_guidance.label,'authored_unverified');
    assert(context.authored_guidance.items.some((item:any)=>item.id===account));
    assert(!context.authored_guidance.items.some((item:any)=>[conflicted,stale,deleted].includes(item.id)));
    assert.match(context.authored_guidance.warning,/unverified.*revalidate/i);
     assert.equal(store.search('Proposal').find((item:any)=>item.id===proposed.id)?.trust_basis,'agent_learned');for(const term of ['Conflicted','Stale','Deleted'])assert.equal(store.search(term).some((item:any)=>[conflicted,stale,deleted].includes(item.id)),false);
     assert.equal((store.getTrustedNode(proposed.id) as any).trust_basis,'agent_learned');assert.equal(store.getTrustedNode(account),null);assert.equal(store.getTrustedNode(conflicted,{trustYamlSeeds:true}),null);assert.equal(store.getTrustedNode(stale,{trustYamlSeeds:true}),null);assert.equal(store.getTrustedNode(deleted,{trustYamlSeeds:true}),null);
    const trustedGet=store.getTrustedNode(home) as any;assert.equal(trustedGet.trust_basis,'verified_fact');
    const neighbors=store.neighbors(home,20) as any[];
    assert(neighbors.some(row=>row.neighbor.id===login&&row.edge.id===yamlNav('home','login').id&&row.edge.direction==='outgoing'));
     assert(neighbors.some(row=>row.neighbor.id===proposed.id&&row.neighbor.trust_basis==='agent_learned'));assert(!neighbors.some(row=>row.neighbor.id===account));
     assert(neighbors.every(row=>row.neighbor.conflict_status==='none'&&(row.neighbor.verification_status==='verified'&&row.edge.trust_basis==='verified_fact'||row.neighbor.id===proposed.id&&row.neighbor.verification_status==='proposed'&&row.neighbor.trust_basis==='agent_learned'&&row.edge.trust_basis==='agent_learned')));
    const pathResult=store.path(home,login,5) as any;assert.deepEqual(pathResult.node_ids,[home,login]);assert.equal(pathResult.edges.length,1);assert.equal(pathResult.edges[0].relation,'NAVIGATES_TO');assert.equal(pathResult.edges[0].id,yamlNav('home','login').id);
     assert.equal(store.path(login,home,5),null,'navigation is directed');assert.equal(store.path(home,account,5),null,'proposed YAML routes are not facts by default');assert.equal((store.path(home,proposed.id,5) as any).edges[0].trust_basis,'agent_learned');
    assert.equal(store.path(home,conflicted,5,{trustYamlSeeds:true}),null);assert.equal(store.path(home,stale,5,{trustYamlSeeds:true}),null);assert.equal(store.path(home,deleted,5,{trustYamlSeeds:true}),null);
     const exported=store.export() as any;assert(exported.nodes.some((item:any)=>item.id===home));assert(exported.nodes.some((item:any)=>item.id===proposed.id&&item.trust_basis==='agent_learned'));assert(!exported.nodes.some((item:any)=>[account,conflicted,stale,deleted].includes(item.id)));
     assert(exported.edges.every((edge:any)=>edge.conflict_status==='none'&&(edge.verification_status==='verified'&&edge.trust_basis==='verified_fact'||edge.id===proposedEdge.id&&edge.verification_status==='proposed'&&edge.trust_basis==='agent_learned')));
    const recall=store.recallWorkflowCandidates({goal:'account flow',currentUrl:'http://localhost/home'}) as any[];
    const guidance=recall.find(item=>item.workflow_id==='account-flow');assert.equal(guidance.trust_basis,'authored_unverified');assert.match(guidance.guidance_warning,/unverified/i);assert.equal(guidance.directed_path,null);
    assert.equal(recall.some(item=>['conflicted-flow','stale-flow','deleted-flow'].includes(item.workflow_id)),false);

    const trustedContext=store.context({trustYamlSeeds:true});
    assert(trustedContext.trusted_facts.some((item:any)=>item.id===account&&item.trust_basis==='trusted_seed'));
    assert(!trustedContext.trusted_facts.some((item:any)=>[conflicted,stale,deleted].includes(item.id)));
    assert.equal(trustedContext.authored_guidance,null);
    assert.equal(store.search('Account',{trustYamlSeeds:true}).find((item:any)=>item.id===account)?.trust_basis,'trusted_seed');
     assert.equal(store.search('Proposal',{trustYamlSeeds:true}).find((item:any)=>item.id===proposed.id)?.trust_basis,'agent_learned');for(const term of ['Conflicted','Stale','Deleted'])assert.equal(store.search(term,{trustYamlSeeds:true}).some((item:any)=>[conflicted,stale,deleted].includes(item.id)),false);
    const seedNode=store.getTrustedNode(account,{trustYamlSeeds:true}) as any;assert.equal(seedNode.verification_status,'proposed');assert.equal(seedNode.trust_basis,'trusted_seed');
    const seedNeighbors=store.neighbors(home,20,{trustYamlSeeds:true}) as any[];
     assert(seedNeighbors.some(row=>row.neighbor.id===proposed.id&&row.neighbor.trust_basis==='agent_learned'));assert(!seedNeighbors.some(row=>row.neighbor.id===conflicted||row.neighbor.id===stale));
    const accountNeighbors=store.neighbors(login,20,{trustYamlSeeds:true}) as any[];
    assert(accountNeighbors.some(row=>row.neighbor.id===account&&row.neighbor.trust_basis==='trusted_seed'&&row.edge.trust_basis==='verified_fact'));
    const seedPath=store.path(home,account,5,{trustYamlSeeds:true}) as any;
    assert.deepEqual(seedPath.node_ids,[home,login,account]);assert(seedPath.edges.every((edge:any)=>edge.relation==='NAVIGATES_TO'&&edge.trust_basis==='trusted_seed'||edge.trust_basis==='verified_fact'));
    assert.equal(store.path(home,account,5,{trustYamlSeeds:false}),null);
    assert.equal(store.path(home,account,5,{trustYamlSeeds:true})?.edges.some((edge:any)=>edge.id===otherRelation.id),false,'non-navigation relation does not create a path');
     const seedExport=store.export({trustYamlSeeds:true}) as any;assert(seedExport.nodes.some((item:any)=>item.id===account&&item.trust_basis==='trusted_seed'));assert(seedExport.nodes.some((item:any)=>item.id===proposed.id&&item.trust_basis==='agent_learned'));assert(!seedExport.edges.some((edge:any)=>edge.id===conflictEdge.id||edge.id===staleEdge.id));
    const seedRecall=store.recallWorkflowCandidates({goal:'account flow',currentUrl:'http://localhost/home',trustYamlSeeds:true}) as any[];
    const trustedWorkflow=seedRecall.find(item=>item.workflow_id==='account-flow');assert.equal(trustedWorkflow.trust_basis,'trusted_seed');assert.deepEqual(trustedWorkflow.directed_path.screen_ids,['home','login','account']);
    assert.equal(seedRecall.some(item=>['conflicted-flow','stale-flow','deleted-flow'].includes(item.workflow_id)),false);

    other=new Store(filename,'retrieval-project','staging');assert.equal(other.getTrustedNode(home,{trustYamlSeeds:true}),null);assert.equal(other.context({trustYamlSeeds:true}).trusted_facts.some((item:any)=>item.id===home||item.id===account),false);assert.equal((other.export({trustYamlSeeds:true}).nodes as any[]).some(item=>item.id===home||item.id===account),false);
    runFixtureSql(filename,"UPDATE yaml_sources SET active=0 WHERE project_id=? AND environment=?",store.projectId,store.memoryEnvironment);
    assert.equal(store.getTrustedNode(account,{trustYamlSeeds:true}),null,'inactive source ownership invalidates YAML seed trust');
    assert.equal(store.context({trustYamlSeeds:true}).trusted_facts.some((item:any)=>item.id===account),false);
  }finally{other?.close();store?.close();await rm(root,{recursive:true,force:true});}
});
