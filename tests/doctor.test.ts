import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,stat,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runDoctor} from '../src/cli/doctor.js';

test('doctor reports invalid config without leaking configuration values',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-doctor-'));
 try{const config=path.join(root,'umb.yaml');await writeFile(config,'invalid: [\n');const result=await runDoctor(config);assert.equal(result.ok,false);assert.equal(result.checks[0].status,'fail');}finally{await rm(root,{recursive:true,force:true});}
});

test('doctor validates YAML and remains observational for absent paths',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-doctor-'));
 try{const config=path.join(root,'umb.yaml');await writeFile(config,`version: 1\nproject: {id: demo, name: Demo, base_url: http://127.0.0.1:3000}\nserver: {host: 127.0.0.1, port: 7317, auth: {mode: none}}\nmemory: {database: ./.umb/memory.sqlite}\nknowledge: {path: ./knowledge}\nartifacts: {directory: ./.umb/artifacts}\n`);const result=await runDoctor(config);assert.equal(result.checks.find(c=>c.name==='knowledge')?.status,'ok');assert.equal(result.checks.find(c=>c.name==='database')?.status,'warning');await assert.rejects(stat(path.join(root,'.umb')));await assert.rejects(stat(path.join(root,'knowledge')));assert.equal((await readFile(config,'utf8')).includes('version: 1'),true);}finally{await rm(root,{recursive:true,force:true});}
});

test('doctor diagnoses invalid YAML and missing token',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-doctor-'));
 try{await mkdir(path.join(root,'knowledge'));await writeFile(path.join(root,'knowledge','bad.yaml'),'kind: unknown\n');const config=path.join(root,'umb.yaml');await writeFile(config,`version: 1\nproject: {id: demo, name: Demo, base_url: http://127.0.0.1}\nserver: {host: 127.0.0.1, port: 7317, auth: {mode: token, token_env: DOCTOR_TEST_MISSING_TOKEN}}\nknowledge: {path: ./knowledge}\n`);delete process.env.DOCTOR_TEST_MISSING_TOKEN;const result=await runDoctor(config);assert.equal(result.checks.find(c=>c.name==='knowledge')?.status,'fail');assert.equal(result.checks.find(c=>c.name==='token')?.status,'fail');}finally{await rm(root,{recursive:true,force:true});}
});
