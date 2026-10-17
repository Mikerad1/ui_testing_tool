import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Store } from '../../src/memory/store.js';
import { createMemoryRedactor } from '../../src/memory/redactor.js';
import { LearningWriter, type NlpProcessor } from '../../src/memory/learning-writer.js';
import { withNlpMetadata } from '../../src/memory/learning-types.js';

const writers = new WeakMap<Store, LearningWriter>();

export function testLearningWriter(store: Store, state: { ready?: boolean; failAnalyze?: boolean; failAtAnalysis?: number; inputs?: string[]; sensitivePaths?: string[]; sensitiveValuesEnv?: string[]; env?: NodeJS.ProcessEnv } = {}): LearningWriter {
  let analysisCount = 0;
  const nlp: NlpProcessor = {
    async health() {
      return { version: 1, id: 'test-health', ok: true, op: 'health', health: { protocol: 1, python: 'test', spacy: 'fake', model: 'fake', rules: '1', ready: state.ready !== false } };
    },
    async analyze(text: string) {
      analysisCount += 1;
      state.inputs?.push(text);
      if (state.failAnalyze || state.failAtAnalysis === analysisCount) throw new Error('private fixture failure');
      return { version: 1, id: 'test-analyze', ok: true, op: 'analyze', normalized: 'fixture-normalized', tokens: [], entities: [] };
    },
    async shutdown() {},
  };
  return new LearningWriter(store, nlp, createMemoryRedactor({ sensitive_paths: state.sensitivePaths ?? [], sensitive_values_env: state.sensitiveValuesEnv ?? [] }, state.env ?? {}));
}

export function testWriter(store: Store): LearningWriter {
  const existing = writers.get(store);
  if (existing) return existing;
  const writer = testLearningWriter(store);
  writers.set(store, writer);
  return writer;
}

export function fixtureEdge(
  store: Store,
  databaseFilename: string,
  from: string,
  to: string,
  relation: string,
  attributes: Record<string, unknown> = {},
  options: { origin?: string; id?: string; stableKey?: string; verification_status?: string } = {},
) {
  const origin = options.origin ?? 'agent';
  const id = options.id ?? randomUUID();
  const stableKey = options.stableKey ?? `${from}:${relation}:${to}`;
  const database = new Database(databaseFilename);
  try {
    database.prepare('INSERT INTO edges(id,project_id,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,stable_key) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,origin,stable_key) DO UPDATE SET attributes_json=excluded.attributes_json').run(id, store.projectId, from, to, relation, JSON.stringify(withNlpMetadata(attributes, 'fixture-normalized')), origin, options.verification_status ?? 'proposed', stableKey);
  } finally { database.close(); }
  return (store.listEdges() as any[]).find(edge => edge.origin === origin && edge.stable_key === stableKey);
}

export function runFixtureSql(databaseFilename: string, sql: string, ...parameters: any[]) {
  const database = new Database(databaseFilename);
  try { return database.prepare(sql).run(...parameters); } finally { database.close(); }
}
