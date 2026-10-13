import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { checkForUpdate, updateBundle, updateCheckEnabled, validateArchivePaths, validateTarTypes, rollbackPayload } from '../src/cli/updater.js';

async function fixture(version = '0.2.1') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-updater-test-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ui-memory-browser', version }));
  await writeFile(path.join(root, 'UMB-BUNDLE.json'), JSON.stringify({ format: 1, repository: 'Mikerad1/ui_testing_tool' }));
  await mkdir(path.join(root, 'runtime')); await mkdir(path.join(root, 'dist/src/cli'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/better-sqlite3'), { recursive: true });
  await writeFile(path.join(root, 'dist/src/cli/index.js'), '');
  await writeFile(path.join(root, 'node_modules/better-sqlite3/package.json'), '{}');
  await writeFile(path.join(root, 'umb'), '');
  await writeFile(path.join(root, 'umb.cmd'), '');
  return root;
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
  await assert.rejects(updateBundle((async () => { called = true; return response({}); }) as typeof fetch, os.tmpdir()), /only in an official prebuilt/);
  assert.equal(called, false);
});

test('root --update flag is accepted by the spawned CLI', () => {
  const cli = path.resolve('src/cli/index.ts');
  const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
  const result = spawnSync(process.execPath, [tsx, cli, '--update'], { encoding: 'utf8', timeout: 15000 });
  assert.match(result.stderr, /only in an official prebuilt/);
  assert.equal(result.status, 1);
});

test('archive validation permits bundle files/directories and rejects traversal and links', () => {
  assert.doesNotThrow(() => validateArchivePaths('umb-linux-x64/\numb-linux-x64/dist/file.js\n', 'umb-linux-x64'));
  assert.throws(() => validateArchivePaths('umb-linux-x64/../../outside', 'umb-linux-x64'), /unsafe path/);
  assert.doesNotThrow(() => validateTarTypes('drwxr-xr-x user/group 0 2026-01-01 00:00 umb-linux-x64/\n-rw-r--r-- user/group 1 2026-01-01 00:00 umb-linux-x64/file'));
  for (const kind of ['l', 'h', 'b', 'c', 'p', 's']) assert.throws(() => validateTarTypes(`${kind}rwxr-xr-x user/group 0 2026-01-01 00:00 entry`), /non-regular or unsafe/);
});

test('Windows ZIP verbose listings reject symlinks and special entry types', () => {
  // Format emitted by `tar -tvf` for ZIP files on the supported Windows bundle path.
  assert.doesNotThrow(() => validateTarTypes('drwxr-xr-x user/group 0 2026-01-01 00:00 umb-windows-x64/\n-rw-r--r-- user/group 1 2026-01-01 00:00 umb-windows-x64/umb.cmd'));
  assert.throws(() => validateTarTypes('lrwxrwxrwx user/group 0 2026-01-01 00:00 umb-windows-x64/runtime -> ../../outside'), /non-regular or unsafe/);
  assert.throws(() => validateTarTypes('brw-r--r-- user/group 0 2026-01-01 00:00 umb-windows-x64/device'), /non-regular or unsafe/);
});

test('incomplete payload rollback reports failure instead of hiding a missing backup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-rollback-test-'));
  const backup = path.join(root, 'backup');
  const payload = path.join(root, 'new-payload');
  await mkdir(backup);
  await writeFile(payload, 'new');
  try {
    await assert.rejects(rollbackPayload(root, backup, ['new-payload'], ['missing-backup']), /restore missing-backup/);
    assert.equal(await (await import('node:fs/promises')).access(payload).then(() => true, () => false), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('update no-op and startup check opt-out do not need network access', { skip: !supportsBundleUpdate }, async () => {
  const root = await fixture();
  let requests = 0;
  try {
    const fetcher = async () => { requests++; return response(release('v0.2.1')); };
    assert.equal(await updateBundle(fetcher as typeof fetch, root), 'Already up to date (0.2.1).');
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
    await assert.rejects(updateBundle(fetcher as typeof fetch, root), /SHA-256 verification failed/);
    assert.equal(await (await import('node:fs/promises')).readFile(path.join(root, 'package.json'), 'utf8').then(s => JSON.parse(s).version), '0.2.1');
  } finally { await rm(root, { recursive: true, force: true }); }
});
