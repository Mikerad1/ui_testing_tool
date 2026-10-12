#!/usr/bin/env node
import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Expected --platform, --node-runtime, and --output options');
    result[key.slice(2)] = value;
  }
  if (!['windows', 'linux'].includes(result.platform) || !result['node-runtime'] || !result.output) {
    throw new Error('Usage: package-release.mjs --platform windows|linux --node-runtime <extracted-node-dir> --output <bundle-dir>');
  }
  return result;
}

const opts = options(process.argv.slice(2));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(opts.output);
const runtime = path.resolve(opts['node-runtime']);

for (const required of ['dist', 'node_modules']) await readFile(path.join(root, required, required === 'dist' ? 'src/cli/index.js' : 'better-sqlite3/package.json'));
await readFile(path.join(runtime, opts.platform === 'windows' ? 'node.exe' : 'bin/node'));
await mkdir(output, { recursive: true });
for (const entry of ['dist', 'node_modules']) await cp(path.join(root, entry), path.join(output, entry), { recursive: true, force: true });
for (const entry of ['package.json', 'package-lock.json', 'LICENSE', 'README.md']) await cp(path.join(root, entry), path.join(output, entry));
await cp(runtime, path.join(output, 'runtime'), { recursive: true, force: true });

if (opts.platform === 'windows') {
  await writeFile(path.join(output, 'umb.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\src\\cli\\index.js" %*\r\n');
} else {
  const launcher = path.join(output, 'umb');
  await writeFile(launcher, '#!/bin/sh\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$HERE/runtime/bin/node" "$HERE/dist/src/cli/index.js" "$@"\n');
  await chmod(launcher, 0o755);
}

const bundledNode = path.join(output, 'runtime', opts.platform === 'windows' ? 'node.exe' : path.join('bin', 'node'));
const sqlitePath = path.join(output, 'node_modules', 'better-sqlite3');
const smokeCode = `const Database=require(${JSON.stringify(sqlitePath)});const db=new Database(":memory:");const value=db.prepare("select 7 as value").get().value;db.close();if(value!==7)process.exit(1);`;
const smoke = spawnSync(bundledNode, ['-e', smokeCode], { cwd: output, encoding: 'utf8' });
if (smoke.error || smoke.status !== 0) throw new Error(`Bundled SQLite smoke failed: ${smoke.stderr || smoke.error?.message || smoke.status}`);

console.log(`Prepared ${opts.platform} bundle at ${output}`);
