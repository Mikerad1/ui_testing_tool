import { fileURLToPath } from 'node:url';
import type { Config } from '../config/config.js';
import { NlpClient } from './nlp-client.js';
import { createMemoryRedactor, type MemoryRedactor } from './redactor.js';
import { LearningWriter, type NlpProcessor } from './learning-writer.js';
import type { Store } from './store.js';

// Keep production persistence disabled until the Phase 1C release gate passes.
const PERSISTENT_LEARNING_WRITES_ENABLED = false;

export function createLearningWriter(
  store: Store,
  config: Config,
  options: { env?: NodeJS.ProcessEnv; nlp?: NlpProcessor } = {},
): LearningWriter {
  let redactor: MemoryRedactor | undefined;
  try { redactor = createMemoryRedactor(config.memory, options.env ?? process.env); } catch { redactor = undefined; }

  let nlp = PERSISTENT_LEARNING_WRITES_ENABLED ? options.nlp : undefined;
  if (PERSISTENT_LEARNING_WRITES_ENABLED && !nlp && config.memory.python_executable) {
    try {
      const sidecar = fileURLToPath(new URL('../../../python/umb_memory_sidecar.py', import.meta.url));
      nlp = new NlpClient({ executable: config.memory.python_executable, args: [sidecar] });
    } catch { nlp = undefined; }
  }
  return new LearningWriter(store, nlp, redactor, PERSISTENT_LEARNING_WRITES_ENABLED);
}
