export const NLP_PROTOCOL_VERSION = 3 as const;
export const NLP_MAX_LINE_BYTES = 1024 * 1024;
export const NLP_MAX_TEXT_BYTES = 64 * 1024;
export const NLP_MAX_OUTSTANDING = 4;
export const NLP_TIMEOUT_MS = 15_000;
export const NLP_MAX_SPANS = 1_000;

export type NlpOperation = 'health' | 'analyze' | 'shutdown';
export type NlpRequest =
  | { version: 3; id: string; op: 'health' | 'shutdown' }
  | { version: 3; id: string; op: 'analyze'; text: string };
export type NlpSpan = { start: number; end: number; text: string; label: string };
export const NLP_ENTITY_LABELS = ['PAGE', 'ACTION', 'FIELD', 'RULE', 'LOCATOR', 'TEST', 'AC'] as const;
export const NLP_RELATION_TYPES = ['HAS_ACTION', 'NAVIGATES_TO', 'HAS_VALIDATION', 'BELONGS_TO', 'COVERS'] as const;
export type NlpEntity = { label: typeof NLP_ENTITY_LABELS[number]; rule_id: string; text: string; normalized: string; start: number; end: number };
export type NlpRelation = { type: typeof NLP_RELATION_TYPES[number]; rule_id: string; from_index: number; to_index: number; evidence: { start: number; end: number; text: string } };
export type NlpResponse =
  | { version: 3; id: string; ok: true; op: 'health'; health: { protocol: number; python: string; spacy: string; model: string; model_version: string; rules: string; patterns_schema_version: number; patterns_digest: string; pattern_count: number; patterns_ready: boolean; ready: boolean } }
  | { version: 3; id: string; ok: true; op: 'analyze'; normalized: string; tokens: NlpSpan[]; entities: NlpEntity[]; relations: NlpRelation[] }
  | { version: 3; id: string; ok: true; op: 'shutdown' }
  | { version: 3; id: string; ok: false; error: 'invalid_request' | 'unavailable' };

export const NLP_GENERIC_ERROR = 'NLP sidecar request failed';
