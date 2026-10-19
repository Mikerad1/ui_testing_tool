import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Config } from '../config/config.js';
import { safePath } from '../config/config.js';
import { NlpClient } from './nlp-client.js';
import { createMemoryRedactor, type MemoryRedactor } from './redactor.js';
import { LearningWriter, type NlpProcessor } from './learning-writer.js';
import type { Store } from './store.js';

// Keep persistent learning disabled until the FR-07 integration and review gates pass.
const PERSISTENT_LEARNING_WRITES_ENABLED = false;
const MEMORY_BACKFILL_ENABLED = false;
export const persistentLearningWritesEnabled=()=>PERSISTENT_LEARNING_WRITES_ENABLED;
export const memoryBackfillEnabled=()=>MEMORY_BACKFILL_ENABLED;

/** Resolves the frozen runtime only from a recognized installed bundle. */
export function resolveNlpRuntime(config: Config, moduleUrl = import.meta.url, validatedPatternsFile?: string): { executable: string; args: string[] } | undefined {
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
      if (!existsSync(executable)) return undefined;
      if (config.memory.patterns_file) return validatedPatternsFile && existsSync(validatedPatternsFile)
        ? { executable, args: ['--patterns-file', validatedPatternsFile] } : undefined;
      return { executable, args: [] };
    }
    // Source/development fallback only; config overrides are never consulted for recognized bundles.
    if (!config.memory.python_executable) return undefined;
    const sourceModule = modulePath.endsWith(path.join('src', 'memory', 'runtime.ts'));
    const sidecar = path.resolve(path.dirname(modulePath), sourceModule ? '../../python/umb_memory_sidecar.py' : '../../../python/umb_memory_sidecar.py');
    if (!existsSync(sidecar)) return undefined;
    const args = [sidecar];
    if (config.memory.patterns_file) {
      if (!validatedPatternsFile || !existsSync(validatedPatternsFile)) return undefined;
      args.push('--patterns-file', validatedPatternsFile);
    }
    return { executable: config.memory.python_executable, args };
  } catch { return undefined; }
}

function createWriter(
  store: Store,
  config: Config,
  options: { env?: NodeJS.ProcessEnv; nlp?: NlpProcessor; patternsFile?: string; analysisOnly?: boolean } = {},
): LearningWriter {
  let redactor: MemoryRedactor | undefined;
  try { redactor = createMemoryRedactor(config.memory, options.env ?? process.env); } catch { redactor = undefined; }

  let nlp = (PERSISTENT_LEARNING_WRITES_ENABLED || options.analysisOnly) ? options.nlp : undefined;
  if ((PERSISTENT_LEARNING_WRITES_ENABLED || options.analysisOnly) && !nlp) {
    const runtime = resolveNlpRuntime(config, import.meta.url, options.patternsFile);
    if (runtime) try { nlp = new NlpClient(runtime); } catch { nlp = undefined; }
  }
  return new LearningWriter(store, nlp, redactor, PERSISTENT_LEARNING_WRITES_ENABLED, Boolean(options.analysisOnly));
}

export function createLearningWriter(store:Store,config:Config,options:{env?:NodeJS.ProcessEnv;nlp?:NlpProcessor;patternsFile?:string}={}):LearningWriter{
  return createWriter(store,config,options);
}

/** No-Store analysis surface used only by read-only maintenance previews. */
export async function createMemoryPreviewAnalyzer(config:Config,projectRoot:string,options:{env?:NodeJS.ProcessEnv;nlp?:NlpProcessor}={}){
  const patternsFile=config.memory.patterns_file?await resolveConfiguredPatternsFile(projectRoot,config.memory.patterns_file):undefined;
  const writer=createWriter(undefined as unknown as Store,config,{...options,patternsFile,analysisOnly:true});
  return Object.freeze({
    analyzeNode:(record:Parameters<LearningWriter['analyzePreviewNode']>[0])=>writer.analyzePreviewNode(record),
    analyzeEdge:(record:Parameters<LearningWriter['analyzePreviewEdge']>[0])=>writer.analyzePreviewEdge(record),
    ensureReady:()=>writer.ensureReady(),
    pipelineFingerprint:()=>writer.pipelineFingerprint(),
    close:()=>writer.close(),
  });
}

/** Build a writer only after resolving configured rules safely against the config directory. */
export async function createProjectLearningWriter(store: Store, config: Config, projectRoot: string): Promise<LearningWriter> {
  const patternsFile = config.memory.patterns_file ? await resolveConfiguredPatternsFile(projectRoot, config.memory.patterns_file) : undefined;
  return createLearningWriter(store, config, { patternsFile });
}

export async function resolveConfiguredPatternsFile(projectRoot: string, configuredPath: string): Promise<string> {
  const resolved = await safePath(projectRoot, configuredPath, false);
  if (!statSync(resolved).isFile()) throw new Error('Configured memory pattern file is unavailable');
  return resolved;
}
