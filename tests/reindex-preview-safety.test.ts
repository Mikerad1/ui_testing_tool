import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {Store} from '../src/memory/store.js';
import {previewMemoryReindex,type PreviewAnalyzer} from '../src/memory/reindex-preview.js';

test('revalidation journal-mode change is accounted as failed without exposing record data',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'umb-preview-safety-')),filename=path.join(dir,'memory.sqlite');
  const store=new Store(filename,'preview-safety');
  try{
    const modeCheck=new Database(filename,{readonly:true});try{assert.equal(modeCheck.pragma('journal_mode',{simple:true}),'wal');}finally{modeCheck.close();}
    let changed=false;
    const analyzer:PreviewAnalyzer={
      ensureReady:async()=>{},pipelineFingerprint:async()=>'a'.repeat(64),
      analyzeNode:async()=>{
        if(!changed){changed=true;const db=new Database(filename);try{db.pragma('journal_mode = DELETE');}finally{db.close();}}
        return 'b'.repeat(64);
      },
      analyzeEdge:async()=> 'b'.repeat(64),close:async()=>{},
    };
    const summary=await previewMemoryReindex(filename,'preview-safety','legacy',10,analyzer);
    assert.equal(summary.scanned,1);
    assert.equal(summary.failed,1);
    assert.equal(summary.would_migrate,0);
    assert.equal(summary.stale,0);
    assert.equal(summary.unchanged,0);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
