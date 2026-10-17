import { Buffer } from 'node:buffer';
import { NLP_GENERIC_ERROR, NLP_MAX_TEXT_BYTES, type NlpResponse } from './nlp-protocol.js';
import type { MemoryRedactor } from './redactor.js';
import type { Store } from './store.js';
import { storeLearningCommit } from './store-internal.js';
import { hasNlpMetadata, withNlpMetadata, type YamlReconciliationPlan } from './learning-types.js';

type HealthResponse = Extract<NlpResponse, { op: 'health' }>;
type AnalyzeResponse = Extract<NlpResponse, { op: 'analyze' }>;
export type NlpProcessor = {
  health(): Promise<HealthResponse>;
  analyze(text: string): Promise<AnalyzeResponse>;
  shutdown?(): Promise<void>;
};

export type PreparedDocument = { value: unknown; normalized: string };
type ProposedNode = { type: string; stable_key: string; display_name: string; attributes?: Record<string, unknown> };
type ProposedEdge = { from_id: string; to_id: string; relation: string; attributes?: Record<string, unknown> };

const EXACT_KEYS = new Set([
  'id', 'type', 'kind', 'stable_key', 'canonical_key', 'from', 'to', 'from_id', 'to_id', 'relation',
  'screen', 'element', 'screen_id', 'element_id', 'workflow_id', 'step_id', 'start_screen', 'end_screen',
  'route', 'path', 'url', 'base_url', 'source', 'source_path', 'target', 'locator',
]);

function identityProjection(value: unknown): string {
  const found: Array<[string, unknown]> = [];
  const visit = (current: unknown, path: string[]) => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, [...path, String(index)]));
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      const childPath = [...path, key];
      if (EXACT_KEYS.has(key.toLowerCase())) found.push([childPath.join('/'), child]);
      visit(child, childPath);
    }
  };
  visit(value, []);
  return JSON.stringify(found);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(NLP_GENERIC_ERROR);
  return value as Record<string, unknown>;
}

/** The only application-level façade for content-bearing graph mutations. */
export class LearningWriter {
  private ready = false;
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly nlp: NlpProcessor | undefined,
    private readonly redactor: MemoryRedactor | undefined,
    private readonly writesEnabled = true,
  ) {}

  async ensureReady(): Promise<void> {
    if (!this.writesEnabled) throw new Error(NLP_GENERIC_ERROR);
    if (this.closed) throw new Error(NLP_GENERIC_ERROR);
    if (this.ready) return;
    if (!this.nlp || !this.redactor) throw new Error(NLP_GENERIC_ERROR);
    try {
      const response = await this.nlp.health();
      if (!response.ok || response.op !== 'health' || !response.health.ready) throw new Error(NLP_GENERIC_ERROR);
      this.ready = true;
    } catch {
      throw new Error(NLP_GENERIC_ERROR);
    }
  }

  async prepareDocument(value: unknown): Promise<PreparedDocument> {
    const prepared = await this.prepare(value);
    return { value: prepared.value, normalized: prepared.normalized };
  }

  async propose(input: ProposedNode) {
    const prepared = await this.prepare(input);
    const safe = asRecord(prepared.value);
    const attributes = safe.attributes === undefined ? {} : asRecord(safe.attributes);
    try {
      return storeLearningCommit.proposedNode(this.store, {
        type: safe.type as string,
        stable_key: safe.stable_key as string,
        display_name: safe.display_name as string,
        attributes: withNlpMetadata(attributes, prepared.normalized),
      });
    } catch {
      throw new Error('Learning write failed safely');
    }
  }

  async addEdge(input: ProposedEdge) {
    const prepared = await this.prepare(input);
    const safe = asRecord(prepared.value);
    const attributes = safe.attributes === undefined ? {} : asRecord(safe.attributes);
    try {
      return storeLearningCommit.preparedEdge(this.store, {
        from_id: safe.from_id as string,
        to_id: safe.to_id as string,
        relation: safe.relation as string,
        attributes: withNlpMetadata(attributes, prepared.normalized),
      });
    } catch {
      throw new Error('Learning write failed safely');
    }
  }

  async verify(id: string, runId: string): Promise<boolean> {
    await this.ensureReady();
    try { return this.store.verify(id, runId); } catch { throw new Error('Learning write failed safely'); }
  }

  async supersede(oldId: string, newId: string): Promise<boolean> {
    await this.ensureReady();
    try { return this.store.supersede(oldId, newId); } catch { throw new Error('Learning write failed safely'); }
  }

  async commitReconciliation(plan: YamlReconciliationPlan): Promise<number> {
    await this.ensureReady();
    if (plan.entities.some(entity => !hasNlpMetadata(entity.attrs)) || plan.edges.some(edge => !hasNlpMetadata(edge.attrs))) {
      throw new Error(NLP_GENERIC_ERROR);
    }
    try { return storeLearningCommit.reconciliation(this.store, plan); } catch { throw new Error('Knowledge reconciliation failed safely'); }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.nlp?.shutdown?.(); } catch { /* sidecar teardown is best-effort */ }
    this.ready = false;
  }

  private async prepare(value: unknown): Promise<PreparedDocument> {
    await this.ensureReady();
    try {
      const safe = this.redactor!.redactValue(value);
      if (identityProjection(value) !== identityProjection(safe)) throw new Error(NLP_GENERIC_ERROR);
      const text = JSON.stringify(safe);
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > NLP_MAX_TEXT_BYTES) throw new Error(NLP_GENERIC_ERROR);
      const response = await this.nlp!.analyze(text);
      if (!response.ok || response.op !== 'analyze' || typeof response.normalized !== 'string') throw new Error(NLP_GENERIC_ERROR);
      return { value: safe, normalized: response.normalized };
    } catch {
      throw new Error(NLP_GENERIC_ERROR);
    }
  }
}
