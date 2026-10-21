import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/memory/store.js';
import {testWriter} from './helpers/learning.js';

test('MCP learned proposals are available to normal trusted retrieval without human verification',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'mcp-auto-trust-')),filename=path.join(dir,'memory.sqlite');let store:Store|undefined,reopened:Store|undefined;
  try{
    store=new Store(filename,'mcp-auto-trust');
    const writer=testWriter(store);
    // This simulates a pre-existing MCP proposal, with the ordinary proposed
    // lifecycle state and no verify/audit event.
    const home=await writer.propose({observation_id:'existing-mcp-home',type:'screen',stable_key:'mcp-home',display_name:'MCP Landing Page',attributes:{route:'/mcp-landing'}}) as any;
    const settings=await writer.propose({observation_id:'new-mcp-settings',type:'screen',stable_key:'mcp-settings',display_name:'MCP Settings Page',attributes:{route:'/mcp-settings'}}) as any;
    const edge=await writer.addEdge({observation_id:'new-mcp-navigation',from_id:home.id,to_id:settings.id,relation:'NAVIGATES_TO'}) as any;
    assert.equal(home.verification_status,'proposed');assert.equal(settings.verification_status,'proposed');assert.equal(edge.verification_status,'proposed');
    assert.equal((store.db.prepare("SELECT count(*) count FROM memory_audit WHERE action='verify'").get() as any).count,0);
    assert.equal((store.getTrustedNode(home.id) as any).trust_basis,'agent_learned');
    assert.equal((store.getTrustedNode(settings.id) as any).trust_basis,'agent_learned');
    assert.equal(store.context().trusted_facts.some((row:any)=>row.id===home.id&&row.trust_basis==='agent_learned'),true);
    assert.equal(store.search('MCP Landing Page').find((row:any)=>row.id===home.id)?.trust_basis,'agent_learned');
    assert.equal((store.export() as any).edges.some((row:any)=>row.id===edge.id&&row.trust_basis==='agent_learned'),true);
    assert.equal((store.path(home.id,settings.id,3) as any).edges[0].trust_basis,'agent_learned');
    store.close();store=undefined;
    reopened=new Store(filename,'mcp-auto-trust');
    assert.equal((reopened.getTrustedNode(home.id) as any).trust_basis,'agent_learned');
    assert.equal(reopened.search('MCP Settings Page').some((row:any)=>row.id===settings.id),true);
  }finally{store?.close();reopened?.close();await rm(dir,{recursive:true,force:true});}
});
