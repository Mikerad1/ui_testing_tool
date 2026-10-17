import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Config } from '../config/config.js';
import { NlpClient } from './nlp-client.js';
import { createMemoryRedactor, type MemoryRedactor } from './redactor.js';
import { LearningWriter, type NlpProcessor } from './learning-writer.js';
import type { Store } from './store.js';

// Keep production persistence disabled until the Phase 1C release gate passes.
const PERSISTENT_LEARNING_WRITES_ENABLED = false;
export const persistentLearningWritesEnabled=()=>PERSISTENT_LEARNING_WRITES_ENABLED;

/** Resolves the frozen runtime only from a recognized installed bundle. */
export function resolveNlpRuntime(config: Config, moduleUrl = import.meta.url): { executable: string; args: string[] } | undefined {
  try {
    const modulePath = fileURLToPath(moduleUrl);
    const bundleRoot = path.resolve(path.dirname(modulePath), '../../../../');
    const packagedModule = path.resolve(bundleRoot, 'payload', 'dist', 'src', 'memory', 'runtime.js') === modulePath;
    if (packagedModule) {
      const marker = path.join(bundleRoot, 'UMB-BUNDLE.json');
      let recognizedBundle = false;
      if (existsSync(marker)) {
        try {
          const metadata = JSON.parse(readFileSync(marker, 'utf8')) as { format?: unknown; payload?: unknown };
          recognizedBundle = metadata.format === 2 && metadata.payload === 'payload';
        } catch { /* malformed marker is not a valid bundle */ }
      }
      // A module at the packaged location never falls through to developer config, even if damaged.
      if (!recognizedBundle) return undefined;
      const executableName = process.platform === 'win32' ? 'umb-memory-sidecar.exe' : 'umb-memory-sidecar';
      const executable = path.join(bundleRoot, 'payload', 'runtime', 'memory-sidecar', executableName);
      return existsSync(executable) ? { executable, args: [] } : undefined;
    }
    // Source/development fallback only; config overrides are never consulted for recognized bundles.
    if (!config.memory.python_executable) return undefined;
    const sourceModule = modulePath.endsWith(path.join('src', 'memory', 'runtime.ts'));
    const sidecar = path.resolve(path.dirname(modulePath), sourceModule ? '../../python/umb_memory_sidecar.py' : '../../../python/umb_memory_sidecar.py');
    return existsSync(sidecar) ? { executable: config.memory.python_executable, args: [sidecar] } : undefined;
  } catch { return undefined; }
}

export function createLearningWriter(
  store: Store,
  config: Config,
  options: { env?: NodeJS.ProcessEnv; nlp?: NlpProcessor } = {},
): LearningWriter {
  let redactor: MemoryRedactor | undefined;
  try { redactor = createMemoryRedactor(config.memory, options.env ?? process.env); } catch { redactor = undefined; }

  let nlp = PERSISTENT_LEARNING_WRITES_ENABLED ? options.nlp : undefined;
  if (PERSISTENT_LEARNING_WRITES_ENABLED && !nlp) {
    const runtime = resolveNlpRuntime(config);
    if (runtime) try { nlp = new NlpClient(runtime); } catch { nlp = undefined; }
  }
  return new LearningWriter(store, nlp, redactor, PERSISTENT_LEARNING_WRITES_ENABLED);
}
