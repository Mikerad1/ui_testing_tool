export const NLP_METADATA_KEY = '__umb_memory_nlp';
const nlpMetadataBrands = new WeakSet<object>();

export type NlpMetadata = { protocol: 1; normalized: string };
export type LearningAttributes = Record<string, unknown> & { [NLP_METADATA_KEY]: NlpMetadata };

export type YamlEntityPlan = {
  type: string;
  key: string;
  name: string;
  attrs: LearningAttributes;
  hash: string;
  parent?: string;
  source: string;
};

export type YamlEdgePlan = {
  key: string;
  from: string;
  to: string;
  relation: string;
  attrs: LearningAttributes;
  source: string;
};

export type YamlReconciliationPlan = {
  sources: Array<{ path: string; hash: string }>;
  entities: YamlEntityPlan[];
  edges: YamlEdgePlan[];
};

export function withNlpMetadata(attributes: Record<string, unknown>, normalized: string): LearningAttributes {
  const result = { ...attributes, [NLP_METADATA_KEY]: { protocol: 1, normalized } } as LearningAttributes;
  nlpMetadataBrands.add(result);
  return result;
}

export function hasNlpMetadata(value: unknown): value is LearningAttributes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const metadata = (value as Record<string, unknown>)[NLP_METADATA_KEY];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  return record.protocol === 1 && typeof record.normalized === 'string' && record.normalized.length <= 64 * 1024
    && nlpMetadataBrands.has(value);
}
