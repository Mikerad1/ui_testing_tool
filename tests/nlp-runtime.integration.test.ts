import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NlpClient } from '../src/memory/nlp-client.js';
import { LearningWriter } from '../src/memory/learning-writer.js';
import { createMemoryRedactor } from '../src/memory/redactor.js';
import { Store } from '../src/memory/store.js';
import { persistentLearningWritesEnabled } from '../src/memory/runtime.js';

const sidecarExecutable = process.env.UMB_TEST_SIDECAR_EXECUTABLE;

test('extracted sidecar integration: real NLP proposal is redacted and persisted only by test writer', { skip: !sidecarExecutable }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-sidecar-integration-'));
  const secretName = 'UMB_C2_TEST_SECRET';
  const secret = `C2_SECRET_${Math.random().toString(36).slice(2)}`;
  const saved = process.env[secretName];
  process.env[secretName] = secret;
  let store: Store | undefined;
  let client: NlpClient | undefined;
  let writer: LearningWriter | undefined;
  try {
    assert.equal(persistentLearningWritesEnabled(), false);
    store = new Store(path.join(root, 'memory.sqlite'), 'sidecar-integration');
    client = new NlpClient({ executable: path.resolve(sidecarExecutable!), args: [] });
    const redactor = createMemoryRedactor({ sensitive_paths: [], sensitive_values_env: [secretName] }, process.env);
    const sentToSidecar: string[] = [];
    writer = new LearningWriter(store, {
      health: () => client!.health(),
      analyze: text => { sentToSidecar.push(text); return client!.analyze(text); },
      shutdown: () => client!.shutdown(),
    }, redactor, true); // Test-local opt-in; production gate remains false.
    const health = await client.health();
    assert.equal(health.health.ready, true);
    assert.equal(health.health.python, '3.13.16');
    assert.equal(health.health.spacy, '3.8.9');
    assert.equal(health.health.model, 'en_core_web_sm');
    assert.equal(health.health.model_version, '3.8.0');
    const proposal = await writer.propose({ type: 'screen', stable_key: 'c2-real-nlp', display_name: `A screen ${secret}` }) as { id: string };
    assert.equal(sentToSidecar.length, 1);
    assert.equal(sentToSidecar[0]!.includes(secret), false, 'redaction sentinel never reaches sidecar input');
    const row = store.db.prepare('SELECT display_name, attributes_json FROM nodes WHERE id=?').get(proposal.id) as { display_name: string; attributes_json: string };
    assert.ok(row);
    assert.equal(`${row.display_name}${row.attributes_json}`.includes(secret), false, 'sentinel is absent from persisted node data');
    const attrs = JSON.parse(row.attributes_json) as Record<string, unknown>;
    const metadata = attrs.__umb_memory_nlp as { normalized: string };
    assert.ok(metadata && metadata.normalized.length > 0, 'NLP metadata was persisted');
    assert.equal(metadata.normalized.includes(secret), false);
    assert.equal(persistentLearningWritesEnabled(), false);

    // A failed readiness response must not allow LearningWriter to create a proposal row.
    const failing = new LearningWriter(store, {
      health: async () => ({ version: 2, id: 'failed', ok: true, op: 'health', health: { protocol: 2, python: '3', spacy: '3', model: 'en_core_web_sm', model_version: '3.8.0', rules: '1', ready: false } }),
      analyze: async () => { throw new Error('not reached'); },
    }, redactor, true);
    const before = (store.db.prepare('SELECT count(*) AS count FROM nodes WHERE stable_key=?').get('must-not-persist') as { count: number }).count;
    await assert.rejects(failing.propose({ type: 'screen', stable_key: 'must-not-persist', display_name: 'No proposal' }));
    const after = (store.db.prepare('SELECT count(*) AS count FROM nodes WHERE stable_key=?').get('must-not-persist') as { count: number }).count;
    assert.equal(after, before);
    await failing.close();

    const missingModelExecutable = process.env.UMB_TEST_MISSING_MODEL_EXECUTABLE;
    if (missingModelExecutable) {
      const missingClient = new NlpClient({ executable: path.resolve(missingModelExecutable), args: [] });
      const missingWriter = new LearningWriter(store, missingClient, redactor, true);
      const missingBefore = (store.db.prepare('SELECT count(*) AS count FROM nodes WHERE stable_key=?').get('missing-model-must-not-persist') as { count: number }).count;
      await assert.rejects(missingWriter.propose({ type: 'screen', stable_key: 'missing-model-must-not-persist', display_name: 'No model' }));
      const missingAfter = (store.db.prepare('SELECT count(*) AS count FROM nodes WHERE stable_key=?').get('missing-model-must-not-persist') as { count: number }).count;
      assert.equal(missingAfter, missingBefore);
      await missingWriter.close();
    }
  } finally {
    await writer?.close();
    if (!writer) await client?.shutdown();
    store?.close();
    if (saved === undefined) delete process.env[secretName]; else process.env[secretName] = saved;
    await rm(root, { recursive: true, force: true });
  }
});
