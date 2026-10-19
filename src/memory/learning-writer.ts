import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { NLP_ENTITY_LABELS, NLP_GENERIC_ERROR, NLP_MAX_TEXT_BYTES, NLP_PROTOCOL_VERSION, NLP_RELATION_TYPES, type NlpEntity, type NlpRelation, type NlpResponse } from './nlp-protocol.js';
import type { MemoryRedactor } from './redactor.js';
import type { CandidateObservationInput, Store, VerificationApproval } from './store.js';
import { assertMcpGraphNodeType, assertMcpRelationType, storeLearningCommit } from './store-internal.js';
import { hasNlpMetadata, withNlpMetadata, type YamlRecordFingerprint, type YamlReconciliationPlan } from './learning-types.js';
import { hashBackfillEdge, hashBackfillNode, hashJson, stableJson, withoutNlpMetadata } from './content-fingerprint.js';
import type {BackfillEdgeRecord,BackfillNodeRecord} from './backfill-types.js';

type HealthResponse = Extract<NlpResponse, { op: 'health' }>;
type AnalyzeResponse = Extract<NlpResponse, { op: 'analyze' }>;
export type NlpProcessor = {
  health(): Promise<HealthResponse>;
  analyze(text: string): Promise<AnalyzeResponse>;
  shutdown?(): Promise<void>;
};

export type YamlPreparationContext={sourcePath:string;documentKind:string;documentId:string;rawHash:string;projectionVersion:string};
export type PreparedDocument = { value: unknown; normalized: string; fingerprint?:YamlRecordFingerprint; analysis?:AnalyzeResponse; observation?:CandidateObservationInput };
export type ValidatedYamlDocument={value:unknown;text:string;fingerprint:YamlRecordFingerprint};
export type EvidenceReference = { evidence_id:string; run_id:string; subject_node_id:string };
type ProposedNode = { observation_id:string; type: string; stable_key: string; display_name: string; attributes?: Record<string, unknown>; evidence_refs: EvidenceReference[] };
type ProposedEdge = { observation_id:string; from_id: string; to_id: string; relation: string; attributes?: Record<string, unknown>; evidence_refs: EvidenceReference[] };
/** Safe deterministic validation failure for an individual legacy record. */
export class BackfillRejectedError extends Error { constructor(){super(NLP_GENERIC_ERROR);this.name='BackfillRejectedError';} }
const NLP_ANALYZER_VERSION='umb-candidate-analyzer-v1';
const CANDIDATE_GRAPH_TYPE:Record<typeof NLP_ENTITY_LABELS[number],string>={PAGE:'screen',ACTION:'action',FIELD:'ui_element',RULE:'validation_rule',LOCATOR:'locator',TEST:'test',AC:'acceptance_criterion'};
const CANDIDATE_SIGNATURES:Record<typeof NLP_RELATION_TYPES[number],ReadonlyArray<readonly [string,string]>>={HAS_ACTION:[['screen','action']],NAVIGATES_TO:[['action','screen'],['screen','screen']],HAS_VALIDATION:[['ui_element','validation_rule']],BELONGS_TO:[['locator','screen']],COVERS:[['test','acceptance_criterion']]};

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
  private healthResponse:HealthResponse|undefined;

  constructor(
    private readonly store: Store,
    private readonly nlp: NlpProcessor | undefined,
    private readonly redactor: MemoryRedactor | undefined,
    private readonly writesEnabled = true,
    private readonly analysisOnly = false,
  ) {}

  async ensureReady(): Promise<void> {
    if (!this.writesEnabled && !this.analysisOnly) throw new Error(NLP_GENERIC_ERROR);
    if (this.closed) throw new Error(NLP_GENERIC_ERROR);
    if (this.ready) return;
    if (!this.nlp || !this.redactor) throw new Error(NLP_GENERIC_ERROR);
    try {
      const response = await this.nlp.health();
      this.validateHealthResponse(response);
      this.healthResponse=response;
      this.ready = true;
    } catch {
      throw new Error(NLP_GENERIC_ERROR);
    }
  }

  private validateHealthResponse(response:HealthResponse):void{
    if(!response||response.ok!==true||response.version!==NLP_PROTOCOL_VERSION||response.op!=='health'||typeof response.id!=='string'||response.id.trim().length<1||Buffer.byteLength(response.id,'utf8')>100
      ||!response.health||typeof response.health!=='object')throw new Error(NLP_GENERIC_ERROR);
    const health=response.health;
    const boundedNonempty=(value:unknown,max:number)=>typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value,'utf8')<=max;
    if(health.protocol!==NLP_PROTOCOL_VERSION||!boundedNonempty(health.python,100)||!boundedNonempty(health.spacy,100)||!boundedNonempty(health.model,200)
      ||!boundedNonempty(health.model_version,100)||!boundedNonempty(health.rules,200)||health.patterns_schema_version!==1
      ||typeof health.patterns_digest!=='string'||!/^[a-f0-9]{64}$/.test(health.patterns_digest)
      ||!Number.isSafeInteger(health.pattern_count)||health.pattern_count<0||health.pattern_count>128
      ||typeof health.patterns_ready!=='boolean'||typeof health.ready!=='boolean')throw new Error(NLP_GENERIC_ERROR);
    if((health.pattern_count===0&&health.patterns_ready)||(health.pattern_count>0&&!health.patterns_ready)||health.ready!==true)throw new Error(NLP_GENERIC_ERROR);
  }

  async prepareDocument(value: unknown): Promise<PreparedDocument> {
    const prepared = await this.prepare(value);
    return { value: prepared.value, normalized: prepared.normalized };
  }

  async validateYamlDocument(value:unknown,context:YamlPreparationContext,validateRedacted:(value:unknown)=>unknown):Promise<ValidatedYamlDocument>{
    const redacted=await this.prepareForAnalysis(value),validated=validateRedacted(redacted.value);
    if(identityProjection(redacted.value)!==identityProjection(validated))throw new Error(NLP_GENERIC_ERROR);
    const text=JSON.stringify(validated);
    if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>NLP_MAX_TEXT_BYTES)throw new Error(NLP_GENERIC_ERROR);
    const redactedHash=hashJson(validated),preparationKey=this.yamlPreparationKey(context.projectionVersion);
    const fingerprint:YamlRecordFingerprint={document_kind:context.documentKind,document_id:context.documentId,source_path:context.sourcePath,raw_hash:context.rawHash,redacted_hash:redactedHash,preparation_key:preparationKey};
    return{value:validated,text,fingerprint};
  }

  async normalizeYamlDocument(prepared:ValidatedYamlDocument):Promise<PreparedDocument>{
    const health=this.healthResponse!.health,pipelineFingerprint=this.fingerprintFromHealth(health);
    const cached=this.store.getYamlRecordNormalization(prepared.fingerprint);
    // A YAML record's ledger identity follows its validated document identity, not its
    // filesystem location, so moving an unchanged record retains its observation identity.
    const sourceKey=`${prepared.fingerprint.document_kind}:${prepared.fingerprint.document_id}`;
    // Legacy YAML fingerprints predate candidate observations. Reuse normalization only
    // when the exact observation for this scoped source revision and NLP profile exists.
    if(cached!==null&&this.store.hasYamlCandidateObservation({source_key:sourceKey,source_revision_hash:prepared.fingerprint.redacted_hash,pipeline_fingerprint:pipelineFingerprint}))
      return{value:prepared.value,normalized:cached,fingerprint:prepared.fingerprint};
    const analysis=await this.analyze(prepared.text);
    const revisionHash=hashJson(JSON.parse(prepared.text));
    const observationKey=createHash('sha256').update(stableJson([sourceKey,revisionHash,pipelineFingerprint])).digest('hex');
    const extractionReady=health.patterns_ready&&health.pattern_count>0;
    const entities=this.candidateEntities(observationKey,prepared.text,extractionReady?analysis.entities:[]);
    const relations=this.candidateRelations(prepared.text,extractionReady?analysis.relations:[],entities);
    const observation:CandidateObservationInput={source_kind:'yaml_document',source_key:sourceKey,source_revision_hash:revisionHash,pipeline_fingerprint:pipelineFingerprint,
      nlp_protocol_version:NLP_PROTOCOL_VERSION,python_version:health.python,spacy_version:health.spacy,model_name:health.model,model_version:health.model_version,
      rules_version:health.rules,patterns_schema_version:health.patterns_schema_version,patterns_digest:health.patterns_digest,redaction_policy_fingerprint:this.redactor!.policyFingerprint,
      extraction_ready:extractionReady,redacted_source_text:prepared.text,entities,relations,links:[],status:'proposed'};
    return{value:prepared.value,normalized:analysis.normalized,fingerprint:prepared.fingerprint,analysis,observation};
  }

  async pipelineFingerprint():Promise<string>{
    await this.ensureReady();
    const health=this.healthResponse!.health;
    return this.fingerprintFromHealth(health);
  }

  async propose(input: ProposedNode) {
    this.assertWritable();
    const observationId=this.observationId(input.observation_id);assertMcpGraphNodeType(input.type);
    const { evidence_refs, ...analysisInput } = input;
    const prepared = await this.prepareAnalyzed(analysisInput);
    const safe = asRecord(prepared.value);
    const attributes = safe.attributes === undefined ? {} : asRecord(safe.attributes);
    try {
      return storeLearningCommit.mcpNode(this.store, {observation:this.observation('mcp_node',prepared,observationId),
        type: safe.type as string,
        stable_key: safe.stable_key as string,
        display_name: safe.display_name as string,
        attributes: withNlpMetadata(attributes, prepared.normalized),
        evidence_refs,
      });
    } catch {
      throw new Error('Learning write failed safely');
    }
  }

  async addEdge(input: ProposedEdge) {
    this.assertWritable();
    const observationId=this.observationId(input.observation_id);
    try{assertMcpRelationType(input.relation);}catch{throw new Error('Learning write failed safely');}
    const { evidence_refs, ...analysisInput } = input;
    const prepared = await this.prepareAnalyzed(analysisInput);
    const safe = asRecord(prepared.value);
    const attributes = safe.attributes === undefined ? {} : asRecord(safe.attributes);
    try {
      return storeLearningCommit.mcpEdge(this.store, {observation:this.observation('mcp_edge',prepared,observationId),
        from_id: safe.from_id as string,
        to_id: safe.to_id as string,
        relation: safe.relation as string,
        attributes: withNlpMetadata(attributes, prepared.normalized),
        evidence_refs,
      });
    } catch {
      throw new Error('Learning write failed safely');
    }
  }

  async verify(id: string, runId: string, approval:VerificationApproval): Promise<boolean> {
    this.assertWritable();
    await this.ensureReady();
    try { return this.store.verify(id, runId,approval); } catch { throw new Error('Learning write failed safely'); }
  }

  async supersede(oldId: string, newId: string): Promise<boolean> {
    this.assertWritable();
    await this.ensureReady();
    try { return this.store.supersede(oldId, newId); } catch { throw new Error('Learning write failed safely'); }
  }

  async commitReconciliation(plan: YamlReconciliationPlan): Promise<number> {
    this.assertWritable();
    await this.ensureReady();
    if (plan.entities.some(entity => !hasNlpMetadata(entity.attrs)) || plan.edges.some(edge => !hasNlpMetadata(edge.attrs))) {
      throw new Error(NLP_GENERIC_ERROR);
    }
    try { return storeLearningCommit.reconciliation(this.store, plan); } catch { throw new Error('Knowledge reconciliation failed safely'); }
  }

  async reprocessBackfillNode(jobId:string,record:BackfillNodeRecord):Promise<boolean>{
    this.assertWritable();
    const prepared=await this.prepareAnalyzed({type:record.type,stable_key:record.stable_key,display_name:record.display_name,attributes:withoutNlpMetadata(record.attributes)}),safe=asRecord(prepared.value),attributes=asRecord(safe.attributes);
    const redactedHash=hashBackfillNode({type:safe.type as string,stable_key:safe.stable_key as string,display_name:safe.display_name as string,attributes});
    const observation=this.backfillObservation('backfill_node',`node:${record.id}`,redactedHash,prepared);
    try{return storeLearningCommit.backfillNode(this.store,{jobId,id:record.id,payloadHash:record.payloadHash,redactedHash,type:safe.type as string,stable_key:safe.stable_key as string,display_name:safe.display_name as string,attributes:withNlpMetadata(attributes,prepared.normalized),observation});}catch{throw new Error('Memory backfill failed safely');}
  }

  async reprocessBackfillEdge(jobId:string,record:BackfillEdgeRecord):Promise<boolean>{
    this.assertWritable();
    const prepared=await this.prepareAnalyzed({from_id:record.from_id,to_id:record.to_id,relation:record.relation,attributes:withoutNlpMetadata(record.attributes)}),safe=asRecord(prepared.value),attributes=asRecord(safe.attributes);
    const redactedHash=hashBackfillEdge({from_id:safe.from_id as string,to_id:safe.to_id as string,relation:safe.relation as string,attributes});
    const observation=this.backfillObservation('backfill_edge',`edge:${record.id}`,redactedHash,prepared);
    try{return storeLearningCommit.backfillEdge(this.store,{jobId,id:record.id,payloadHash:record.payloadHash,redactedHash,from_id:safe.from_id as string,to_id:safe.to_id as string,relation:safe.relation as string,attributes:withNlpMetadata(attributes,prepared.normalized),observation});}catch{throw new Error('Memory backfill failed safely');}
  }

  async previewBackfillNode(record:BackfillNodeRecord):Promise<string>{
    const prepared=await this.prepareForAnalysis({type:record.type,stable_key:record.stable_key,display_name:record.display_name,attributes:withoutNlpMetadata(record.attributes)}),safe=asRecord(prepared.value);
    return hashBackfillNode({type:safe.type as string,stable_key:safe.stable_key as string,display_name:safe.display_name as string,attributes:asRecord(safe.attributes)});
  }

  async previewBackfillEdge(record:BackfillEdgeRecord):Promise<string>{
    const prepared=await this.prepareForAnalysis({from_id:record.from_id,to_id:record.to_id,relation:record.relation,attributes:withoutNlpMetadata(record.attributes)}),safe=asRecord(prepared.value);
    return hashBackfillEdge({from_id:safe.from_id as string,to_id:safe.to_id as string,relation:safe.relation as string,attributes:asRecord(safe.attributes)});
  }

  /** Analysis-only reprocessing facade; it returns no write-capable objects. */
  async analyzePreviewNode(record:BackfillNodeRecord):Promise<string>{
    const prepared=await this.prepareAnalyzed({type:record.type,stable_key:record.stable_key,display_name:record.display_name,attributes:withoutNlpMetadata(record.attributes)}),safe=asRecord(prepared.value),attributes=asRecord(safe.attributes);
    return hashBackfillNode({type:safe.type as string,stable_key:safe.stable_key as string,display_name:safe.display_name as string,attributes});
  }

  async analyzePreviewEdge(record:BackfillEdgeRecord):Promise<string>{
    const prepared=await this.prepareAnalyzed({from_id:record.from_id,to_id:record.to_id,relation:record.relation,attributes:withoutNlpMetadata(record.attributes)}),safe=asRecord(prepared.value),attributes=asRecord(safe.attributes);
    return hashBackfillEdge({from_id:safe.from_id as string,to_id:safe.to_id as string,relation:safe.relation as string,attributes});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.nlp?.shutdown?.(); } catch { /* sidecar teardown is best-effort */ }
    this.ready = false;
  }

  private async prepareForAnalysis(value:unknown):Promise<{value:unknown;text:string}>{
    await this.ensureReady();
    try {
      const safe = this.redactor!.redactValue(value);
      if (identityProjection(value) !== identityProjection(safe)) throw new Error(NLP_GENERIC_ERROR);
      const text = stableJson(safe);
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > NLP_MAX_TEXT_BYTES) throw new Error(NLP_GENERIC_ERROR);
      return{value:safe,text};
    } catch {
      throw new BackfillRejectedError();
    }
  }

  private assertWritable():void{if(!this.writesEnabled)throw new Error(NLP_GENERIC_ERROR);}

  private async analyze(text:string):Promise<AnalyzeResponse>{
    try{
      const response=await this.nlp!.analyze(text);
      this.validateAnalyzeResponse(response,text);
      return response;
    }catch{throw new Error(NLP_GENERIC_ERROR);}
  }

  private validateAnalyzeResponse(response:AnalyzeResponse,text:string):void{
    if(!response||response.ok!==true||response.version!==NLP_PROTOCOL_VERSION||response.op!=='analyze'||typeof response.id!=='string'||response.id.length<1||response.id.length>100
      ||typeof response.normalized!=='string'||Buffer.byteLength(response.normalized,'utf8')>NLP_MAX_TEXT_BYTES||!Array.isArray(response.tokens)||!Array.isArray(response.entities)||!Array.isArray(response.relations)
      ||response.tokens.length>1000||response.entities.length>1000||response.relations.length>1000)throw new Error(NLP_GENERIC_ERROR);
    const points=Array.from(text),validSpan=(item:{start:number;end:number;text:string})=>Number.isSafeInteger(item.start)&&Number.isSafeInteger(item.end)&&item.start>=0&&item.end>item.start&&item.end<=points.length&&typeof item.text==='string'&&Buffer.byteLength(item.text,'utf8')<=NLP_MAX_TEXT_BYTES&&points.slice(item.start,item.end).join('')===item.text;
    for(const token of response.tokens)if(!token||typeof token.label!=='string'||token.label.length>80||!validSpan(token))throw new Error(NLP_GENERIC_ERROR);
    for(const entity of response.entities){
      if(!entity||!NLP_ENTITY_LABELS.includes(entity.label)||!this.validRuleId(entity.rule_id)||typeof entity.normalized!=='string'||entity.normalized.length===0||Buffer.byteLength(entity.normalized,'utf8')>1000||!validSpan(entity))throw new Error(NLP_GENERIC_ERROR);
    }
    for(const relation of response.relations){
      if(!relation||!NLP_RELATION_TYPES.includes(relation.type)||!this.validRuleId(relation.rule_id)||!Number.isSafeInteger(relation.from_index)||!Number.isSafeInteger(relation.to_index)
        ||relation.from_index<0||relation.to_index<0||relation.from_index>=response.entities.length||relation.to_index>=response.entities.length||relation.from_index===relation.to_index
        ||!relation.evidence||!validSpan(relation.evidence))throw new Error(NLP_GENERIC_ERROR);
      const from=response.entities[relation.from_index]!.label,to=response.entities[relation.to_index]!.label;
      if(!CANDIDATE_SIGNATURES[relation.type].some(([expectedFrom,expectedTo])=>CANDIDATE_GRAPH_TYPE[from]===expectedFrom&&CANDIDATE_GRAPH_TYPE[to]===expectedTo))throw new Error(NLP_GENERIC_ERROR);
    }
  }
  private validRuleId(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value);}

  private async prepare(value:unknown):Promise<PreparedDocument>{
    const redacted=await this.prepareForAnalysis(value);
    const analysis=await this.analyze(redacted.text);
    return{value:redacted.value,normalized:analysis.normalized};
  }

  private async prepareAnalyzed(value:unknown){
    const redacted=await this.prepareForAnalysis(value),analysis=await this.analyze(redacted.text);
    return{...redacted,analysis,normalized:analysis.normalized};
  }

  private observationId(value:string):string{
    const id=value;
    if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id))throw new Error('Invalid observation_id');
    return id;
  }

  private observation(sourceKind:'mcp_node'|'mcp_edge',prepared:{text:string;analysis:AnalyzeResponse},observationId:string){
    const health=this.healthResponse!.health,extractionReady=health.patterns_ready&&health.pattern_count>0,entities=this.candidateEntities(observationId,prepared.text,extractionReady?prepared.analysis.entities:[]),relations=this.candidateRelations(prepared.text,extractionReady?prepared.analysis.relations:[],entities);
    return{source_kind:sourceKind,source_key:observationId,source_revision_hash:hashJson(JSON.parse(prepared.text)),pipeline_fingerprint:this.fingerprintFromHealth(health),nlp_protocol_version:NLP_PROTOCOL_VERSION,
      python_version:health.python,spacy_version:health.spacy,model_name:health.model,model_version:health.model_version,rules_version:health.rules,patterns_schema_version:health.patterns_schema_version,
      patterns_digest:health.patterns_digest,redaction_policy_fingerprint:this.redactor!.policyFingerprint,extraction_ready:extractionReady,
      redacted_source_text:prepared.text,entities,relations,links:[],status:'proposed' as const};
  }

  private backfillObservation(sourceKind:'backfill_node'|'backfill_edge',sourceKey:string,revisionHash:string,prepared:{text:string;analysis:AnalyzeResponse}):CandidateObservationInput{
    const health=this.healthResponse!.health,pipelineFingerprint=this.fingerprintFromHealth(health),candidateKey=createHash('sha256').update(stableJson([sourceKind,sourceKey,revisionHash,pipelineFingerprint])).digest('hex');
    const extractionReady=health.patterns_ready&&health.pattern_count>0,entities=this.candidateEntities(candidateKey,prepared.text,extractionReady?prepared.analysis.entities:[]),relations=this.candidateRelations(prepared.text,extractionReady?prepared.analysis.relations:[],entities);
    return{source_kind:sourceKind,source_key:sourceKey,source_revision_hash:revisionHash,pipeline_fingerprint:pipelineFingerprint,nlp_protocol_version:NLP_PROTOCOL_VERSION,
      python_version:health.python,spacy_version:health.spacy,model_name:health.model,model_version:health.model_version,rules_version:health.rules,patterns_schema_version:health.patterns_schema_version,
      patterns_digest:health.patterns_digest,redaction_policy_fingerprint:this.redactor!.policyFingerprint,extraction_ready:extractionReady,
      redacted_source_text:prepared.text,entities,relations,links:[],status:'proposed'};
  }

  private fingerprintFromHealth(health:HealthResponse['health']):string{
    return createHash('sha256').update(stableJson({protocol:NLP_PROTOCOL_VERSION,healthProtocol:health.protocol,python:health.python,spacy:health.spacy,model:health.model,modelVersion:health.model_version,rules:health.rules,patternsSchemaVersion:health.patterns_schema_version,patternsDigest:health.patterns_digest,redaction:this.redactor!.policyFingerprint,analyzer:NLP_ANALYZER_VERSION})).digest('hex');
  }

  private candidateEntities(observationId:string,text:string,entities:NlpEntity[]){
    const codepoints=Array.from(text);
    return entities.map(entity=>{
      if(!Number.isSafeInteger(entity.start)||!Number.isSafeInteger(entity.end)||entity.start<0||entity.end<=entity.start||entity.end>codepoints.length||codepoints.slice(entity.start,entity.end).join('')!==entity.text)throw new Error(NLP_GENERIC_ERROR);
      const id=createHash('sha256').update(stableJson([observationId,entity.label,entity.rule_id,entity.start,entity.end,entity.text])).digest('hex');
      return{id,label:entity.label,rule_id:entity.rule_id,text:entity.text,normalized:entity.normalized,start:entity.start,end:entity.end};
    });
  }

  private candidateRelations(text:string,relations:NlpRelation[],entities:Array<{id:string}>){
    const codepoints=Array.from(text);
    return relations.map(relation=>{
      if(!Number.isSafeInteger(relation.from_index)||!Number.isSafeInteger(relation.to_index)||!entities[relation.from_index]||!entities[relation.to_index])throw new Error(NLP_GENERIC_ERROR);
      const evidence=relation.evidence;
      if(!Number.isSafeInteger(evidence.start)||!Number.isSafeInteger(evidence.end)||evidence.start<0||evidence.end<=evidence.start||evidence.end>codepoints.length||codepoints.slice(evidence.start,evidence.end).join('')!==evidence.text)throw new Error(NLP_GENERIC_ERROR);
      return{type:relation.type,rule_id:relation.rule_id,from_candidate_id:entities[relation.from_index]!.id,to_candidate_id:entities[relation.to_index]!.id,evidence:{...evidence}};
    });
  }

  private yamlPreparationKey(projectionVersion:string):string{
    if(!/^[a-z0-9._-]{1,80}$/i.test(projectionVersion)||!this.healthResponse)throw new Error(NLP_GENERIC_ERROR);
    const health=this.healthResponse.health;
    return createHash('sha256').update(JSON.stringify({projectionVersion,protocol:NLP_PROTOCOL_VERSION,healthProtocol:health.protocol,python:health.python,spacy:health.spacy,model:health.model,modelVersion:health.model_version,rules:health.rules,patternsSchemaVersion:health.patterns_schema_version,patternsDigest:health.patterns_digest,analyzer:NLP_ANALYZER_VERSION,redaction:this.redactor!.policyFingerprint})).digest('hex');
  }
}
