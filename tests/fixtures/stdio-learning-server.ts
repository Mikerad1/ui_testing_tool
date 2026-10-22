import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../../src/memory/store.js';
import { LearningWriter, type NlpProcessor } from '../../src/memory/learning-writer.js';
import { createMemoryRedactor } from '../../src/memory/redactor.js';
import { serve } from '../../src/mcp/server.js';
import type { Config } from '../../src/config/config.js';
import { withTestEvidence } from '../helpers/learning.js';

const root = process.argv[2]!;
const log = process.argv[3]!;
const store = new Store(path.join(root, 'memory.sqlite'), 'stdio-drain','local');
const nlp: NlpProcessor = {
  async health() {
    return { version: 3, id: 'health', ok: true, op: 'health', health: { protocol: 3, python: 'test', spacy: 'fake', model: 'fake', model_version: '1.0.0', rules: '1',patterns_schema_version:1,patterns_digest:'b'.repeat(64),pattern_count:0,patterns_ready:false,ready: true } };
  },
  async analyze(text) {
    await appendFile(log, 'analyze-start\n');
    await new Promise(resolve => setTimeout(resolve, 300));
    await appendFile(log, 'analyze-done\n');
    return { version: 3, id: 'analyze', ok: true, op: 'analyze', normalized: text.toLowerCase(), tokens: [], entities: [],relations:[] };
  },
  async shutdown() { await appendFile(log, 'shutdown\n'); },
};
const writer = withTestEvidence(new LearningWriter(store, nlp, createMemoryRedactor({ sensitive_paths: [], sensitive_values_env: [] }, {})), store);
const config = { project: { id: 'stdio-drain' }, memory: { persistent_learning_writes: true } } as Config;
const stop = await serve(config, store, { revision: 0 } as any, { stdio: true, knowledgeRoot: root, learningWriter: writer });

process.stdin.once('end', () => {
  void (async () => {
    try { await stop(); } finally { try { await writer.close(); } finally { store.close(); } }
  })();
});
