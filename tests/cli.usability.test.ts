import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,access,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function cli(cwd:string,...args:string[]){return spawnSync(process.execPath,[path.join(repo,'dist/src/cli/index.js'),...args],{cwd,encoding:'utf8',env:process.env});}
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

test('spawned Codex agent commands use isolated project and user scopes without touching real home/config',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umb-agent-cli-'));
  const home=path.join(root,'home'),codexHome=path.join(root,'codex-home'),project=path.join(root,'project');
  await mkdir(home);await mkdir(codexHome);await mkdir(project);
 try{
  const config=path.join(codexHome,'config.toml');await writeFile(config,'[mcp_servers.fixture]\ncommand = "unchanged"\n');const configBefore=await readFile(config);
  const protectedPaths=[path.join(home,'.copilot','mcp.json'),path.join(home,'.copilot','plugin.json'),path.join(project,'.github','agents','custom.agent.md'),path.join(project,'.github','copilot-instructions.md')];
  for(const file of protectedPaths){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,`sentinel:${path.basename(file)}\n`);}
  const protectedBefore=await Promise.all(protectedPaths.map(file=>readFile(file)));
  const run=(...args:string[])=>spawnSync(process.execPath,[path.join(repo,'dist/src/cli/index.js'),...args],{cwd:project,encoding:'utf8',env:{...process.env,HOME:home,USERPROFILE:home,CODEX_HOME:codexHome}});
  let result=run('agent','list');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/project: absent/);assert.match(result.stdout,/user: absent/);
  result=run('agent','install','--runtime','codex','--scope','project','--dry-run');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Would install codex skill/);await assert.rejects(access(path.join(project,'.agents')));
  result=run('agent','doctor','--runtime','codex','--scope','project','--json');assert.equal(result.status,1);let doctor=JSON.parse(result.stdout);assert.equal(doctor.ok,false);assert.equal(doctor.checks.find((c:any)=>c.id==='codex.skill.project')?.status,'fail');
  result=run('agent','install','--runtime','codex','--scope','project');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Installed codex skill/);
  result=run('agent','list');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/project: installed/);assert.match(result.stdout,/user: absent/);
  result=run('agent','doctor','--runtime','codex','--scope','project','--json');doctor=JSON.parse(result.stdout);const codexSkillCheck=doctor.checks.find((c:any)=>c.id==='codex.skill.project');const codexCliCheck=doctor.checks.find((c:any)=>c.id==='codex.cli');assert.equal(codexSkillCheck?.status,'ok');assert.ok(['ok','fail'].includes(codexCliCheck?.status));assert.equal(doctor.ok,codexCliCheck?.status==='ok');assert.equal(result.status,doctor.ok?0:1,result.stderr);
  result=run('agent','install','--runtime','codex','--scope','user');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Installed codex skill/);
  result=run('agent','list');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/project: installed/);assert.match(result.stdout,/user: installed/);assert.ok(await access(path.join(home,'.agents','skills','umb-ui-testing','SKILL.md')).then(()=>true));
  result=run('agent','uninstall','--runtime','codex','--scope','project','--dry-run');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Would uninstall/);assert.ok(await access(path.join(project,'.agents','skills','umb-ui-testing','SKILL.md')).then(()=>true));
  result=run('agent','uninstall','--runtime','codex','--scope','project');assert.equal(result.status,0,result.stderr);
  result=run('agent','list');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/project: absent/);assert.match(result.stdout,/user: installed/);
  result=run('agent','install','--runtime','copilot','--scope','project','--dry-run');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Would install copilot skill/);await assert.rejects(access(path.join(project,'.github','skills')));
  result=run('agent','install','--runtime','copilot','--scope','project');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Installed copilot skill/);
  result=run('agent','install','--runtime','copilot','--scope','user');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Installed copilot skill/);
  result=run('agent','list');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/copilot project: installed/);assert.match(result.stdout,/copilot user: installed/);assert.match(result.stdout,/codex project: absent/);assert.match(result.stdout,/codex user: installed/);
  result=run('agent','doctor','--runtime','copilot','--scope','project','--json');assert.equal(result.status,0,result.stderr);doctor=JSON.parse(result.stdout);assert.equal(doctor.ok,true);assert.equal(doctor.checks.find((c:any)=>c.id==='copilot.skill.project')?.status,'ok');assert.equal(doctor.checks.find((c:any)=>c.id==='copilot.host-recognition')?.status,'not-tested');assert.match(doctor.checks.find((c:any)=>c.id==='copilot.host-recognition')?.message,/not tested/);
  result=run('agent','uninstall','--runtime','copilot','--scope','project','--dry-run');assert.equal(result.status,0,result.stderr);assert.ok(await access(path.join(project,'.github','skills','umb-ui-testing','SKILL.md')).then(()=>true));
  result=run('agent','uninstall','--runtime','copilot','--scope','user');assert.equal(result.status,0,result.stderr);assert.ok(await access(path.join(project,'.github','skills','umb-ui-testing','SKILL.md')).then(()=>true));
  result=run('agent','uninstall','--runtime','copilot','--scope','project');assert.equal(result.status,0,result.stderr);
  assert.deepEqual(await readFile(config),configBefore);for(let i=0;i<protectedPaths.length;i++)assert.deepEqual(await readFile(protectedPaths[i]!),protectedBefore[i]);
 }finally{await rm(root,{recursive:true,force:true});}
});
