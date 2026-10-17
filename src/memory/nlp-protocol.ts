export const NLP_PROTOCOL_VERSION = 1 as const;
export const NLP_MAX_LINE_BYTES = 1024 * 1024;
export const NLP_MAX_TEXT_BYTES = 64 * 1024;
export const NLP_MAX_OUTSTANDING = 4;
export const NLP_TIMEOUT_MS = 15_000;
export const NLP_MAX_SPANS = 1_000;

export type NlpOperation = 'health' | 'analyze' | 'shutdown';
export type NlpRequest =
  | { version: 1; id: string; op: 'health' | 'shutdown' }
  | { version: 1; id: string; op: 'analyze'; text: string };
export type NlpSpan = { start: number; end: number; text: string; label: string };
export type NlpResponse =
  | { version: 1; id: string; ok: true; op: 'health'; health: { protocol: number; python: string; spacy: string; model: string; rules: string; ready: boolean } }
  | { version: 1; id: string; ok: true; op: 'analyze'; normalized: string; tokens: NlpSpan[]; entities: NlpSpan[] }
  | { version: 1; id: string; ok: true; op: 'shutdown' }
  | { version: 1; id: string; ok: false; error: 'invalid_request' | 'unavailable' };

export const NLP_GENERIC_ERROR = 'NLP sidecar request failed';
