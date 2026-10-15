#!/usr/bin/env node
import { chmod, cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
const payload = path.join(output, 'payload');
await mkdir(payload, { recursive: true });
for (const entry of ['dist', 'node_modules']) await cp(path.join(root, entry), path.join(payload, entry), { recursive: true, force: true, dereference: true });
for (const entry of ['package.json', 'package-lock.json']) await cp(path.join(root, entry), path.join(payload, entry));
await cp(runtime, path.join(payload, 'runtime'), { recursive: true, force: true, dereference: true });
for (const entry of ['LICENSE', 'README.md']) await cp(path.join(root, entry), path.join(output, entry));
for (const entry of ['umb-update-helper.ps1', 'umb-update-helper.sh']) await cp(path.join(root, 'scripts', entry), path.join(output, entry));
if (opts.platform === 'linux') await chmod(path.join(output, 'umb-update-helper.sh'), 0o755);
await writeFile(path.join(output, 'UMB-BUNDLE.json'), JSON.stringify({ format: 2, repository: 'Mikerad1/ui_testing_tool', payload: 'payload' }) + '\n');

if (opts.platform === 'windows') {
  await writeFile(path.join(output, 'umb.cmd'), '@echo off\r\nsetlocal\r\nset "UMB_INSTALL_ROOT=%~dp0."\r\nfor /d %%D in ("%~dp0.umb-update-work-*" "%~dp0.umb-update-stage-*") do if exist "%%~fD" goto preflight\r\nfor %%F in ("%~dp0.umb-update-request.tmp-*") do if exist "%%~fF" goto preflight\r\nif not exist "%~dp0payload\\" goto preflight\r\nif exist "%~dp0.umb-update-request.json" goto preflight\r\ngoto runcli\r\n:preflight\r\npushd "%~dp0."\r\nif errorlevel 1 exit /b 1\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0umb-update-helper.ps1" "%~dp0." -Preflight\r\nset "RECOVERY_EXIT=%ERRORLEVEL%"\r\npopd\r\nif not "%RECOVERY_EXIT%"=="0" exit /b %RECOVERY_EXIT%\r\nif not exist "%~dp0payload\\" exit /b 1\r\n:runcli\r\n"%~dp0payload\\runtime\\node.exe" "%~dp0payload\\dist\\src\\cli\\index.js" %*\r\nset "UMB_EXIT=%ERRORLEVEL%"\r\nif exist "%~dp0.umb-update-request.json" (call :applyupdate & if errorlevel 1 set "UMB_EXIT=1")\r\nexit /b %UMB_EXIT%\r\n:applyupdate\r\npushd "%~dp0."\r\nif errorlevel 1 exit /b 1\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0umb-update-helper.ps1" "%~dp0."\r\nset "HELPER_EXIT=%ERRORLEVEL%"\r\npopd\r\nexit /b %HELPER_EXIT%\r\n');
} else {
  const launcher = path.join(output, 'umb');
  await writeFile(launcher, '#!/bin/sh\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nartifacts=0\nfor entry in "$HERE"/.umb-update-work-* "$HERE"/.umb-update-stage-* "$HERE"/.umb-update-request.tmp-*; do [ -e "$entry" ] || [ -L "$entry" ] || continue; artifacts=1; break; done\nif [ ! -d "$HERE/payload" ] || [ -e "$HERE/.umb-update-request.json" ] || [ -L "$HERE/.umb-update-request.json" ] || [ "$artifacts" -eq 1 ]; then\n  (cd "$HERE" && "$HERE/umb-update-helper.sh" "$HERE" --preflight)\n  recovery_status=$?\n  if [ "$recovery_status" -ne 0 ]; then exit "$recovery_status"; fi\nfi\nif [ ! -d "$HERE/payload" ]; then echo "UMB payload is unavailable; inspect payload.previous and update diagnostics." >&2; exit 1; fi\nUMB_INSTALL_ROOT="$HERE" "$HERE/payload/runtime/bin/node" "$HERE/payload/dist/src/cli/index.js" "$@"\nstatus=$?\nif [ -f "$HERE/.umb-update-request.json" ]; then (cd "$HERE" && "$HERE/umb-update-helper.sh" "$HERE"); helper_status=$?; if [ "$status" -eq 0 ]; then status=$helper_status; fi; fi\nexit "$status"\n');
  await chmod(launcher, 0o755);
}

const bundledNode = path.join(payload, 'runtime', opts.platform === 'windows' ? 'node.exe' : path.join('bin', 'node'));
const sqlitePath = path.join(payload, 'node_modules', 'better-sqlite3');
const smokeCode = `const Database=require(${JSON.stringify(sqlitePath)});const db=new Database(":memory:");const value=db.prepare("select 7 as value").get().value;db.close();if(value!==7)process.exit(1);`;
const smoke = spawnSync(bundledNode, ['-e', smokeCode], { cwd: payload, encoding: 'utf8' });
if (smoke.error || smoke.status !== 0) throw new Error(`Bundled SQLite smoke failed: ${smoke.stderr || smoke.error?.message || smoke.status}`);

async function assertNoSymlinks(directory) {
  for (const entry of await readdir(directory)) {
    const file = path.join(directory, entry);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Release bundle contains a symlink, unsupported by safe self-update: ${file}`);
    if (info.isDirectory()) await assertNoSymlinks(file);
  }
}
await assertNoSymlinks(output);

console.log(`Prepared ${opts.platform} bundle at ${output} (verified no symlink entries)`);
