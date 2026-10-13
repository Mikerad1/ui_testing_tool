import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,access,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function cli(cwd:string,...args:string[]){return spawnSync(process.execPath,[path.join(repo,'dist/src/cli/index.js'),...args],{cwd,encoding:'utf8'});}
const config=(knowledge='./knowledge')=>`version: 1\nproject: {id: demo, name: Demo, base_url: http://127.0.0.1:3000}\nserver: {host: 127.0.0.1, port: 7317, auth: {mode: none}}\nknowledge: {path: ${knowledge}}\n`;

test('spawned init serializes YAML safely, validates ids/URLs, and refuses overwrite',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-init-cli-'));
 try{
  let result=cli(root,'init','--project','a: [bad','--url','http://127.0.0.1:3000','--yes');assert.equal(result.status,1);await assert.rejects(access(path.join(root,'umb.config.yaml')));await assert.rejects(access(path.join(root,'umb-knowledge')));
  result=cli(root,'init','--project','safe_demo-1','--url','https://example.test/path','--yes');assert.equal(result.status,0,result.stderr);const text=await readFile(path.join(root,'umb.config.yaml'),'utf8');assert.match(text,/id: safe_demo-1/);assert.match(text,/base_url: https:\/\/example\.test\/path/);
  result=cli(root,'init','--yes');assert.equal(result.status,1);assert.match(result.stderr,/already exists/);
  const invalid=await mkdtemp(path.join(os.tmpdir(),'umb-init-invalid-'));try{result=cli(invalid,'init','--url','file:///etc/passwd','--yes');assert.equal(result.status,1);await assert.rejects(access(path.join(invalid,'umb.config.yaml')));}finally{await rm(invalid,{recursive:true,force:true});}
 }finally{await rm(root,{recursive:true,force:true});}
});

test('opt-in starter knowledge creates documented sample files that validate',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-starter-cli-'));
 try{
  const result=cli(root,'init','--project','starter-demo','--starter-knowledge','--yes');assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/application\.yaml, home\.yaml/);
  const application=await readFile(path.join(root,'umb-knowledge','application.yaml'),'utf8');const home=await readFile(path.join(root,'umb-knowledge','home.yaml'),'utf8');assert.match(application,/kind: application/);assert.match(home,/kind: screen/);
  const validated=cli(root,'knowledge','validate','--json');const json=JSON.parse(validated.stdout);assert.equal(validated.status,0);assert.equal(json.count,2);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('spawned doctor and knowledge validation JSON success/failure stay parseable',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-json-cli-'));
 try{
  await writeFile(path.join(root,'umb.yaml'),config());
  await mkdir(path.join(root,'knowledge'));
  let result=cli(root,'doctor','--config','umb.yaml','--json');assert.ok(result.stdout.trim());let parsed=JSON.parse(result.stdout);assert.equal(typeof parsed.ok,'boolean');assert.ok(Array.isArray(parsed.checks));for(const item of parsed.checks)assertDiagnostic(item);
  result=cli(root,'doctor','--config','missing.yaml','--json');parsed=JSON.parse(result.stdout);assert.equal(result.status,1);assert.equal(parsed.ok,false);assert.ok(result.stderr.length===0,'handled doctor diagnostics should not emit errors to stderr');for(const item of parsed.checks)assertDiagnostic(item);
  result=cli(root,'knowledge','validate','--config','umb.yaml','--json');parsed=JSON.parse(result.stdout);assert.equal(parsed.ok,true);assert.equal(parsed.count,0);for(const item of parsed.diagnostics)assertDiagnostic(item);
  await writeFile(path.join(root,'knowledge','bad.yaml'),'kind: unknown\n');
  result=cli(root,'knowledge','validate','--config','umb.yaml','--json');parsed=JSON.parse(result.stdout);assert.equal(result.status,1);assert.equal(parsed.ok,false);assert.equal(parsed.diagnostics[0].id,'knowledge.validation');assert.equal(result.stderr,'');for(const item of parsed.diagnostics)assertDiagnostic(item);
 }finally{await rm(root,{recursive:true,force:true});}
});

function assertDiagnostic(value:unknown){assert.ok(value&&typeof value==='object');const d=value as Record<string,unknown>;assert.equal(typeof d.id,'string');assert.ok(['ok','warning','fail'].includes(String(d.status)));assert.equal(typeof d.message,'string');assert.equal(typeof d.remediation,'string');}

test('spawned CLI help advertises workflow examples and JSON diagnostics',()=>{
 const result=cli(repo,'--help');assert.equal(result.status,0);assert.match(result.stdout,/umb init/);assert.match(result.stdout,/knowledge validate --json/);assert.match(result.stdout,/doctor --json/);
});
