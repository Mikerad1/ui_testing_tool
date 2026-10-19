import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {Buffer} from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {Store} from '../src/memory/store.js';
import {withNlpMetadata} from '../src/memory/learning-types.js';
import {storeLearningCommit} from '../src/memory/store-internal.js';
import {memorySearchCallToolResult} from '../src/mcp/server.js';

test('ranked indexed search supports exact/prose modes, compact pages, and bound cursors',async()=>{
   const root=await mkdtemp(path.join(os.tmpdir(),'memory-search-page-')),filename=path.join(root,'memory.sqlite');let store:Store|undefined;
   try{
     store=new Store(filename,'search-page');
    const entities=[
      {type:'screen',key:'checkout',name:'Checkout screen',attrs:{id:'checkout',route:'/checkout',elements:[{id:'pay-button',description:'Submit payment safely',locator:{by:'test_id',value:'pay-button'}}]}},
      {type:'screen',key:'billing',name:'Billing screen',attrs:{id:'billing',route:'/billing',elements:[{id:'billing-button',description:'Submit billing payment',locator:{by:'test_id',value:'billing-button'}}]}},
    ];
    storeLearningCommit.reconciliation(store,{sources:[{path:'search.yaml',hash:'a'.repeat(64)}],entities:entities.map(entity=>({...entity,attrs:withNlpMetadata(entity.attrs,'ignored'),hash:'a'.repeat(64),source:'search.yaml'})),edges:[]} as any);
    const exact=store.searchPage('/checkout',{mode:'exact',trustYamlSeeds:true});
    assert.equal(exact.pagination.status,'complete');assert.equal(exact.data.length,1);assert.deepEqual(exact.data[0]?.matched_paths,['attributes.route']);
    const prose=store.searchPage('submit payment',{mode:'prose',trustYamlSeeds:true,page_size:1});
    assert.equal(prose.pagination.status,'has_more');assert.equal(prose.data.length,1);assert.equal(prose.data[0]?.trust_basis,'trusted_seed');
    const cursor=prose.pagination.next_cursor as string;
    const next=store.searchPage('submit payment',{mode:'prose',trustYamlSeeds:true,page_size:1,cursor});
    assert.equal(next.data.length,1);assert.equal(next.pagination.status,'complete');assert.notEqual(next.data[0]?.id,prose.data[0]?.id);
    assert.equal(store.searchPage('submit payment',{mode:'prose',trustYamlSeeds:true,page_size:2,cursor}).pagination.status,'invalid_cursor');
    assert.equal(store.searchPage('different query',{mode:'prose',trustYamlSeeds:true,page_size:1,cursor}).pagination.status,'invalid_cursor');
      const tampered=`${cursor.slice(0,-1)}${cursor.endsWith('a')?'b':'a'}`;
      assert.equal(store.searchPage('submit payment',{mode:'prose',trustYamlSeeds:true,page_size:1,cursor:tampered}).pagination.status,'invalid_cursor');
      const [payloadText,signature]=cursor.split('.'),payload=JSON.parse(Buffer.from(payloadText!,'base64url').toString('utf8'));payload.key_id='unknown-key';
      const tamperedKey=`${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
      assert.equal(store.searchPage('submit payment',{mode:'prose',trustYamlSeeds:true,page_size:1,cursor:tamperedKey}).pagination.status,'invalid_cursor');
      store.close();store=undefined;store=new Store(filename,'search-page');
      assert.equal(store.searchPage('submit payment',{mode:'prose',trustYamlSeeds:true,page_size:1,cursor}).pagination.status,'invalid_cursor','a cursor from a lost Store-local signing key cannot be authenticated');
     const freshCursor=store.searchPage('submit payment',{mode:'prose',trustYamlSeeds:true,page_size:1}).pagination.next_cursor as string;
     storeLearningCommit.proposedNode(store,{type:'validation_rule',stable_key:'generation-change',display_name:'generation change',attributes:withNlpMetadata({description:'new indexed phrase'},'ignored')} as any);
     assert.equal(store.searchPage('submit payment',{mode:'prose',trustYamlSeeds:true,page_size:1,cursor:freshCursor}).pagination.status,'cursor_expired');
    assert.throws(()=>store!.searchPage('   ',{mode:'prose'}),/requires at least one token/);
    assert.throws(()=>store!.searchPage('x'.repeat(201)),/200 Unicode code points/);
    assert.throws(()=>store!.searchPage('😀'.repeat(129)),/512 UTF-8 bytes/);
    assert.throws(()=>store!.searchPage(`${'a '.repeat(32)}b`),/Normalized search query exceeds limits/);
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('auto search preserves byte-sensitive exact matching while normalizing prose',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-search-modes-'));let store:Store|undefined;
  try{
    store=new Store(path.join(root,'memory.sqlite'),'search-modes');
    storeLearningCommit.reconciliation(store,{sources:[{path:'search.yaml',hash:'c'.repeat(64)}],entities:[{type:'screen',key:'unicode',name:'Café account',attrs:withNlpMetadata({id:'unicode',route:'/Café',elements:[]},'ignored'),hash:'c'.repeat(64),source:'search.yaml'}],edges:[]} as any);
    assert.equal(store.searchPage('/Café',{trustYamlSeeds:true}).data.length,1);
    assert.equal(store.searchPage('/café',{mode:'exact',trustYamlSeeds:true}).data.length,0);
    assert.equal(store.searchPage('CAFE\u0301 account',{mode:'prose',trustYamlSeeds:true}).data.length,1);
    assert.equal(store.searchPage('Café',{mode:'auto',trustYamlSeeds:false}).data.length,0,'YAML seeds are excluded in trust view zero');
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('prose candidate cap returns too_broad without partial matches',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-search-cap-'));let store:Store|undefined;
  try{
    store=new Store(path.join(root,'memory.sqlite'),'search-cap');
    const source='many-screens.yaml',hash='d'.repeat(64),entities=Array.from({length:1001},(_,index)=>({type:'screen',key:`screen-${index}`,name:`Common screen ${index}`,attrs:withNlpMetadata({id:`screen-${index}`,elements:[]},'ignored'),hash,source}));
    storeLearningCommit.reconciliation(store,{sources:[{path:source,hash}],entities,edges:[]} as any);
    const page=store.searchPage('common',{mode:'prose',trustYamlSeeds:true});
    assert.equal(page.pagination.status,'too_broad');assert.deepEqual(page.data,[]);assert.equal('next_cursor' in page.pagination,false);
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('cursor scope binding stays below MCP input limits for long valid project IDs',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-search-long-scope-'));let store:Store|undefined;
  try{
    store=new Store(path.join(root,'memory.sqlite'),`project-${'x'.repeat(2000)}`);const source='long-scope.yaml',hash='a'.repeat(64);
    const entities=['one','two'].map(key=>({type:'screen',key,name:`Shared phrase ${key}`,attrs:withNlpMetadata({id:key,elements:[]},'ignored'),hash,source}));
    storeLearningCommit.reconciliation(store,{sources:[{path:source,hash}],entities,edges:[]} as any);
    const first=store.searchPage('shared phrase',{mode:'prose',trustYamlSeeds:true,page_size:1}),cursor=first.pagination.next_cursor as string;
    assert.equal(first.pagination.status,'has_more');assert(cursor.length<=2048,'cursor remains valid under the MCP schema limit');
    const second=store.searchPage('shared phrase',{mode:'prose',trustYamlSeeds:true,page_size:1,cursor});assert.equal(second.data.length,1);assert.equal(second.pagination.status,'complete');
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('search fails closed when a required multibyte projection field exceeds 2 KiB',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-search-projection-')),filename=path.join(root,'memory.sqlite');let store:Store|undefined;
  try{
    store=new Store(filename,'projection-limit');
    const hash='e'.repeat(64);
    storeLearningCommit.reconciliation(store,{sources:[{path:'projection.yaml',hash}],entities:[{type:'screen',key:'projection-key',name:'Small name',attrs:withNlpMetadata({id:'projection-key',elements:[]},'ignored'),hash,source:'projection.yaml'}],edges:[]} as any);
    store.close();store=undefined;
    const external=new Database(filename);external.prepare('UPDATE nodes SET display_name=? WHERE project_id=? AND stable_key=?').run('🧪'.repeat(600),'projection-limit','projection-key');external.close();
    store=new Store(filename,'projection-limit');
    const result=store.searchPage('projection-key',{mode:'exact',trustYamlSeeds:true});
    assert.deepEqual(result.data,[]);assert.equal(result.pagination.status,'too_broad');assert.equal('next_cursor' in result.pagination,false);
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('raw exact lookup is indexed, hash-verified, and bounded before duplicate-node dedupe',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-search-exact-index-')),filename=path.join(root,'memory.sqlite');let store:Store|undefined;
  try{
    store=new Store(filename,'exact-integrity');
    const app=store.applicationSubject()!.id;
    const plan=store.db.prepare(`EXPLAIN QUERY PLAN SELECT node_id FROM memory_search_values WHERE project_id=? AND environment=? AND trust_view=? AND kind='exact' AND raw_value COLLATE BINARY=? LIMIT 1001`).all(store.projectId,store.memoryEnvironment,1,'duplicate-exact-hit') as Array<{detail:string}>;
    assert(plan.some(row=>row.detail.includes('memory_search_exact_raw_lookup')),'raw exact lookup uses the additive partial index');
    const external=new Database(filename);
    const insert=external.prepare(`INSERT INTO memory_search_values(project_id,environment,trust_view,node_id,value_id,path,kind,raw_value,value_hash,path_weight) VALUES(?,?,?,?,?,'test.path','exact',?,'invalid-hash',3)`);
    const transaction=external.transaction(()=>{for(let valueId=10000;valueId<11001;valueId++)insert.run(store!.projectId,store!.memoryEnvironment,1,app,valueId,'duplicate-exact-hit');});transaction();
    external.close();
    const overflow=store.searchPage('duplicate-exact-hit',{mode:'exact',trustYamlSeeds:true});
    assert.equal(overflow.pagination.status,'too_broad');assert.deepEqual(overflow.data,[]);assert.equal('next_cursor' in overflow.pagination,false);
    const exact=store.searchPage('exact-integrity',{mode:'exact'});assert.equal(exact.data.length,1);
    const corrupt=new Database(filename);corrupt.prepare(`UPDATE memory_search_values SET value_hash=? WHERE project_id=? AND environment=? AND trust_view=0 AND node_id=? AND kind='exact' AND raw_value=?`).run('0'.repeat(64),store.projectId,store.memoryEnvironment,app,'exact-integrity');corrupt.close();
    assert.deepEqual(store.searchPage('exact-integrity',{mode:'exact'}).data,[],'raw equality is insufficient without the scoped path hash check');
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('MCP search wire guard measures structured content and escaped text copy',()=>{
  const makeEnvelope=(count:number)=>({ok:true,project_id:'wire-test',session_id:'wire-session',data:Array.from({length:count},(_,index)=>({id:`id-${index}`,type:'screen',stable_key:`key-${index}`,display_name:'\u0001'.repeat(315),trust_basis:'verified_fact',matched_paths:[]})),pagination:{status:'complete',page_size:50},state_revision:0});
  const maxPage=makeEnvelope(8),pageBytes=Buffer.byteLength(JSON.stringify(maxPage),'utf8');assert(pageBytes<=16*1024,'fixture models a page within its Store-side byte budget');
  const maxCallResult={structuredContent:maxPage,content:[{type:'text',text:JSON.stringify(maxPage)}]};assert(Buffer.byteLength(JSON.stringify(maxCallResult),'utf8')<=48*1024,'the maximum escaped page fits the exact wire budget');
  const oversized=makeEnvelope(12),oversizedWire={structuredContent:oversized,content:[{type:'text',text:JSON.stringify(oversized)}]};assert(Buffer.byteLength(JSON.stringify(oversizedWire),'utf8')>48*1024);
  const bounded=memorySearchCallToolResult(oversized,50),wireBytes=Buffer.byteLength(JSON.stringify(bounded),'utf8');
  assert(wireBytes<=48*1024);assert.deepEqual(bounded.structuredContent.data,[]);assert.equal(bounded.structuredContent.pagination.status,'too_broad');assert.equal('next_cursor' in bounded.structuredContent.pagination,false);
});
