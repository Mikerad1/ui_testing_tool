import type { Store } from './store.js';
import type { YamlReconciliationPlan } from './learning-types.js';

export type ProposedNodeWrite = {
  type: string;
  stable_key: string;
  display_name: string;
  attributes: Record<string, unknown>;
};

export type PreparedEdgeWrite = {
  from_id: string;
  to_id: string;
  relation: string;
  attributes: Record<string, unknown>;
};

type StoreWriteOperations = {
  proposedNode(input: ProposedNodeWrite): any;
  preparedEdge(input: PreparedEdgeWrite): any;
  reconciliation(plan: YamlReconciliationPlan): number;
};

const operations = new WeakMap<Store, StoreWriteOperations>();

/** Internal registration used by Store; this module is not a package API. */
export function registerStoreWriteOperations(store: Store, value: StoreWriteOperations): void {
  if (operations.has(store)) throw new Error('Store write operations are already registered');
  operations.set(store, value);
}

function forStore(store: Store): StoreWriteOperations {
  const value = operations.get(store);
  if (!value) throw new Error('Store write operation is unavailable');
  return value;
}

/** Internal LearningWriter-only commit operations. */
export const storeLearningCommit = Object.freeze({
  proposedNode: (store: Store, input: ProposedNodeWrite) => forStore(store).proposedNode(input),
  preparedEdge: (store: Store, input: PreparedEdgeWrite) => forStore(store).preparedEdge(input),
  reconciliation: (store: Store, plan: YamlReconciliationPlan) => forStore(store).reconciliation(plan),
});
