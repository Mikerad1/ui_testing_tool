import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Config } from '../src/config/config.js';
import { runMemoryDoctor } from '../src/cli/memory-doctor.js';
import { CURRENT_SCHEMA_VERSION } from '../src/memory/store.js';
import type { NlpResponse } from '../src/memory/nlp-protocol.js';
import { Store } from '../src/memory/store.js';

const directories: string[] = [];
const runtime = { executable: '/existing/python', args: [] };
const readyHealth: Extract<NlpResponse, { op: 'health' }> = {
  version: 3,
  id: 'test-health',
  ok: true,
  op: 'health',
  health: { protocol: 3, python: '3.12.0', spacy: '3.8.0', model: 'en_core_web_sm', model_version: '3.8.0', rules: '1', patterns_schema_version: 1, patterns_digest: 'abc', pattern_count: 1, patterns_ready: true, ready: true },
};

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umb-memory-doctor-'));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function configFor(root: string, patternsFile?: string): Awaited<ReturnType<typeof import('../src/config/config.js').loadConfig>> {
  return { root, config: { memory: { database: path.join(root, '.umb', 'memory.sqlite'), ...(patternsFile ? { patterns_file: patternsFile } : {}) } } as Config } as Awaited<ReturnType<typeof import('../src/config/config.js').loadConfig>>;
}

function overrides(
  loaded: Awaited<ReturnType<typeof import('../src/config/config.js').loadConfig>>,
  health: () => Promise<Extract<NlpResponse, { op: 'health' }>>,
) {
  let closed = false;
  return {
    deps: {
      loadConfig: async () => loaded,
      resolveRuntime: () => runtime,
      createClient: () => ({ probeHealth: health, shutdown: async () => { closed = true; } }),
    },
    wasClosed: () => closed,
  };
}

test('config errors fail safely without leaking parser details', async () => {
  const result = await runMemoryDoctor('missing.yaml', {
    loadConfig: async () => { throw new Error('secret parser detail'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks[0]?.id, 'memory-doctor.config');
  assert.doesNotMatch(JSON.stringify(result), /secret parser detail/);
});

test('missing runtime is reported and sidecar is not started', async () => {
  const root = await tempDir();
  const result = await runMemoryDoctor('umb.config.yaml', {
    loadConfig: async () => configFor(root),
    resolveRuntime: () => undefined,
  });
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.nlp-runtime')?.status, 'fail');
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.nlp-health')?.status, 'fail');
  await assert.rejects(access(path.join(root, '.umb')));
});

test('ready sidecar metadata is reported and missing database remains absent', async () => {
  const root = await tempDir();
  const injected = overrides(configFor(root), async () => readyHealth);
  const result = await runMemoryDoctor('umb.config.yaml', injected.deps);
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.nlp-health')?.status, 'ok');
  assert.match(result.checks.find(item => item.id === 'memory-doctor.nlp-rules-version')?.message ?? '', /Pattern schema 1/);
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.database')?.status, 'warning');
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.pattern-loading')?.status, 'warning');
  await assert.rejects(access(path.join(root, '.umb')));
  assert.equal(injected.wasClosed(), true);
});

test('configured project patterns are distinguished from packaged defaults', async () => {
  const root = await tempDir();
  const patternsPath = path.join(root, 'project-patterns.json');
  await writeFile(patternsPath, '{"entity_rules":[],"relation_rules":[]}');
  const loaded = configFor(root, 'project-patterns.json');
  let resolvedPatternsFile: string | undefined;
  const injected = overrides(loaded, async () => readyHealth);
  const result = await runMemoryDoctor('umb.config.yaml', {
    ...injected.deps,
    resolveRuntime: (_config, _moduleUrl, configuredPath) => {
      resolvedPatternsFile = configuredPath;
      return runtime;
    },
  });
  assert.equal(resolvedPatternsFile, patternsPath);
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.pattern-loading')?.status, 'ok');
  assert.match(result.checks.find(item => item.id === 'memory-doctor.pattern-loading')?.message ?? '', /Configured project patterns loaded/);
});

test('missing configured patterns fail closed without claiming packaged fallback', async () => {
  const root = await tempDir();
  const loaded = configFor(root, 'missing-patterns.json');
  let receivedPatternsFile: string | undefined;
  const result = await runMemoryDoctor('umb.config.yaml', {
    ...overrides(loaded, async () => readyHealth).deps,
    resolveRuntime: (_config, _moduleUrl, configuredPath) => {
      receivedPatternsFile = configuredPath;
      return undefined;
    },
  });
  assert.equal(receivedPatternsFile, undefined);
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.pattern-file')?.status, 'fail');
  const patterns = result.checks.find(item => item.id === 'memory-doctor.pattern-loading');
  assert.equal(patterns?.status, 'fail');
  assert.match(patterns?.message ?? '', /not a fallback/);
  assert.doesNotMatch(JSON.stringify(result), /secret|missing-patterns\.json/);
});

test('invalid configured patterns report no effective rules and never suggest packaged substitution', async () => {
  const root = await tempDir();
  const patternsPath = path.join(root, 'invalid-patterns.json');
  await writeFile(patternsPath, '{ invalid json');
  const invalidHealth = { ...readyHealth, health: { ...readyHealth.health, patterns_digest: 'invalid', pattern_count: 0, patterns_ready: false, ready: false } };
  const result = await runMemoryDoctor('umb.config.yaml', overrides(configFor(root, 'invalid-patterns.json'), async () => invalidHealth).deps);
  const loading = result.checks.find(item => item.id === 'memory-doctor.pattern-loading');
  const rules = result.checks.find(item => item.id === 'memory-doctor.nlp-rules-version');
  assert.equal(loading?.status, 'fail');
  assert.match(loading?.message ?? '', /not a fallback/);
  assert.match(rules?.remediation ?? '', /do not fall back to packaged rules/);
  assert.doesNotMatch(JSON.stringify(result), /invalid json|invalid-patterns\.json/);
});

test('empty rules distinguish healthy normalization from unavailable extraction', async () => {
  const root = await tempDir();
  const empty = { ...readyHealth, health: { ...readyHealth.health, pattern_count: 0, patterns_ready: false } };
  const result = await runMemoryDoctor('umb.config.yaml', overrides(configFor(root), async () => empty).deps);
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.nlp-health')?.status, 'ok');
  const patterns = result.checks.find(item => item.id === 'memory-doctor.nlp-rules-version');
  assert.equal(patterns?.status, 'fail');
  assert.match(patterns?.remediation ?? '', /Configure memory\.patterns_file with project rules/);
});

test('not-ready and unavailable sidecars fail with sanitized diagnostics and close clients', async () => {
  const root = await tempDir();
  const notReadyHealth = { ...readyHealth, health: { ...readyHealth.health, spacy: 'unavailable', model_version: 'unavailable', ready: false } };
  const notReady = overrides(configFor(root), async () => notReadyHealth);
  const result = await runMemoryDoctor('umb.config.yaml', notReady.deps);
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.nlp-health')?.status, 'fail');
  assert.equal(notReady.wasClosed(), true);

  const unavailable = overrides(configFor(root), async () => { throw new Error('secret stderr/request'); });
  const unavailableResult = await runMemoryDoctor('umb.config.yaml', unavailable.deps);
  assert.equal(unavailableResult.checks.find(item => item.id === 'memory-doctor.nlp-health')?.status, 'fail');
  assert.equal(unavailableResult.checks.find(item => item.id === 'memory-doctor.nlp-rules-version')?.status, 'warning');
  assert.match(unavailableResult.checks.find(item => item.id === 'memory-doctor.pattern-loading')?.message ?? '', /sidecar health is unavailable/);
  assert.doesNotMatch(unavailableResult.checks.find(item => item.id === 'memory-doctor.pattern-loading')?.message ?? '', /no NLP runtime/);
  assert.doesNotMatch(JSON.stringify(unavailableResult), /secret stderr\/request/);
  assert.equal(unavailable.wasClosed(), true);
});

test('corrupt database fails without changing file bytes', async () => {
  const root = await tempDir();
  const dbPath = path.join(root, '.umb', 'memory.sqlite');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(dbPath), { recursive: true }));
  await writeFile(dbPath, 'not a sqlite database');
  const before = await readFile(dbPath);
  const injected = overrides(configFor(root), async () => readyHealth);
  const result = await runMemoryDoctor('umb.config.yaml', injected.deps);
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.database')?.status, 'fail');
  assert.deepEqual(await readFile(dbPath), before);
});

test('outdated database is inspected without migrations or file mutation', async () => {
  const root = await tempDir();
  const dbPath = path.join(root, '.umb', 'memory.sqlite');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE schema_migrations (version INTEGER); INSERT INTO schema_migrations VALUES (0);');
  db.close();
  const before = await readFile(dbPath);
  const injected = overrides(configFor(root), async () => readyHealth);
  const result = await runMemoryDoctor('umb.config.yaml', injected.deps);
  const schemaCheck = result.checks.find(item => item.id === 'memory-doctor.database-schema');
  assert.equal(schemaCheck?.status, 'fail');
  assert.match(schemaCheck?.remediation ?? '', /Do not run migrations/);
  assert.notEqual(CURRENT_SCHEMA_VERSION, 0);
  assert.deepEqual(await readFile(dbPath), before);
});

test('current database passes read-only integrity/schema checks without mutation', async () => {
  const root = await tempDir();
  const dbPath = path.join(root, '.umb', 'memory.sqlite');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(dbPath), { recursive: true });
  const store = await Store.open(dbPath, 'doctor-fixture');
  store.close();
  const before = await readFile(dbPath);
  const injected = overrides(configFor(root), async () => readyHealth);
  const result = await runMemoryDoctor('umb.config.yaml', injected.deps);
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.database-integrity')?.status, 'ok');
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.database-foreign-keys')?.status, 'ok');
  assert.equal(result.checks.find(item => item.id === 'memory-doctor.database-schema')?.status, 'ok');
  assert.deepEqual(await readFile(dbPath), before);
});

test('migration history gaps fail even when the maximum version is current', async () => {
  const root = await tempDir();
  const dbPath = path.join(root, '.umb', 'memory.sqlite');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
  const insert = db.prepare('INSERT INTO schema_migrations VALUES (?, ?)');
  for (let version = 1; version <= CURRENT_SCHEMA_VERSION; version++) {
    if (version !== 6) insert.run(version, 'fixture');
  }
  db.close();
  const before = await readFile(dbPath);
  const injected = overrides(configFor(root), async () => readyHealth);
  const result = await runMemoryDoctor('umb.config.yaml', injected.deps);
  const schemaCheck = result.checks.find(item => item.id === 'memory-doctor.database-schema');
  assert.equal(schemaCheck?.status, 'fail');
  assert.match(schemaCheck?.remediation ?? '', /Do not run migrations/);
  assert.deepEqual(await readFile(dbPath), before);
});

test('strict older migration prefix recommends backup before normal migrations', async () => {
  const root = await tempDir();
  const dbPath = path.join(root, '.umb', 'memory.sqlite');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
  const insert = db.prepare('INSERT INTO schema_migrations VALUES (?, ?)');
  for (let version = 1; version < CURRENT_SCHEMA_VERSION; version++) insert.run(version, 'fixture');
  db.close();
  const injected = overrides(configFor(root), async () => readyHealth);
  const result = await runMemoryDoctor('umb.config.yaml', injected.deps);
  const schemaCheck = result.checks.find(item => item.id === 'memory-doctor.database-schema');
  assert.equal(schemaCheck?.status, 'fail');
  assert.match(schemaCheck?.remediation ?? '', /Back up the database/);
  assert.match(schemaCheck?.remediation ?? '', /apply remaining migrations/);
});
