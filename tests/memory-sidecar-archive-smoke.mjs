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
const [{ Store }, { NlpClient }, { createLearningWriter, createProjectLearningWriter, memoryBackfillEnabled, persistentLearningWritesEnabled }] = await Promise.all([
  importDist('src/memory/store.js'), importDist('src/memory/nlp-client.js'), importDist('src/memory/runtime.js'),
]);
assert.equal(memoryBackfillEnabled(), false, 'persistent proposals do not enable bulk backfill');

const temp = await mkdtemp(path.join(os.tmpdir(), 'umb-final-archive-smoke-'));
const secretEnvName = 'UMB_C2_ARCHIVE_SECRET';
const secret = `UMB_ARCHIVE_SECRET_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const oldSecret = process.env[secretEnvName];
process.env[secretEnvName] = secret;
let store;
let writer;
try {
  const filename = path.join(temp, 'memory.sqlite');
  store = new Store(filename, 'phase1c-final-archive');
  const config = { memory: { database: filename, persistent_learning_writes: true, sensitive_paths: [], sensitive_values_env: [secretEnvName] } };
  assert.equal(persistentLearningWritesEnabled(config), true, 'the temporary project explicitly opts in');
  // This runtime module is loaded from payload/dist, so its project factory must resolve the bundled sidecar itself.
  writer = await createProjectLearningWriter(store, config, temp);
  await writer.ensureReady();
  assert.equal(persistentLearningWritesEnabled(config), true);
  const subject = store.applicationSubject();
  const assertion = store.recordAssertion({ session_id: 'release-archive-smoke', subject_node_id: subject.id, passed: true, observed_count: 1 });
  const evidenceRef = { evidence_id: assertion.evidence.id, run_id: assertion.id, subject_node_id: subject.id };
  const proposal = await writer.propose({ observation_id: 'release-real-nlp', type: 'screen', stable_key: 'release-real-nlp', display_name: `Screen ${secret}`, evidence_refs: [evidenceRef] });
  const row = store.db.prepare('SELECT display_name, attributes_json FROM nodes WHERE id=?').get(proposal.id);
  assert.ok(row);
  assert.equal(`${row.display_name}${row.attributes_json}`.includes(secret), false, 'redaction sentinel reached SQLite');
  assert.equal(store.get(proposal.id).verification_status, 'proposed', 'bundled factory proposal stays unverified');
  const attrs = JSON.parse(row.attributes_json);
  assert.ok(attrs.__umb_memory_nlp?.normalized?.length, 'proposal row has NLP metadata');
  assert.equal(attrs.__umb_memory_nlp.normalized.includes(secret), false);
  const observation = store.listCandidateObservations({ source_kind: 'mcp_node', source_key: 'release-real-nlp' })[0];
  assert.ok(observation, 'bundled factory persisted the candidate observation');
  assert.equal(observation.status, 'proposed');
  assert.equal(observation.redacted_source_text.includes(secret), false);
  assert.equal(observation.python_version, '3.13.16');
  assert.equal(observation.spacy_version, '3.8.9');
  assert.equal(observation.model_version, '3.8.0');

  const snapshot = () => ({
    nodes: store.db.prepare('SELECT count(*) AS count FROM nodes WHERE project_id=?').get(store.projectId).count,
    edges: store.db.prepare('SELECT count(*) AS count FROM edges WHERE project_id=?').get(store.projectId).count,
    observations: store.listCandidateObservations().length,
  });
  const beforeFailures = snapshot();
  const missingClient = new NlpClient({ executable: missingModelExecutable, args: [] });
  const missingWriter = createLearningWriter(store, config, { nlp: missingClient });
  try {
    await assert.rejects(missingClient.health(), /NLP sidecar request failed/, 'corrupted onedir should fail health without model data');
    await assert.rejects(missingWriter.propose({ observation_id: 'missing-model-never-writes', type: 'screen', stable_key: 'missing-model-never-writes', display_name: 'Must not persist', evidence_refs: [] }));
    assert.deepEqual(snapshot(), beforeFailures, 'missing model readiness must not commit graph or candidate ledger rows');
  } finally { await missingWriter.close(); }
  const unhealthyWriter = createLearningWriter(store, config, { nlp: {
    async health() { return { version: 3, id: 'unhealthy', ok: true, op: 'health', health: { protocol: 3, python: '3.13.16', spacy: '3.8.9', model: 'en_core_web_sm', model_version: '3.8.0', rules: '1', patterns_schema_version: 1, patterns_digest: 'b'.repeat(64), pattern_count: 1, patterns_ready: true, ready: false } }; },
    async analyze() { throw new Error('must not analyze'); },
  } });
  try {
    await assert.rejects(unhealthyWriter.propose({ observation_id: 'unhealthy-never-writes', type: 'screen', stable_key: 'unhealthy-never-writes', display_name: 'Must not persist', evidence_refs: [] }));
    assert.deepEqual(snapshot(), beforeFailures, 'unhealthy readiness must not commit graph or candidate ledger rows');
  } finally { await unhealthyWriter.close(); }
  assert.equal(persistentLearningWritesEnabled(config), true);
  assert.equal(memoryBackfillEnabled(), false);
  console.log('Extracted relocated sidecar archive smoke passed (bundled factory, exact pins, proposal persistence, redaction, missing/unhealthy no-write).');
} finally {
  await writer?.close();
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
