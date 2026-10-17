import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const bundleRoot = path.resolve(required('UMB_TEST_BUNDLE_ROOT'));
const sidecarExecutable = path.resolve(required('UMB_TEST_SIDECAR_EXECUTABLE'));
const missingModelExecutable = path.resolve(required('UMB_TEST_MISSING_MODEL_EXECUTABLE'));
const payloadRoot = path.join(bundleRoot, 'payload');
const expectedSidecar = path.join(payloadRoot, 'runtime', 'memory-sidecar', process.platform === 'win32' ? 'umb-memory-sidecar.exe' : 'umb-memory-sidecar');
assert.equal(sidecarExecutable, expectedSidecar);
assert.equal(path.basename(missingModelExecutable), process.platform === 'win32' ? 'umb-memory-sidecar.exe' : 'umb-memory-sidecar');
assert.equal(await exists(sidecarExecutable), true);
assert.equal(await exists(missingModelExecutable), true);
const bundleMeta = JSON.parse(await readFile(path.join(bundleRoot, 'UMB-BUNDLE.json'), 'utf8'));
assert.equal(bundleMeta.format, 2);
assert.equal(bundleMeta.payload, 'payload');
await assertNoSymlinks(bundleRoot);

const importDist = relative => import(pathToFileURL(path.join(payloadRoot, 'dist', relative)).href);
const [{ Store }, { NlpClient }, { LearningWriter }, { createMemoryRedactor }, { persistentLearningWritesEnabled }] = await Promise.all([
  importDist('src/memory/store.js'), importDist('src/memory/nlp-client.js'), importDist('src/memory/learning-writer.js'),
  importDist('src/memory/redactor.js'), importDist('src/memory/runtime.js'),
]);
assert.equal(persistentLearningWritesEnabled(), false);

const temp = await mkdtemp(path.join(os.tmpdir(), 'umb-final-archive-smoke-'));
const secretEnvName = 'UMB_C2_ARCHIVE_SECRET';
const secret = `UMB_ARCHIVE_SECRET_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const oldSecret = process.env[secretEnvName];
process.env[secretEnvName] = secret;
let store;
let client;
let writer;
try {
  store = new Store(path.join(temp, 'memory.sqlite'), 'phase1c-final-archive');
  client = new NlpClient({ executable: sidecarExecutable, args: [] });
  const redactor = createMemoryRedactor({ sensitive_paths: [], sensitive_values_env: [secretEnvName] }, process.env);
  const sentTexts = [];
  writer = new LearningWriter(store, {
    health: () => client.health(),
    analyze: text => { sentTexts.push(text); return client.analyze(text); },
    shutdown: () => client.shutdown(),
  }, redactor, true);
  const health = await client.health();
  assert.deepEqual({
    protocol: health.health.protocol, python: health.health.python, spacy: health.health.spacy,
    model: health.health.model, model_version: health.health.model_version, ready: health.health.ready,
  }, { protocol: 2, python: '3.13.16', spacy: '3.8.9', model: 'en_core_web_sm', model_version: '3.8.0', ready: true });
  const proposal = await writer.propose({ type: 'screen', stable_key: 'release-real-nlp', display_name: `Screen ${secret}` });
  assert.equal(sentTexts.length, 1);
  assert.equal(sentTexts[0].includes(secret), false, 'redaction sentinel reached sidecar input');
  const row = store.db.prepare('SELECT display_name, attributes_json FROM nodes WHERE id=?').get(proposal.id);
  assert.ok(row);
  assert.equal(`${row.display_name}${row.attributes_json}`.includes(secret), false, 'redaction sentinel reached SQLite');
  const attrs = JSON.parse(row.attributes_json);
  assert.ok(attrs.__umb_memory_nlp?.normalized?.length, 'proposal row has NLP metadata');
  assert.equal(attrs.__umb_memory_nlp.normalized.includes(secret), false);
  assert.equal(persistentLearningWritesEnabled(), false);

  const missingClient = new NlpClient({ executable: missingModelExecutable, args: [] });
  const missingWriter = new LearningWriter(store, missingClient, redactor, true);
  try {
    const before = store.db.prepare('SELECT count(*) AS count FROM nodes WHERE stable_key=?').get('missing-model-never-writes').count;
    await assert.rejects(missingClient.health(), /NLP sidecar request failed/, 'corrupted onedir should fail health without model data');
    await assert.rejects(missingWriter.propose({ type: 'screen', stable_key: 'missing-model-never-writes', display_name: 'Must not persist' }), /NLP sidecar request failed/);
    const after = store.db.prepare('SELECT count(*) AS count FROM nodes WHERE stable_key=?').get('missing-model-never-writes').count;
    assert.equal(after, before, 'missing model readiness must not commit a proposal');
  } finally { await missingWriter.close(); }
  assert.equal(persistentLearningWritesEnabled(), false);
  console.log('Extracted relocated sidecar archive smoke passed (exact pins, persistence, redaction, missing-model no-write).');
} finally {
  await writer?.close();
  if (!writer) await client?.shutdown();
  store?.close();
  if (oldSecret === undefined) delete process.env[secretEnvName]; else process.env[secretEnvName] = oldSecret;
  await rm(temp, { recursive: true, force: true });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Required archive smoke input missing: ${name}`);
  return value;
}

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

async function assertNoSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `final archive contains symlink: ${filename}`);
    if (entry.isDirectory()) await assertNoSymlinks(filename);
  }
}
