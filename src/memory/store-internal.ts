import type { CandidateObservationInput, Store } from './store.js';
import type { YamlReconciliationPlan } from './learning-types.js';
import type { GraphMutationFinalizer } from './graph-mutation.js';

export type BackfillNodeWrite={jobId:string;id:string;payloadHash:string;redactedHash:string;type:string;stable_key:string;display_name:string;attributes:Record<string,unknown>;observation:CandidateObservationInput};
export type BackfillEdgeWrite={jobId:string;id:string;payloadHash:string;redactedHash:string;from_id:string;to_id:string;relation:string;attributes:Record<string,unknown>;observation:CandidateObservationInput};
export type EvidenceReference={evidence_id:string;run_id:string;subject_node_id:string};

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
export type McpNodeWrite={observation:CandidateObservationInput;evidence_refs:EvidenceReference[];type:string;stable_key:string;display_name:string;attributes:Record<string,unknown>};
export type McpEdgeWrite={observation:CandidateObservationInput;evidence_refs:EvidenceReference[];from_id:string;to_id:string;relation:string;attributes:Record<string,unknown>};

export const MCP_GRAPH_NODE_TYPES=new Set(['application','role','screen','workflow','navigation_rules','ui_element','action','validation_rule','locator','test','acceptance_criterion']);
export const MCP_RELATION_ENDPOINTS:Readonly<Record<string,readonly (readonly [string,string])[]>>=Object.freeze({
  CONTAINS:[['screen','ui_element']],TRIGGERED_BY:[['screen','action']],USES_ELEMENT:[['action','ui_element'],['workflow','ui_element']],
  NAVIGATES_TO:[['action','screen'],['screen','screen']],HAS_SCREEN:[['application','screen']],LEADS_TO:[['workflow','screen']],
  REQUIRES_ROLE:[['workflow','role']],EXECUTES:[['workflow','screen']],HAS_ACTION:[['screen','action']],
  HAS_VALIDATION:[['ui_element','validation_rule']],BELONGS_TO:[['locator','screen']],COVERS:[['test','acceptance_criterion']],
});
export function assertMcpGraphNodeType(type:string):void{if(!MCP_GRAPH_NODE_TYPES.has(type))throw new Error('Unsupported memory graph node type');}
export function assertMcpRelationType(relation:string):void{if(!Object.hasOwn(MCP_RELATION_ENDPOINTS,relation))throw new Error('Unsupported memory graph relation');}
export function assertMcpRelationSignature(relation:string,fromType:string,toType:string):void{
  assertMcpRelationType(relation);
  if(!MCP_RELATION_ENDPOINTS[relation]?.some(([from,to])=>from===fromType&&to===toType))throw new Error('Unsupported memory graph relation or endpoint signature');
}

type StoreWriteOperations = {
  proposedNode(input: ProposedNodeWrite): any;
  preparedEdge(input: PreparedEdgeWrite): any;
  reconciliation(plan: YamlReconciliationPlan): number;
  backfillNode(input:BackfillNodeWrite):boolean;
  backfillEdge(input:BackfillEdgeWrite):boolean;
  mcpNode(input:McpNodeWrite):any;
  mcpEdge(input:McpEdgeWrite):any;
};

const operations = new WeakMap<Store, StoreWriteOperations>();
type GraphFinalizerRegistry={primary?:GraphMutationFinalizer;observers:GraphMutationFinalizer[]};
const graphFinalizers=new WeakMap<Store,GraphFinalizerRegistry>();
const nextStoreFinalizers:GraphMutationFinalizer[]=[];

/** Test/internal hook for observing the complete graph write set before commit. */
export function registerGraphMutationFinalizer(store:Store,finalizer:GraphMutationFinalizer):()=>void{
  const registry=graphFinalizers.get(store)??{observers:[]};graphFinalizers.set(store,registry);
  if(registry.observers.includes(finalizer)||registry.primary===finalizer)throw new Error('Graph mutation finalizer is already registered');
  registry.observers.push(finalizer);
  return()=>{const current=graphFinalizers.get(store);if(!current)return;current.observers=current.observers.filter(item=>item!==finalizer);if(!current.primary&&!current.observers.length)graphFinalizers.delete(store);};
}
export function registerPrimaryGraphMutationFinalizer(store:Store,finalizer:GraphMutationFinalizer):()=>void{
  const registry=graphFinalizers.get(store)??{observers:[]};if(registry.primary)throw new Error('A primary graph mutation finalizer is already registered');registry.primary=finalizer;graphFinalizers.set(store,registry);
  return()=>{const current=graphFinalizers.get(store);if(!current||current.primary!==finalizer)return;current.primary=undefined;if(!current.observers.length)graphFinalizers.delete(store);};
}
/** Internal test-only registration applied to the next Store before bootstrap writes. */
export function registerNextStoreGraphMutationFinalizer(finalizer:GraphMutationFinalizer):()=>void{
  nextStoreFinalizers.push(finalizer);
  return()=>{const index=nextStoreFinalizers.indexOf(finalizer);if(index>=0)nextStoreFinalizers.splice(index,1);};
}
export function attachPendingGraphMutationFinalizers(store:Store):void{if(!nextStoreFinalizers.length)return;const registry=graphFinalizers.get(store)??{observers:[]};registry.observers.push(...nextStoreFinalizers.splice(0));graphFinalizers.set(store,registry);}
export function finalizeGraphMutation(store:Store,writeSet:Parameters<GraphMutationFinalizer>[0]):void{const registry=graphFinalizers.get(store);registry?.primary?.(writeSet);for(const observer of registry?.observers??[])observer(writeSet);}

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
  backfillNode: (store:Store,input:BackfillNodeWrite)=>forStore(store).backfillNode(input),
  backfillEdge: (store:Store,input:BackfillEdgeWrite)=>forStore(store).backfillEdge(input),
  mcpNode:(store:Store,input:McpNodeWrite)=>forStore(store).mcpNode(input),
  mcpEdge:(store:Store,input:McpEdgeWrite)=>forStore(store).mcpEdge(input),
});
