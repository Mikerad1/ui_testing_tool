import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(fullPath));
    else files.push(fullPath);
  }
  return files;
}

test('package-release stages the target sidecar and rejects symlinked onedir inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-package-release-'));
  const nodeRuntime = path.join(root, 'node-runtime');
  const sidecar = path.join(root, 'memory-sidecar');
  const bundle = path.join(root, 'bundle');
  const platform = process.platform === 'win32' ? 'windows' : 'linux';
  const sidecarName = platform === 'windows' ? 'umb-memory-sidecar.exe' : 'umb-memory-sidecar';
  const nodeRelative = platform === 'windows' ? 'node.exe' : path.join('bin', 'node');
  try {
    await mkdir(path.dirname(path.join(nodeRuntime, nodeRelative)), { recursive: true });
    await mkdir(sidecar, { recursive: true });
    const runtimeNode = path.join(nodeRuntime, nodeRelative);
    await writeFile(runtimeNode, await readFile(process.execPath));
    if (platform === 'linux') await chmod(runtimeNode, 0o755);
    await writeFile(path.join(sidecar, sidecarName), 'test executable placeholder');
    if (platform === 'linux') await chmod(path.join(sidecar, sidecarName), 0o755);
    const args = [path.resolve('scripts/package-release.mjs'), '--platform', platform, '--node-runtime', nodeRuntime, '--memory-sidecar', sidecar, '--output', bundle];
    const packaged = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000 });
    assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
    await readFile(path.join(bundle, 'payload', 'runtime', 'memory-sidecar', sidecarName));

    const bundleFiles = await listFiles(bundle);
    assert.equal(
      bundleFiles.some((file) => /(?:^|[\\/])tauri-app(?:[\\/]|$)/i.test(file)),
      false,
      'release bundle must not contain the tests/fixtures/tauri-app source fixture',
    );
    assert.equal(
      bundleFiles.some((file) => /(?:^|[\\/])tauri-acceptance-fixture(?:\.exe)?$/i.test(file)),
      false,
      'release bundle must not contain a compiled tauri-acceptance-fixture binary',
    );

    const target = path.join(sidecar, 'target.dat');
    await writeFile(target, 'symlink target');
    try {
      await symlink(target, path.join(sidecar, 'linked.dat'));
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    const rejected = spawnSync(process.execPath, [
      path.resolve('scripts/package-release.mjs'), '--platform', platform, '--node-runtime', nodeRuntime,
      '--memory-sidecar', sidecar, '--output', path.join(root, 'rejected-bundle'),
    ], { encoding: 'utf8', timeout: 180000 });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /symlink/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
