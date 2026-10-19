import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Store } from '../../src/memory/store.js';
import { createMemoryRedactor } from '../../src/memory/redactor.js';
import { LearningWriter, type NlpProcessor } from '../../src/memory/learning-writer.js';
import { withNlpMetadata } from '../../src/memory/learning-types.js';

const writers = new WeakMap<Store, LearningWriter>();

export function testLearningWriter(store: Store, state: { ready?: boolean; failAnalyze?: boolean; failAtAnalysis?: number; inputs?: string[]; sensitivePaths?: string[]; sensitiveValuesEnv?: string[]; env?: NodeJS.ProcessEnv;python?:string;spacy?:string;model?:string;modelVersion?:string;rules?:string;protocol?:number;patternsDigest?:string;emptyPatterns?:boolean;candidateMentions?:boolean;normalized?:string;onAnalyze?:(text:string,count:number)=>void|Promise<void> } = {}): LearningWriter {
  let analysisCount = 0;
  const nlp: NlpProcessor = {
    async health() {
        return { version: 3, id: 'test-health', ok: true, op: 'health', health: { protocol: state.protocol??3, python: state.python??'test', spacy: state.spacy??'fake', model: state.model??'fake', model_version: state.modelVersion??'1.0.0', rules: state.rules??'1',patterns_schema_version:1,patterns_digest:state.patternsDigest??'b'.repeat(64),pattern_count:state.emptyPatterns?0:1,patterns_ready:!state.emptyPatterns,ready: state.ready !== false } };
    },
    async analyze(text: string) {
      analysisCount += 1;
      state.inputs?.push(text);
      await state.onAnalyze?.(text,analysisCount);
      if (state.failAnalyze || state.failAtAnalysis === analysisCount) throw new Error('private fixture failure');
        const start=text.indexOf('Home'),actionStart=text.indexOf('open'),entities=state.candidateMentions&&start>=0&&actionStart>=0?[
          {label:'PAGE' as const,rule_id:'yaml_page',normalized:'home',text:'Home',start:Array.from(text.slice(0,start)).length,end:Array.from(text.slice(0,start)).length+4},
          {label:'ACTION' as const,rule_id:'yaml_action',normalized:'open',text:'open',start:Array.from(text.slice(0,actionStart)).length,end:Array.from(text.slice(0,actionStart)).length+4},
        ]:[];
        const relations=entities.length===2?[{type:'HAS_ACTION' as const,rule_id:'yaml_has_action',from_index:0,to_index:1,evidence:{start:Array.from(text.slice(0,actionStart)).length,end:Array.from(text.slice(0,actionStart)).length+4,text:'open'}}]:[];
        return { version: 3, id: 'test-analyze', ok: true, op: 'analyze', normalized: state.normalized??'fixture-normalized', tokens: [], entities,relations };
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
    database.prepare('INSERT INTO edges(id,project_id,environment,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,stable_key) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,environment,origin,stable_key) DO UPDATE SET attributes_json=excluded.attributes_json').run(id, store.projectId, store.memoryEnvironment, from, to, relation, JSON.stringify(withNlpMetadata(attributes, 'fixture-normalized')), origin, options.verification_status ?? 'proposed', stableKey);
  } finally { database.close(); }
  return (store.listEdges() as any[]).find(edge => edge.origin === origin && edge.stable_key === stableKey);
}

export function runFixtureSql(databaseFilename: string, sql: string, ...parameters: any[]) {
  const database = new Database(databaseFilename);
  try { return database.prepare(sql).run(...parameters); } finally { database.close(); }
}
