import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveNlpRuntime } from '../src/memory/runtime.js';
import type { Config } from '../src/config/config.js';

const config = { memory: { python_executable: '/hostile/configured/python' } } as Config;

async function makeBundle(root: string, marker?: string, executable = true) {
  const modulePath = path.join(root, 'payload', 'dist', 'src', 'memory', 'runtime.js');
  await mkdir(path.dirname(modulePath), { recursive: true });
  if (marker !== undefined) await writeFile(path.join(root, 'UMB-BUNDLE.json'), marker);
  if (executable) {
    const executableName = process.platform === 'win32' ? 'umb-memory-sidecar.exe' : 'umb-memory-sidecar';
    const executablePath = path.join(root, 'payload', 'runtime', 'memory-sidecar', executableName);
    await mkdir(path.dirname(executablePath), { recursive: true });
    await writeFile(executablePath, 'test fixture');
  }
  return modulePath;
}

test('packaged module uses only the sidecar at the bundle path, never configured Python', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-runtime-bundle-'));
  try {
    const modulePath = await makeBundle(root, JSON.stringify({ format: 2, repository: 'test', payload: 'payload' }));
    const executableName = process.platform === 'win32' ? 'umb-memory-sidecar.exe' : 'umb-memory-sidecar';
    assert.deepEqual(resolveNlpRuntime(config, pathToFileURL(modulePath).href), {
      executable: path.join(root, 'payload', 'runtime', 'memory-sidecar', executableName), args: [],
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('damaged packaged bundles fail closed instead of falling back to configured Python', async () => {
  for (const [label, marker, executable] of [
    ['missing marker', undefined, true],
    ['malformed marker', '{bad json', true],
    ['unsupported marker', JSON.stringify({ format: 1, payload: 'payload' }), true],
    ['missing sidecar', JSON.stringify({ format: 2, payload: 'payload' }), false],
  ] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), `umb-runtime-${label.replaceAll(' ', '-')}-`));
    try {
      const modulePath = await makeBundle(root, marker, executable);
      assert.equal(resolveNlpRuntime(config, pathToFileURL(modulePath).href), undefined, label);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('only non-packaged development modules use configured Python, with source and dist sidecar paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-runtime-dev-'));
  try {
    const sourceModule = path.join(root, 'src', 'memory', 'runtime.ts');
    const distModule = path.join(root, 'dist', 'src', 'memory', 'runtime.js');
    const sidecar = path.join(root, 'python', 'umb_memory_sidecar.py');
    await mkdir(path.dirname(sourceModule), { recursive: true });
    await mkdir(path.dirname(distModule), { recursive: true });
    await mkdir(path.dirname(sidecar), { recursive: true });
    await writeFile(sidecar, '# development sidecar');
    for (const modulePath of [sourceModule, distModule]) {
      assert.deepEqual(resolveNlpRuntime(config, pathToFileURL(modulePath).href), { executable: config.memory.python_executable, args: [sidecar] });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
