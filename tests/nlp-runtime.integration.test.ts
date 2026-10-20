import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NlpClient } from '../src/memory/nlp-client.js';
import { createMemoryRedactor } from '../src/memory/redactor.js';
import { Store } from '../src/memory/store.js';
import { createLearningWriter, memoryBackfillEnabled, persistentLearningWritesEnabled } from '../src/memory/runtime.js';
import type { Config } from '../src/config/config.js';

const sidecarExecutable = process.env.UMB_TEST_SIDECAR_EXECUTABLE;

test('extracted sidecar integration: production writer factory redacts and persists a real NLP proposal', { skip: !sidecarExecutable }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-sidecar-integration-'));
  const secretName = 'UMB_C2_TEST_SECRET';
  const secret = `C2_SECRET_${Math.random().toString(36).slice(2)}`;
  const saved = process.env[secretName];
  process.env[secretName] = secret;
  let store: Store | undefined;
  let client: NlpClient | undefined;
  let writer: Awaited<ReturnType<typeof createLearningWriter>> | undefined;
  try {
    assert.equal(memoryBackfillEnabled(), false, 'bulk backfill remains disabled');
    store = new Store(path.join(root, 'memory.sqlite'), 'sidecar-integration');
    client = new NlpClient({ executable: path.resolve(sidecarExecutable!), args: [] });
    const config = { memory: { database: path.join(root, 'memory.sqlite'), persistent_learning_writes: true, sensitive_paths: [], sensitive_values_env: [secretName] } } as Config;
    assert.equal(persistentLearningWritesEnabled(config), true, 'the project explicitly opts in');
    const redactor = createMemoryRedactor(config.memory, process.env);
    const sentToSidecar: string[] = [];
    const realNlp = {
      health: () => client!.health(),
      analyze: (text: string) => { sentToSidecar.push(text); return client!.analyze(text); },
      shutdown: () => client!.shutdown(),
    };
    // Use the enabled production factory while injecting a proxy around the real pinned sidecar.
    writer = createLearningWriter(store, config, { env: process.env, nlp: realNlp });
    const health = await client.health();
    assert.equal(health.health.ready, true);
    assert.equal(health.health.python, '3.13.16');
    assert.equal(health.health.spacy, '3.8.9');
    assert.equal(health.health.model, 'en_core_web_sm');
    assert.equal(health.health.model_version, '3.8.0');
    const inflectedProse = 'The checkout page offers submit buttons.';
    const inflected = await client.analyze(inflectedProse);
    for (const token of inflected.tokens) {
      assert.equal(inflectedProse.slice(token.start, token.end), token.text, 'token text is the source surface substring');
    }
    assert.ok(inflected.normalized.includes('offer'), 'normalization lemmatizes offers');
    assert.ok(inflected.normalized.includes('button'), 'normalization lemmatizes buttons');
    assert.ok(!inflected.normalized.includes('offers'));
    assert.ok(!inflected.normalized.includes('buttons'));
    const extractionInput = redactor.redactText(`🌞 checkout page has submit button. ${secret}`);
    const extraction = await client.analyze(extractionInput);
    assert.deepEqual(extraction.entities.map(entity => [entity.label, entity.text]), [
      ['PAGE', 'checkout page'], ['ACTION', 'submit button'],
    ]);
    for (const entity of extraction.entities) {
      assert.equal(Array.from(extractionInput).slice(entity.start, entity.end).join(''), entity.text);
    }
    assert.equal(extraction.entities[0]!.start, 2, 'spans use Unicode code-point offsets');
    assert.deepEqual(extraction.relations.map(relation => relation.type), ['HAS_ACTION']);
    const evidence = extraction.relations[0]!.evidence;
    assert.equal(Array.from(extractionInput).slice(evidence.start, evidence.end).join(''), 'has');
    assert.equal(JSON.stringify(extraction).includes(secret), false, 'raw sensitive sentinel is absent from protocol output');
    const subject = store.applicationSubject()!;
    const assertion = store.recordAssertion({ session_id: 'real-nlp-factory', subject_node_id: subject.id, passed: true, observed_count: 1, actions: [] });
    const proposal = await writer.propose({
      observation_id:'auto-proposal-0', type: 'screen', stable_key: 'c2-real-nlp', display_name: `A screen ${secret}`,
      evidence_refs: [{ evidence_id: (assertion.evidence as any).id, run_id: assertion.id, subject_node_id: subject.id }],
    }) as { id: string };
    assert.equal(sentToSidecar.length, 1);
    assert.equal(sentToSidecar[0]!.includes(secret), false, 'redaction sentinel never reaches sidecar input');
    const row = store.db.prepare('SELECT display_name, attributes_json FROM nodes WHERE id=?').get(proposal.id) as { display_name: string; attributes_json: string };
    assert.ok(row);
    assert.equal(`${row.display_name}${row.attributes_json}`.includes(secret), false, 'sentinel is absent from persisted node data');
    assert.equal((store.get(proposal.id) as any).verification_status, 'proposed', 'real-sidecar proposal remains unverified');
    const observation = store.listCandidateObservations({ source_kind: 'mcp_node', source_key: 'auto-proposal-0' })[0]!;
    assert.equal(observation.status, 'proposed');
    assert.equal(observation.redacted_source_text!.includes(secret), false);
    const attrs = JSON.parse(row.attributes_json) as Record<string, unknown>;
    const metadata = attrs.__umb_memory_nlp as { normalized: string };
    assert.ok(metadata && metadata.normalized.length > 0, 'NLP metadata was persisted');
    assert.equal(metadata.normalized.includes(secret), false);
    assert.equal(persistentLearningWritesEnabled(config), true);
    assert.equal(memoryBackfillEnabled(), false);

    // A failed readiness response must not allow LearningWriter to create a proposal row.
    const beforeFailed = {
      nodes: (store.db.prepare('SELECT count(*) AS count FROM nodes WHERE project_id=?').get(store.projectId) as { count: number }).count,
      edges: (store.db.prepare('SELECT count(*) AS count FROM edges WHERE project_id=?').get(store.projectId) as { count: number }).count,
      observations: store.listCandidateObservations().length,
    };
    const failing = createLearningWriter(store, config, { env: process.env, nlp: {
      health: async () => ({ version: 3, id: 'failed', ok: true, op: 'health', health: { protocol: 3, python: '3', spacy: '3', model: 'en_core_web_sm', model_version: '3.8.0', rules: '1', patterns_schema_version: 1, patterns_digest: 'b'.repeat(64), pattern_count: 1, patterns_ready: true, ready: false } }),
      analyze: async () => { throw new Error('not reached'); },
    } });
    await assert.rejects(failing.propose({ observation_id:'auto-proposal-1', type: 'screen', stable_key: 'must-not-persist', display_name: 'No proposal', evidence_refs: [] }));
    assert.deepEqual({
      nodes: (store.db.prepare('SELECT count(*) AS count FROM nodes WHERE project_id=?').get(store.projectId) as { count: number }).count,
      edges: (store.db.prepare('SELECT count(*) AS count FROM edges WHERE project_id=?').get(store.projectId) as { count: number }).count,
      observations: store.listCandidateObservations().length,
    }, beforeFailed, 'unhealthy readiness leaves graph and candidate ledger unchanged');
    await failing.close();

    const missingModelExecutable = process.env.UMB_TEST_MISSING_MODEL_EXECUTABLE;
    if (missingModelExecutable) {
      const missingClient = new NlpClient({ executable: path.resolve(missingModelExecutable), args: [] });
      const missingWriter = createLearningWriter(store, config, { env: process.env, nlp: missingClient });
      const missingBefore = {
        nodes: (store.db.prepare('SELECT count(*) AS count FROM nodes WHERE project_id=?').get(store.projectId) as { count: number }).count,
        edges: (store.db.prepare('SELECT count(*) AS count FROM edges WHERE project_id=?').get(store.projectId) as { count: number }).count,
        observations: store.listCandidateObservations().length,
      };
      await assert.rejects(missingWriter.propose({ observation_id:'auto-proposal-2', type: 'screen', stable_key: 'missing-model-must-not-persist', display_name: 'No model', evidence_refs: [] }));
      assert.deepEqual({
        nodes: (store.db.prepare('SELECT count(*) AS count FROM nodes WHERE project_id=?').get(store.projectId) as { count: number }).count,
        edges: (store.db.prepare('SELECT count(*) AS count FROM edges WHERE project_id=?').get(store.projectId) as { count: number }).count,
        observations: store.listCandidateObservations().length,
      }, missingBefore, 'missing model readiness leaves graph and candidate ledger unchanged');
      await missingWriter.close();
    }
    assert.equal(persistentLearningWritesEnabled(config), true);
    assert.equal(memoryBackfillEnabled(), false);
  } finally {
    await writer?.close();
    if (!writer) await client?.shutdown();
    store?.close();
    if (saved === undefined) delete process.env[secretName]; else process.env[secretName] = saved;
    await rm(root, { recursive: true, force: true });
  }
});
