import { access } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { loadConfig, safePath } from '../config/config.js';
import { resolveNlpRuntime } from '../memory/runtime.js';
import { CURRENT_SCHEMA_VERSION } from '../memory/store.js';
import { NlpClient } from '../memory/nlp-client.js';

export type MemoryDoctorCheck = {
  id: string;
  name: string;
  status: 'ok' | 'warning' | 'fail';
  message: string;
  remediation: string;
};

export type MemoryDoctorResult = { ok: boolean; checks: MemoryDoctorCheck[] };

type Runtime = NonNullable<ReturnType<typeof resolveNlpRuntime>>;
type HealthClient = Pick<NlpClient, 'probeHealth' | 'shutdown'>;
type Dependencies = {
  loadConfig: typeof loadConfig;
  safePath: typeof safePath;
  resolveRuntime: typeof resolveNlpRuntime;
  createClient: (runtime: Runtime) => HealthClient;
  access: typeof access;
};

const defaults: Dependencies = {
  loadConfig,
  safePath,
  resolveRuntime: resolveNlpRuntime,
  createClient: runtime => new NlpClient(runtime),
  access,
};

function add(
  checks: MemoryDoctorCheck[],
  name: string,
  status: MemoryDoctorCheck['status'],
  message: string,
  remediation = '',
): void {
  checks.push({ id: `memory-doctor.${name}`, name, status, message, remediation });
}

function diagnosticOk(checks: MemoryDoctorCheck[]): boolean {
  return !checks.some(item => item.status === 'fail');
}

export async function runMemoryDoctor(
  configPath: string,
  overrides: Partial<Dependencies> = {},
): Promise<MemoryDoctorResult> {
  const deps = { ...defaults, ...overrides };
  const checks: MemoryDoctorCheck[] = [];
  let loaded: Awaited<ReturnType<typeof loadConfig>>;

  try {
    loaded = await deps.loadConfig(configPath);
    add(checks, 'config', 'ok', 'Configuration parsed successfully.');
  } catch {
    add(checks, 'config', 'fail', 'Configuration could not be loaded.', 'Check the config path, YAML syntax, and required fields; run `umb init` for a starter config.');
    return { ok: false, checks };
  }

  let dbPath: string | undefined;
  try {
    dbPath = await deps.safePath(loaded.root, loaded.config.memory.database);
    add(checks, 'memory-path', 'ok', 'Memory database path is within the project root.');
  } catch {
    add(checks, 'memory-path', 'fail', 'Memory database path is unsafe.', 'Use a path contained within the project root and remove escaping symlinks.');
  }

  if (loaded.config.memory.patterns_file) {
    try {
      const patternsPath = await deps.safePath(loaded.root, loaded.config.memory.patterns_file, false);
      await deps.access(patternsPath);
      add(checks, 'pattern-file', 'ok', 'Configured pattern file exists within the project root.');
    } catch {
      add(checks, 'pattern-file', 'fail', 'Configured pattern file is missing or unsafe.', 'Set memory.patterns_file to an existing valid project-relative JSON rules file.');
    }
  }

  let runtime: Runtime | undefined;
  let validatedPatternsFile: string | undefined;
  if (loaded.config.memory.patterns_file) {
    try { validatedPatternsFile = await deps.safePath(loaded.root, loaded.config.memory.patterns_file, false); await deps.access(validatedPatternsFile); }
    catch { /* Reported as an explicit failing check below; runtime must fail closed. */ }
  }
  try {
    runtime = deps.resolveRuntime(loaded.config, undefined, validatedPatternsFile);
    add(checks, 'nlp-runtime', runtime ? 'ok' : 'fail',
      runtime ? 'An existing NLP runtime was resolved.' : 'No existing NLP runtime is available.',
      runtime ? '' : 'Install the official bundle runtime or configure an existing source Python runtime; this diagnostic does not provision one.');
  } catch {
    add(checks, 'nlp-runtime', 'fail', 'NLP runtime could not be resolved safely.', 'Check the bundle installation or configured source Python runtime.');
  }

  let client: HealthClient | undefined;
  if (runtime) {
    try {
      client = deps.createClient(runtime);
      const response = await client.probeHealth();
      const health = response.health;
      const versions = `Python ${health.python}; spaCy ${health.spacy}; model ${health.model} ${health.model_version}`;
      add(checks, 'nlp-health', health.ready ? 'ok' : 'fail',
        health.ready ? `NLP sidecar is ready (${versions}).` : `NLP sidecar is not ready (${versions}).`,
        health.ready ? '' : 'Check the configured Python environment, spaCy package, and pinned model compatibility.');
      add(checks, 'nlp-rules-version', health.patterns_ready ? 'ok' : 'fail',
        `Pattern schema ${health.patterns_schema_version}; digest ${health.patterns_digest}; ${health.pattern_count} rules; ${health.patterns_ready ? 'ready' : 'not ready'}.`,
        health.patterns_ready ? '' : health.ready && health.pattern_count === 0
          ? loaded.config.memory.patterns_file
            ? 'NLP normalization is healthy, but the configured project patterns provide no effective rules. Correct the configured rules to enable candidate extraction; packaged defaults are not used as a fallback.'
            : 'NLP normalization is healthy, but the packaged patterns provide no effective rules. Configure memory.patterns_file with project rules to enable candidate extraction.'
          : loaded.config.memory.patterns_file
            ? 'Configured project pattern loading failed. Correct memory.patterns_file JSON/schema; invalid configured rules do not fall back to packaged rules.'
            : 'Packaged pattern normalization or loading failed. Check the installed packaged rules.');
      if (loaded.config.memory.patterns_file) {
        add(checks, 'pattern-loading', health.patterns_ready ? 'ok' : 'fail',
          health.patterns_ready ? 'Configured project patterns loaded and provide effective rules.' : 'Configured project patterns did not load with effective rules; packaged defaults are not a fallback.',
          health.patterns_ready ? '' : 'Correct memory.patterns_file JSON/schema and ensure it contains effective rules.');
      } else {
        add(checks, 'pattern-loading', health.patterns_ready ? 'warning' : 'fail',
          health.patterns_ready ? 'Packaged default patterns loaded; no project pattern file is configured.' : 'No effective pattern rules are available from the packaged defaults.',
          health.patterns_ready ? 'Configure memory.patterns_file to use project rules; packaged defaults are currently active.' : 'Restore or reinstall the packaged rules, or configure memory.patterns_file with project rules.');
      }
    } catch {
      add(checks, 'nlp-health', 'fail', 'NLP sidecar could not be reached or returned an invalid health response.', 'Check the configured runtime and sidecar installation.');
      add(checks, 'nlp-rules-version', 'warning', 'Pattern metadata is unavailable because sidecar health could not be read.');
      add(checks, 'pattern-loading', 'warning', loaded.config.memory.patterns_file
        ? 'Configured project pattern loading could not be verified because sidecar health is unavailable.'
        : 'Packaged default pattern loading could not be verified because sidecar health is unavailable.');
    } finally {
      try { await client?.shutdown(); } catch { /* Best-effort cleanup; omit unsafe details. */ }
    }
  } else {
    add(checks, 'nlp-health', 'fail', 'Sidecar health was not checked because no runtime is available.', 'Configure an existing supported NLP runtime.');
    add(checks, 'nlp-rules-version', 'warning', 'Pattern metadata is unavailable because no runtime is available.');
  }

  if (!checks.some(item => item.id === 'memory-doctor.pattern-loading')) {
    if (loaded.config.memory.patterns_file) {
      add(checks, 'pattern-loading', validatedPatternsFile ? 'warning' : 'fail',
        validatedPatternsFile
          ? 'Configured project pattern file exists, but loading could not be verified because no NLP runtime is available.'
          : 'Configured project pattern file is missing or unsafe; packaged defaults are not a fallback.',
        validatedPatternsFile
          ? 'Configure an existing supported NLP runtime to verify project pattern loading.'
          : 'Set memory.patterns_file to an existing valid project-relative JSON rules file.');
    } else {
      add(checks, 'pattern-loading', 'warning', 'Packaged default pattern loading could not be verified because no NLP runtime is available.');
    }
  }

  if (dbPath) {
    let exists = true;
    try { await deps.access(dbPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else add(checks, 'database', 'fail', 'Memory database could not be accessed.', 'Check database permissions and path safety.');
    }
    if (!exists) {
      add(checks, 'database', 'warning', 'Database is not initialized; it was not created.', 'Use the normal application initialization flow when you intend to create it.');
    } else if (!checks.some(item => item.id === 'memory-doctor.database')) {
      let db: Database.Database | undefined;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const integrity = db.pragma('quick_check') as Array<{ quick_check: string }>;
        const foreignKeys = db.pragma('foreign_key_check') as unknown[];
        const migrationVersions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
        const migrationHistoryIsStrictPrefix = migrationVersions.length > 0 &&
          migrationVersions.length < CURRENT_SCHEMA_VERSION &&
          migrationVersions.every((row, index) => row.version === index + 1);
        const migrationHistoryComplete = migrationVersions.length === CURRENT_SCHEMA_VERSION &&
          migrationVersions.every((row, index) => row.version === index + 1);
        const schemaRemediation = migrationHistoryComplete ? '' : migrationHistoryIsStrictPrefix
          ? 'Back up the database, then use a write-capable UMB command to apply remaining migrations; this diagnostic never migrates it.'
          : 'Do not run migrations on this database. Restore a known-good backup or obtain a recovery review for its inconsistent migration history.';
        add(checks, 'database-integrity', integrity.length === 1 && integrity[0]?.quick_check === 'ok' ? 'ok' : 'fail',
          integrity.length === 1 && integrity[0]?.quick_check === 'ok' ? 'SQLite quick_check passed.' : 'SQLite quick_check reported a problem.',
          integrity.length === 1 && integrity[0]?.quick_check === 'ok' ? '' : 'Restore the database from a known-good backup.');
        add(checks, 'database-foreign-keys', foreignKeys.length ? 'fail' : 'ok',
          foreignKeys.length ? 'SQLite foreign-key check reported violations.' : 'SQLite foreign-key check passed.',
          foreignKeys.length ? 'Repair or restore the database before serving.' : '');
        add(checks, 'database-schema', migrationHistoryComplete ? 'ok' : 'fail',
          migrationHistoryComplete ? 'Database migration history is complete and current.' : 'Database migration history is incomplete or not at the current version.',
          schemaRemediation);
      } catch {
        add(checks, 'database', 'fail', 'Database could not be checked safely.', 'Check database access and integrity; restore from backup if needed.');
      } finally {
        try { db?.close(); } catch { /* Best-effort close. */ }
      }
    }
  }

  return { ok: diagnosticOk(checks), checks };
}
