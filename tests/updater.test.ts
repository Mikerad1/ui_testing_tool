import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { checkForUpdate, publishUpdateRequest, updateBundle, updateCheckEnabled, validateArchivePaths, validateTarTypes } from '../src/cli/updater.js';

async function fixture(version = '0.2.1', withSpaces = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), withSpaces ? 'umb updater test ' : 'umb-updater-test-'));
  const payload = path.join(root, 'payload');
  await writeFile(path.join(root, 'UMB-BUNDLE.json'), JSON.stringify({ format: 2, repository: 'Mikerad1/ui_testing_tool', payload: 'payload' }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root-data-not-payload' }));
  const runtimeBinary = path.join(payload, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  await mkdir(path.dirname(runtimeBinary), { recursive: true }); await mkdir(path.join(payload, 'dist/src/cli'), { recursive: true });
  await mkdir(path.join(payload, 'node_modules/better-sqlite3'), { recursive: true });
  await writeFile(path.join(payload, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version }));
  await writeFile(path.join(payload, 'dist/src/cli/index.js'), '');
  await writeFile(path.join(payload, 'node_modules/better-sqlite3/package.json'), JSON.stringify({ name: 'better-sqlite3', version: '1.0.0' }));
  await copyFile(process.execPath, runtimeBinary);
  await writeFile(path.join(root, 'umb'), ''); await writeFile(path.join(root, 'umb.cmd'), '');
  await copyFile(path.resolve('scripts/umb-update-helper.sh'), path.join(root, 'umb-update-helper.sh'));
  await chmod(path.join(root, 'umb-update-helper.sh'), 0o755);
  await copyFile(path.resolve('scripts/umb-update-helper.ps1'), path.join(root, 'umb-update-helper.ps1'));
  return root;
}
async function completeStage(stage: string) {
  await mkdir(path.join(stage, 'dist/src/cli'), { recursive: true });
  await mkdir(path.join(stage, 'node_modules/better-sqlite3'), { recursive: true });
  await writeFile(path.join(stage, 'dist/src/cli/index.js'), '');
  await writeFile(path.join(stage, 'node_modules/better-sqlite3/package.json'), JSON.stringify({ name: 'better-sqlite3', version: '1.0.0' }));
}
const supportsBundleUpdate = (process.platform === 'linux' || process.platform === 'win32') && process.arch === 'x64';
function response(data: unknown, ok = true): Response {
  return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status: ok ? 200 : 500 });
}
function release(tag: string, assets: unknown[] = []) { return { tag_name: tag, draft: false, prerelease: false, assets }; }

test('startup check returns a newer stable release for official bundle only', async () => {
  const root = await fixture();
  try {
    const fetcher = async () => response(release('v0.3.0'));
    assert.equal(await checkForUpdate(fetcher as typeof fetch, root), 'v0.3.0');
    assert.equal(await checkForUpdate(async () => response(release('v0.2.1')), root), undefined);
    await assert.rejects(checkForUpdate(async () => response(release('v0.2.2-rc.1')), root), /non-stable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('update refuses source installs and does not fetch', async () => {
  let called = false;
  await assert.rejects(updateBundle((async () => { called = true; return response({}); }) as typeof fetch, os.tmpdir()), /current official payload-layout/);
  assert.equal(called, false);
});

test('direct bundled CLI update refuses before fetch or request creation', async () => {
  const root = await fixture();
  let fetched = false;
  try {
    await assert.rejects(updateBundle((async () => { fetched = true; return response(release('0.3.0')); }) as typeof fetch, root, ''), /stable bundle launcher/);
    assert.equal(fetched, false);
    assert.equal(await (await import('node:fs/promises')).access(path.join(root, '.umb-update-request.json')).then(() => true, () => false), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux update refuses before fetching when flock is unavailable', { skip: process.platform !== 'linux' }, async () => {
  const root = await fixture();
  let fetched = false;
  try {
    await assert.rejects(updateBundle((async () => { fetched = true; return response(release('0.3.0')); }) as typeof fetch, root, root, () => false), /requires the flock utility/);
    assert.equal(fetched, false);
    assert.equal(await (await import('node:fs/promises')).access(path.join(root, '.umb-update-request.json')).then(() => true, () => false), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mismatched launcher context refuses before fetching', async () => {
  const root = await fixture();
  let fetched = false;
  try {
    await assert.rejects(updateBundle((async () => { fetched = true; return response(release('0.3.0')); }) as typeof fetch, root, path.join(root, 'elsewhere')), /stable bundle launcher/);
    assert.equal(fetched, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('flat 0.2.6 bundle is rejected without changing its files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-flat-legacy-'));
  await writeFile(path.join(root, 'UMB-BUNDLE.json'), JSON.stringify({ format: 1, repository: 'Mikerad1/ui_testing_tool' }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.2.6' }));
  let fetched = false;
  try {
    await assert.rejects(updateBundle((async () => { fetched = true; return response({}); }) as typeof fetch, root), /flat 0\.2\.6 bundle cannot self-update/);
    assert.equal(fetched, false);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'package.json'), 'utf8')).version, '0.2.6');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('update requests publish atomically without overwriting an existing request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-request-atomic-'));
  const finalPath = path.join(root, '.umb-update-request.json');
  const orphanTemp = path.join(root, '.umb-update-request.tmp-interrupted');
  try {
    await writeFile(orphanTemp, '{"format":');
    assert.equal(await (await import('node:fs/promises')).access(finalPath).then(() => true, () => false), false);
    await publishUpdateRequest(root, path.join(root, '.umb-update-stage-first'), '0.3.0');
    assert.deepEqual(JSON.parse(await (await import('node:fs/promises')).readFile(finalPath, 'utf8')), { format: 1, stage: path.join(root, '.umb-update-stage-first'), version: '0.3.0' });
    await writeFile(finalPath, 'do-not-overwrite');
    await assert.rejects(publishUpdateRequest(root, path.join(root, '.umb-update-stage-second'), '0.4.0'), /another update is pending/);
    assert.equal(await (await import('node:fs/promises')).readFile(finalPath, 'utf8'), 'do-not-overwrite');
    const entries = await (await import('node:fs/promises')).readdir(root);
    assert.equal(entries.some(entry => entry.startsWith('.umb-update-request.tmp-') && entry !== path.basename(orphanTemp)), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('root --update flag is accepted by the spawned CLI', () => {
  const cli = path.resolve('src/cli/index.ts');
  const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
  const result = spawnSync(process.execPath, [tsx, cli, '--update'], { encoding: 'utf8', timeout: 15000 });
  assert.match(result.stderr, /current official payload-layout/);
  assert.equal(result.status, 1);
});

test('archive validation permits bundle files/directories and rejects traversal and links', () => {
  assert.doesNotThrow(() => validateArchivePaths('umb-linux-x64/\numb-linux-x64/dist/file.js\n', 'umb-linux-x64'));
  assert.throws(() => validateArchivePaths('umb-linux-x64/../../outside', 'umb-linux-x64'), /unsafe path/);
  assert.doesNotThrow(() => validateTarTypes('drwxr-xr-x user/group 0 2026-01-01 00:00 umb-linux-x64/\n-rw-r--r-- user/group 1 2026-01-01 00:00 umb-linux-x64/file'));
  for (const kind of ['l', 'h', 'b', 'c', 'p', 's']) assert.throws(() => validateTarTypes(`${kind}rwxr-xr-x user/group 0 2026-01-01 00:00 entry`), /non-regular or unsafe/);
});

test('release archive validation requires one recognized bundle root', () => {
  assert.equal(validateArchivePaths('umb-windows-x64/\numb-windows-x64/payload/runtime/node.exe\n', 'umb-windows-x64'), 'nested');
  assert.throws(() => validateArchivePaths('unknown/file\n', 'umb-windows-x64'), /layout is not recognized/);
  assert.throws(() => validateArchivePaths('umb-windows-x64/payload/file\nother/file\n', 'umb-windows-x64'), /layout is not recognized/);
});

test('Windows ZIP verbose listings reject symlinks and special entry types', () => {
  // Format emitted by `tar -tvf` for ZIP files on the supported Windows bundle path.
  assert.doesNotThrow(() => validateTarTypes('drwxr-xr-x user/group 0 2026-01-01 00:00 umb-windows-x64/\n-rw-r--r-- user/group 1 2026-01-01 00:00 umb-windows-x64/umb.cmd'));
  assert.throws(() => validateTarTypes('lrwxrwxrwx user/group 0 2026-01-01 00:00 umb-windows-x64/runtime -> ../../outside'), /non-regular or unsafe/);
  assert.throws(() => validateTarTypes('brw-r--r-- user/group 0 2026-01-01 00:00 umb-windows-x64/device'), /non-regular or unsafe/);
});

test('Linux helper synchronously swaps one payload with paths containing spaces', { skip: process.platform !== 'linux' }, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'umb helper parent '));
  const root = path.join(parent, 'bundle with spaces'); await mkdir(root);
  const current = path.join(root, 'payload'); await mkdir(path.join(current, 'runtime/bin'), { recursive: true });
  await copyFile(process.execPath, path.join(current, 'runtime/bin/node'));
  await writeFile(path.join(current, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.2.6' }));
  await completeStage(current);
  const stage = path.join(root, '.umb-update-stage-test'); await mkdir(path.join(stage, 'runtime/bin'), { recursive: true });
  await copyFile(process.execPath, path.join(stage, 'runtime/bin/node'));
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.3.0' }));
  await completeStage(stage);
  await writeFile(path.join(root, '.umb-update-request.json'), JSON.stringify({ format: 1, stage, version: '0.3.0' }));
  try {
    const result = spawnSync('sh', [path.resolve('scripts/umb-update-helper.sh'), root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated UMB to 0\.3\.0/);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'payload/package.json'), 'utf8')).version, '0.3.0');
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'payload.previous/package.json'), 'utf8')).version, '0.2.6');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('Linux target verification rollback restores old payload and discards invalid request and stage', { skip: process.platform !== 'linux' }, async () => {
  const root = await fixture('0.2.6', true), stage = path.join(root, '.umb-update-stage-rollback');
  await mkdir(path.join(stage, 'runtime/bin'), { recursive: true });
  await copyFile(process.execPath, path.join(stage, 'runtime/bin/node'));
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.3.0' }));
  await completeStage(stage);
  await writeFile(path.join(root, '.umb-update-request.json'), JSON.stringify({ format: 1, stage, version: '0.3.0' }));
  const bin = await mkdtemp(path.join(os.tmpdir(), 'umb rollback mv ')), wrapper = path.join(bin, 'mv');
  await writeFile(wrapper, `#!/bin/sh\n/bin/mv "$@"\nif [ "$1" = -- ] && [ "$2" = ${JSON.stringify(stage)} ] && [ "$3" = ${JSON.stringify(path.join(root, 'payload'))} ]; then printf '%s' '{"name":"ui-memory-browser","version":"9.9.9"}' > "$3/package.json"; fi\n`);
  await chmod(wrapper, 0o755);
  try {
    const result = spawnSync('sh', [path.resolve('scripts/umb-update-helper.sh'), root], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /target version verification failed.*previous payload restored/);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'payload/package.json'), 'utf8')).version, '0.2.6');
    assert.equal(await (await import('node:fs/promises')).access(path.join(root, '.umb-update-request.json')).then(() => true, () => false), false);
    assert.equal(await (await import('node:fs/promises')).access(stage).then(() => true, () => false), false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(bin, { recursive: true, force: true }); }
});

test('Linux helper without flock warns and allows a valid payload launch but refuses missing payload', { skip: process.platform !== 'linux' }, async () => {
  const root = await fixture('0.2.6', true), bin = await mkdtemp(path.join(os.tmpdir(), 'umb no-flock-path '));
  const stage = path.join(root, '.umb-update-stage-pending'); await mkdir(stage);
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.3.0' }));
  await completeStage(stage);
  await writeFile(path.join(root, '.umb-update-request.json'), JSON.stringify({ format: 1, stage, version: '0.3.0' }));
  await (await import('node:fs/promises')).symlink('/usr/bin/tee', path.join(bin, 'tee'));
  try {
    const helper = path.resolve('scripts/umb-update-helper.sh'), env = { ...process.env, PATH: bin };
    const allowed = spawnSync('/bin/sh', [helper, root, '--preflight'], { encoding: 'utf8', env });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stderr, /flock is missing.*valid.*launching it/);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'payload/package.json'), 'utf8')).version, '0.2.6');
    assert.equal(await (await import('node:fs/promises')).access(path.join(root, '.umb-update-request.json')).then(() => true, () => false), true);
    await rename(path.join(root, 'payload'), path.join(root, 'payload.previous'));
    const blocked = spawnSync('/bin/sh', [helper, root, '--preflight'], { encoding: 'utf8', env });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /current payload is missing or invalid/);
    assert.equal(await (await import('node:fs/promises')).access(path.join(root, 'payload.previous')).then(() => true, () => false), true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(bin, { recursive: true, force: true }); }
});

test('Linux helper refuses mutation while another Node process uses a payload path', { skip: process.platform !== 'linux' }, async () => {
  const root = await fixture('0.2.6', true), stage = path.join(root, '.umb-update-stage-busy');
   await mkdir(stage); await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.3.0' })); await completeStage(stage);
  await writeFile(path.join(root, '.umb-update-request.json'), JSON.stringify({ format: 1, stage, version: '0.3.0' }));
  const user = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', path.join(root, 'payload')], { stdio: 'ignore' });
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    const result = spawnSync('sh', [path.resolve('scripts/umb-update-helper.sh'), root], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /best-effort process scan found UMB using payload/);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'payload/package.json'), 'utf8')).version, '0.2.6');
  } finally { user.kill(); await rm(root, { recursive: true, force: true }); }
});

test('Linux kernel helper lock contends and releases automatically when its holder dies', { skip: process.platform !== 'linux' }, async () => {
  const available = spawnSync('flock', ['--version'], { encoding: 'utf8' });
  if (available.error || available.status !== 0) return;
  const root = await fixture('0.2.6', true), stage = path.join(root, '.umb-update-stage-lock-race');
  await mkdir(path.join(stage, 'runtime/bin'), { recursive: true });
  await copyFile(process.execPath, path.join(stage, 'runtime/bin/node'));
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.3.0' }));
  await completeStage(stage);
  await writeFile(path.join(root, '.umb-update-request.json'), JSON.stringify({ format: 1, stage, version: '0.3.0' }));
  const lock = path.join(root, '.umb-update-lock'), helper = path.resolve('scripts/umb-update-helper.sh');
  const holder = spawn('flock', ['-n', '-F', lock, 'sleep', '30'], { stdio: 'ignore' });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    const blocked = spawnSync('sh', [helper, root], { encoding: 'utf8' });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /kernel update lock/);
    holder.kill('SIGKILL');
    await new Promise<void>(resolve => holder.once('close', () => resolve()));
    const applied = spawnSync('sh', [helper, root], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'payload/package.json'), 'utf8')).version, '0.3.0');
  } finally { holder.kill(); await rm(root, { recursive: true, force: true }); }
});

test('Linux launcher applies a staged update after Node exits without changing caller CWD', { skip: process.platform !== 'linux' }, async () => {
  const root = await fixture('0.2.6', true), callerCwd = path.join(root, 'payload/dist/src/cli'), originalCwd = process.cwd();
  const stage = path.join(root, '.umb-update-stage-launcher'); await mkdir(path.join(stage, 'runtime/bin'), { recursive: true });
  await copyFile(process.execPath, path.join(stage, 'runtime/bin/node'));
  await mkdir(path.join(stage, 'dist/src/cli'), { recursive: true });
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.3.0' }));
  await completeStage(stage);
  const request = path.join(root, '.umb-update-request.json'), cwdRecord = path.join(root, 'caller-cwd.txt');
  await writeFile(path.join(root, 'payload/dist/src/cli/index.js'), `const fs=require('fs');fs.writeFileSync(${JSON.stringify(cwdRecord)},process.cwd());fs.writeFileSync(${JSON.stringify(request)},JSON.stringify({format:1,stage:${JSON.stringify(stage)},version:'0.3.0'}));`);
  const realHelper = path.resolve('scripts/umb-update-helper.sh'), helperCwd = path.join(root, 'helper-cwd.txt');
  await writeFile(path.join(root, 'umb-update-helper.sh'), `#!/bin/sh\nprintf '%s' "$PWD" > ${JSON.stringify(helperCwd)}\nexec sh ${JSON.stringify(realHelper)} "$@"\n`);
  await chmod(path.join(root, 'umb-update-helper.sh'), 0o755);
  await writeFile(path.join(root, 'umb'), '#!/bin/sh\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nif [ ! -d "$HERE/payload" ] || [ -e "$HERE/.umb-update-request.json" ] || [ -L "$HERE/.umb-update-request.json" ]; then\n  (cd "$HERE" && "$HERE/umb-update-helper.sh" "$HERE" --preflight)\n  recovery_status=$?\n  if [ "$recovery_status" -ne 0 ]; then exit "$recovery_status"; fi\nfi\nif [ ! -d "$HERE/payload" ]; then echo "UMB payload is unavailable; inspect payload.previous and update diagnostics." >&2; exit 1; fi\nUMB_INSTALL_ROOT="$HERE" "$HERE/payload/runtime/bin/node" "$HERE/payload/dist/src/cli/index.js" "$@"\nstatus=$?\nif [ -f "$HERE/.umb-update-request.json" ]; then (cd "$HERE" && "$HERE/umb-update-helper.sh" "$HERE"); helper_status=$?; if [ "$status" -eq 0 ]; then status=$helper_status; fi; fi\nexit "$status"\n');
  await chmod(path.join(root, 'umb'), 0o755);
  try {
    const result = spawnSync(path.join(root, 'umb'), [], { cwd: callerCwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await (await import('node:fs/promises')).readFile(cwdRecord, 'utf8'), callerCwd);
    assert.equal(await (await import('node:fs/promises')).readFile(helperCwd, 'utf8'), root);
    assert.equal(process.cwd(), originalCwd);
    await (await import('node:fs/promises')).access(callerCwd);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'payload/package.json'), 'utf8')).version, '0.3.0');
    assert.match(result.stdout, /Updated UMB to 0\.3\.0/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows PowerShell helper applies a request synchronously with paths containing spaces', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture('0.2.6', true);
  const stage = path.join(root, '.umb-update-stage-windows-test'); await mkdir(path.join(stage, 'runtime'), { recursive: true });
  await copyFile(process.execPath, path.join(stage, 'runtime/node.exe'));
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.3.0' }));
  await completeStage(stage);
  await writeFile(path.join(root, '.umb-update-request.json'), JSON.stringify({ format: 1, stage, version: '0.3.0' }));
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'umb-update-helper.ps1'), root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated UMB to 0\.3\.0/);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'payload/package.json'), 'utf8')).version, '0.3.0');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows target verification rollback restores old payload and discards invalid request and stage', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture('0.2.6', true), stage = path.join(root, '.umb-update-stage-rollback');
  await mkdir(path.join(stage, 'runtime'), { recursive: true });
  await copyFile(process.execPath, path.join(stage, 'runtime/node.exe'));
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.3.0' }));
  await completeStage(stage);
  const request = path.join(root, '.umb-update-request.json');
  await writeFile(request, JSON.stringify({ format: 1, stage, version: '0.3.0' }));
  const helper = path.join(root, 'umb-update-helper.ps1'), wrapper = path.join(root, 'force-target-mismatch.ps1');
  await writeFile(wrapper, `function Move-Item { param([string]$LiteralPath,[string]$Destination,[string]$ErrorAction); Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction $ErrorAction; if ($LiteralPath -eq '${stage.replaceAll("'", "''")}' -and $Destination -eq '${path.join(root, 'payload').replaceAll("'", "''")}') { Set-Content -LiteralPath (Join-Path $Destination 'package.json') -Value '{"name":"ui-memory-browser","version":"9.9.9"}' -NoNewline } }; & '${helper.replaceAll("'", "''")}' '${root.replaceAll("'", "''")}'`);
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /target version verification failed.*previous payload restored.*discarded/);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'payload/package.json'), 'utf8')).version, '0.2.6');
    assert.equal(await (await import('node:fs/promises')).access(request).then(() => true, () => false), false);
    assert.equal(await (await import('node:fs/promises')).access(stage).then(() => true, () => false), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows helper lock rejects contention and becomes available when the holder exits', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture('0.2.6', true), stage = path.join(root, '.umb-update-stage-lock-test');
  await mkdir(path.join(stage, 'runtime'), { recursive: true });
  await copyFile(process.execPath, path.join(stage, 'runtime/node.exe'));
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.3.0' }));
  await completeStage(stage);
  await writeFile(path.join(root, '.umb-update-request.json'), JSON.stringify({ format: 1, stage, version: '0.3.0' }));
  const lock = path.join(root, '.umb-update-lock').replaceAll("'", "''");
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$s=[IO.File]::Open('${lock}',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);[Console]::Out.WriteLine('READY');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null;$s.Dispose()`], { stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      holder.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; if (output.includes('READY')) resolve(); });
      holder.once('error', reject);
      holder.once('close', code => { if (!output.includes('READY')) reject(new Error(`Lock holder exited early (${code})`)); });
    });
    const blocked = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'umb-update-helper.ps1'), root], { encoding: 'utf8' });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /exclusive update lock/);
    holder.stdin.end();
    await new Promise<void>(resolve => holder.once('close', () => resolve()));
    const released = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'umb-update-helper.ps1'), root], { encoding: 'utf8' });
    assert.equal(released.status, 0, released.stderr);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'payload/package.json'), 'utf8')).version, '0.3.0');
  } finally { holder.kill(); await rm(root, { recursive: true, force: true }); }
});

test('preflight restores payload.previous and preserves a pending request after interrupted first rename', { skip: !supportsBundleUpdate }, async () => {
  const root = await fixture('0.2.6', true);
  const previous = path.join(root, 'payload.previous'), payload = path.join(root, 'payload');
  const stage = path.join(root, '.umb-update-stage-retry'); await mkdir(path.join(stage, 'runtime', process.platform === 'win32' ? '' : 'bin'), { recursive: true });
  const stagedRuntime = path.join(stage, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  await copyFile(process.execPath, stagedRuntime);
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.3.0' }));
  await completeStage(stage);
  await rename(payload, previous);
  const request = path.join(root, '.umb-update-request.json');
  await writeFile(request, JSON.stringify({ format: 1, stage, version: '0.3.0' }));
  try {
    const result = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'umb-update-helper.ps1'), root, '-Preflight'], { encoding: 'utf8' })
      : spawnSync('sh', [path.resolve('scripts/umb-update-helper.sh'), root, '--preflight'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Recovered UMB 0\.2\.6 from payload\.previous/);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(payload, 'package.json'), 'utf8')).version, '0.2.6');
    assert.equal(await (await import('node:fs/promises')).access(previous).then(() => true, () => false), false);
    assert.equal(await (await import('node:fs/promises')).access(stage).then(() => true, () => false), true);
    assert.equal(await (await import('node:fs/promises')).access(request).then(() => true, () => false), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preflight recognizes payload committed before pending-request cleanup', { skip: !supportsBundleUpdate }, async () => {
  const root = await fixture('0.3.0', true), previous = path.join(root, 'payload.previous');
  await mkdir(path.join(previous, 'runtime', process.platform === 'win32' ? '' : 'bin'), { recursive: true });
  await copyFile(process.execPath, path.join(previous, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node'));
  await writeFile(path.join(previous, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.2.6' }));
  await completeStage(previous);
  const stage = path.join(root, '.umb-update-stage-already-moved');
  const request = path.join(root, '.umb-update-request.json');
  await writeFile(request, JSON.stringify({ format: 1, stage, version: '0.3.0' }));
  try {
    const result = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'umb-update-helper.ps1'), root, '-Preflight'], { encoding: 'utf8' })
      : spawnSync('sh', [path.resolve('scripts/umb-update-helper.sh'), root, '--preflight'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /recovered completed update/);
    assert.equal(await (await import('node:fs/promises')).access(request).then(() => true, () => false), false);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'payload/package.json'), 'utf8')).version, '0.3.0');
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(previous, 'package.json'), 'utf8')).version, '0.2.6');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preflight removes unreferenced work, stage, and partial-request artifacts', { skip: !supportsBundleUpdate }, async () => {
  const root = await fixture('0.2.6', true);
  const artifacts = [
    path.join(root, '.umb-update-work-crash'),
    path.join(root, '.umb-update-stage-orphan'),
    path.join(root, '.umb-update-request.tmp-interrupted'),
  ];
  await mkdir(artifacts[0]!); await mkdir(artifacts[1]!); await writeFile(artifacts[2]!, '{partial');
  try {
    const result = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'umb-update-helper.ps1'), root, '-Preflight'], { encoding: 'utf8' })
      : spawnSync('sh', [path.resolve('scripts/umb-update-helper.sh'), root, '--preflight'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const artifact of artifacts) assert.equal(await (await import('node:fs/promises')).access(artifact).then(() => true, () => false), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stable launcher preflights a missing payload before starting the CLI', { skip: !supportsBundleUpdate }, async () => {
  const root = await fixture('0.2.6', true), callerCwd = await mkdtemp(path.join(os.tmpdir(), 'umb recovery cwd '));
  const payload = path.join(root, 'payload'), previous = path.join(root, 'payload.previous');
  const stage = path.join(root, '.umb-update-stage-launcher-recovery');
  const runtimeDir = path.join(stage, 'runtime', process.platform === 'win32' ? '' : 'bin');
  await mkdir(runtimeDir, { recursive: true });
  await copyFile(process.execPath, path.join(stage, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node'));
  await mkdir(path.join(stage, 'dist/src/cli'), { recursive: true });
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.3.0' }));
  await completeStage(stage);
  const request = path.join(root, '.umb-update-request.json'), seen = path.join(root, 'cli-preflight-state.txt');
  const cli = `const fs=require('fs');const p=${JSON.stringify(payload)};fs.writeFileSync(${JSON.stringify(seen)},JSON.parse(fs.readFileSync(p+'/package.json')).version+'|'+fs.existsSync(${JSON.stringify(request)}));`;
  await writeFile(path.join(payload, 'dist/src/cli/index.js'), cli);
  await rename(payload, previous);
  await writeFile(request, JSON.stringify({ format: 1, stage, version: '0.3.0' }));
  if (process.platform === 'linux') {
    await writeFile(path.join(root, 'umb'), '#!/bin/sh\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nif [ ! -d "$HERE/payload" ] || [ -e "$HERE/.umb-update-request.json" ] || [ -L "$HERE/.umb-update-request.json" ]; then (cd "$HERE" && "$HERE/umb-update-helper.sh" "$HERE" --preflight); rc=$?; [ "$rc" -eq 0 ] || exit "$rc"; fi\nUMB_INSTALL_ROOT="$HERE" "$HERE/payload/runtime/bin/node" "$HERE/payload/dist/src/cli/index.js" "$@"\nstatus=$?\nif [ -f "$HERE/.umb-update-request.json" ]; then (cd "$HERE" && "$HERE/umb-update-helper.sh" "$HERE"); helper_status=$?; if [ "$status" -eq 0 ]; then status=$helper_status; fi; fi\nexit "$status"\n');
    await chmod(path.join(root, 'umb'), 0o755);
  } else {
    await writeFile(path.join(root, 'umb.cmd'), '@echo off\r\nsetlocal\r\nset "UMB_INSTALL_ROOT=%~dp0"\r\nif not exist "%~dp0payload\\" goto preflight\r\nif exist "%~dp0.umb-update-request.json" goto preflight\r\ngoto runcli\r\n:preflight\r\npushd "%~dp0"\r\nif errorlevel 1 exit /b 1\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0umb-update-helper.ps1" "%~dp0" -Preflight\r\nset "RECOVERY_EXIT=%ERRORLEVEL%"\r\npopd\r\nif not "%RECOVERY_EXIT%"=="0" exit /b %RECOVERY_EXIT%\r\nif not exist "%~dp0payload\\" exit /b 1\r\n:runcli\r\n"%~dp0payload\\runtime\\node.exe" "%~dp0payload\\dist\\src\\cli\\index.js" %*\r\nset "UMB_EXIT=%ERRORLEVEL%"\r\nif exist "%~dp0.umb-update-request.json" (call :applyupdate & if errorlevel 1 set "UMB_EXIT=1")\r\nexit /b %UMB_EXIT%\r\n:applyupdate\r\npushd "%~dp0"\r\nif errorlevel 1 exit /b 1\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0umb-update-helper.ps1" "%~dp0"\r\nset "HELPER_EXIT=%ERRORLEVEL%"\r\npopd\r\nexit /b %HELPER_EXIT%\r\n');
  }
  try {
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/c', `call "${path.join(root, 'umb.cmd')}"`], { cwd: callerCwd, encoding: 'utf8' })
      : spawnSync(path.join(root, 'umb'), [], { cwd: callerCwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await (await import('node:fs/promises')).readFile(seen, 'utf8'), '0.2.6|true');
    assert.match(result.stdout, /Recovered UMB 0\.2\.6 from payload\.previous/);
    assert.match(result.stdout, /Updated UMB to 0\.3\.0/);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(payload, 'package.json'), 'utf8')).version, '0.3.0');
  } finally { await rm(root, { recursive: true, force: true }); await rm(callerCwd, { recursive: true, force: true }); }
});

test('Windows launcher runs the helper after Node exits and preserves the caller working directory', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture('0.2.6', true), callerCwd = path.join(root, 'payload/dist/src/cli');
  const runtime = path.join(root, 'payload/runtime'); await mkdir(runtime, { recursive: true });
  await copyFile(process.execPath, path.join(runtime, 'node.exe'));
  const stage = path.join(root, '.umb-update-stage-launcher'); await mkdir(path.join(stage, 'dist/src/cli'), { recursive: true });
  await mkdir(path.join(stage, 'runtime'), { recursive: true }); await copyFile(process.execPath, path.join(stage, 'runtime/node.exe'));
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version: '0.3.0' }));
  await completeStage(stage);
  const request = path.join(root, '.umb-update-request.json'), cwdRecord = path.join(root, 'caller-cwd.txt'), helperCwd = path.join(root, 'helper-cwd.txt'), afterCwd = path.join(root, 'after-cwd.txt');
  const cli = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(cwdRecord)},process.cwd());fs.writeFileSync(${JSON.stringify(request)},JSON.stringify({format:1,stage:${JSON.stringify(stage)},version:'0.3.0'}));`;
  await writeFile(path.join(root, 'payload/dist/src/cli/index.js'), cli);
  const realHelper = path.join(root, 'umb-update-helper-real.ps1');
  await copyFile(path.join(root, 'umb-update-helper.ps1'), realHelper);
  await writeFile(path.join(root, 'umb-update-helper.ps1'), `param([string]$BundleRoot,[switch]$Preflight)\n[IO.File]::WriteAllText(${JSON.stringify(helperCwd)}, (Get-Location).Path)\nif ($Preflight) { & (Join-Path $BundleRoot 'umb-update-helper-real.ps1') $BundleRoot -Preflight } else { & (Join-Path $BundleRoot 'umb-update-helper-real.ps1') $BundleRoot }\nexit $LASTEXITCODE\n`);
  await writeFile(path.join(root, 'umb.cmd'), '@echo off\r\nsetlocal\r\nset "UMB_INSTALL_ROOT=%~dp0"\r\nif not exist "%~dp0payload\\" goto preflight\r\nif exist "%~dp0.umb-update-request.json" goto preflight\r\ngoto runcli\r\n:preflight\r\npushd "%~dp0"\r\nif errorlevel 1 exit /b 1\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0umb-update-helper.ps1" "%~dp0" -Preflight\r\nset "RECOVERY_EXIT=%ERRORLEVEL%"\r\npopd\r\nif not "%RECOVERY_EXIT%"=="0" exit /b %RECOVERY_EXIT%\r\nif not exist "%~dp0payload\\" exit /b 1\r\n:runcli\r\n"%~dp0payload\\runtime\\node.exe" "%~dp0payload\\dist\\src\\cli\\index.js" %*\r\nset "UMB_EXIT=%ERRORLEVEL%"\r\nif exist "%~dp0.umb-update-request.json" (call :applyupdate & if errorlevel 1 set "UMB_EXIT=1")\r\nexit /b %UMB_EXIT%\r\n:applyupdate\r\npushd "%~dp0"\r\nif errorlevel 1 exit /b 1\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0umb-update-helper.ps1" "%~dp0"\r\nset "HELPER_EXIT=%ERRORLEVEL%"\r\npopd\r\nexit /b %HELPER_EXIT%\r\n');
  try {
    const launcher = path.join(root, 'umb.cmd');
    const commandLine = `call "${launcher}" & cd > "${afterCwd}"`;
    const result = spawnSync('cmd.exe', ['/d', '/c', commandLine], { cwd: callerCwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await (await import('node:fs/promises')).readFile(cwdRecord, 'utf8')), callerCwd);
    assert.equal((await (await import('node:fs/promises')).readFile(helperCwd, 'utf8')).toLowerCase(), root.toLowerCase());
    assert.equal((await (await import('node:fs/promises')).readFile(afterCwd, 'utf8')).trim().toLowerCase(), callerCwd.toLowerCase());
    await (await import('node:fs/promises')).access(callerCwd);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'payload/package.json'), 'utf8')).version, '0.3.0');
    assert.match(result.stdout, /Updated UMB to 0\.3\.0/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows generated release launcher applies requests from payload CWD and propagates helper failure', { skip: process.platform !== 'win32' }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'umb generated release bundle '));
  const runtimeRoot = path.join(tempRoot, 'node runtime'), bundleRoot = path.join(tempRoot, 'bundle with spaces');
  await mkdir(runtimeRoot); await copyFile(process.execPath, path.join(runtimeRoot, 'node.exe'));
  try {
    const packaged = spawnSync(process.execPath, [path.resolve('scripts/package-release.mjs'), '--platform', 'windows', '--node-runtime', runtimeRoot, '--output', bundleRoot], { encoding: 'utf8', timeout: 180000 });
    assert.equal(packaged.status, 0, packaged.stderr);
    const currentPayload = path.join(bundleRoot, 'payload'), callerCwd = path.join(currentPayload, 'dist/src/cli');
    const stage = path.join(bundleRoot, '.umb-update-stage-generated-test');
    const request = path.join(bundleRoot, '.umb-update-request.json'), cwdRecord = path.join(tempRoot, 'cli-cwd.txt');
    const fakeCli = `const fs=require('fs'),path=require('path');const root=${JSON.stringify(bundleRoot)},stage=${JSON.stringify(stage)};fs.writeFileSync(${JSON.stringify(cwdRecord)},process.cwd());fs.mkdirSync(path.join(stage,'runtime'),{recursive:true});fs.linkSync(path.join(root,'payload/runtime/node.exe'),path.join(stage,'runtime/node.exe'));fs.mkdirSync(path.join(stage,'dist/src/cli'),{recursive:true});fs.mkdirSync(path.join(stage,'node_modules/better-sqlite3'),{recursive:true});fs.writeFileSync(path.join(stage,'node_modules/better-sqlite3/package.json'),JSON.stringify({name:'better-sqlite3',version:'1.0.0'}));fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({name:'ui-memory-browser',version:'98.7.6'}));fs.copyFileSync(__filename,path.join(stage,'dist/src/cli/index.js'));fs.writeFileSync(${JSON.stringify(request)},JSON.stringify({format:1,stage,version:'98.7.6'}));`;
    await writeFile(path.join(currentPayload, 'dist/src/cli/index.js'), fakeCli);
    const afterCwd = path.join(tempRoot, 'after-cwd.txt'), wrapper = path.join(tempRoot, 'invoke-launcher.cmd');
    await writeFile(wrapper, `@echo off\r\ncall "${path.join(bundleRoot, 'umb.cmd')}"\r\nset "UMB_TEST_EXIT=%ERRORLEVEL%"\r\ncd > "${afterCwd}"\r\nexit /b %UMB_TEST_EXIT%\r\n`);
    const success = spawnSync('cmd.exe', ['/d', '/c', `"${wrapper}"`], { cwd: callerCwd, encoding: 'utf8' });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(await (await import('node:fs/promises')).readFile(cwdRecord, 'utf8'), callerCwd);
    assert.equal((await (await import('node:fs/promises')).readFile(afterCwd, 'utf8')).trim().toLowerCase(), callerCwd.toLowerCase());
    assert.match(success.stdout, /Updated UMB to 98\.7\.6/);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(bundleRoot, 'payload/package.json'), 'utf8')).version, '98.7.6');

    await writeFile(request, '{broken request');
    const failure = spawnSync('cmd.exe', ['/d', '/c', `"${wrapper}"`], { cwd: callerCwd, encoding: 'utf8' });
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /pending request is malformed/);
    assert.equal((await (await import('node:fs/promises')).readFile(afterCwd, 'utf8')).trim().toLowerCase(), callerCwd.toLowerCase());
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
});

test('update no-op and startup check opt-out do not need network access', { skip: !supportsBundleUpdate }, async () => {
  const root = await fixture();
  let requests = 0;
  try {
    const fetcher = async () => { requests++; return response(release('v0.2.1')); };
    const launcherRoot = process.platform === 'win32' ? `${root.toUpperCase()}\\` : root;
    assert.equal(await updateBundle(fetcher as typeof fetch, root, launcherRoot), 'Already up to date (0.2.1).');
    assert.equal(requests, 1);
    assert.equal(updateCheckEnabled(true, undefined), false);
    assert.equal(updateCheckEnabled(false, '1'), false);
    assert.equal(updateCheckEnabled(false, undefined), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('update fails closed on a malformed checksum without changing payload', { skip: !supportsBundleUpdate }, async () => {
  const root = await fixture();
  const url = (name: string) => `https://assets.invalid/${name}`;
  const basename = process.platform === 'win32' ? 'umb-windows-x64.zip' : 'umb-linux-x64.tar.gz';
  const assets = [basename, `${basename}.sha256`].map(name => ({ name, browser_download_url: url(name) }));
  const fetcher = async (input: RequestInfo | URL) => String(input) === 'https://api.github.com/repos/Mikerad1/ui_testing_tool/releases/latest'
    ? response(release('v0.3.0', assets)) : response(String(input).endsWith('.sha256') ? 'not a checksum' : 'archive');
  try {
    await assert.rejects(updateBundle(fetcher as typeof fetch, root, root), /SHA-256 verification failed/);
    assert.equal(await (await import('node:fs/promises')).readFile(path.join(root, 'payload/package.json'), 'utf8').then(s => JSON.parse(s).version), '0.2.1');
  } finally { await rm(root, { recursive: true, force: true }); }
});
