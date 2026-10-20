import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Store } from '../memory/store.js';
import type { LearningWriter } from '../memory/learning-writer.js';
import { withNlpMetadata, type LearningAttributes, type YamlRecordFingerprint, type YamlReconciliationPlan } from '../memory/learning-types.js';
import type {ValidatedYamlDocument} from '../memory/learning-writer.js';
import { workflowSchema } from '../workflow/contract.js';

const locator = z.object({
  by: z.enum(['role', 'label', 'placeholder', 'test_id', 'text', 'css']),
  role: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  exact: z.boolean().optional(),
}).strict();
const common = { schema_version: z.literal(1), id: z.string().min(1).max(120).regex(/^[\w-]+$/), name: z.string().min(1).max(300) };
const schemas: Record<string, z.ZodTypeAny> = {
  application: z.object({ ...common, kind: z.literal('application'), base_url: z.string().url().optional(), start_screen: z.string().optional(), route_patterns: z.array(z.object({ screen: z.string(), path: z.string() }).strict()).optional() }).strict(),
  role: z.object({ ...common, kind: z.literal('role'), permissions: z.array(z.string().max(150)).optional() }).strict(),
  screen: z.object({ ...common, kind: z.literal('screen'), route: z.string().optional(), landmarks: z.array(z.object({ locator }).strict()).optional(), elements: z.array(z.object({ id: z.string().min(1).max(120), description: z.string().optional(), locator, fallback_locators: z.array(locator).optional(), sensitive: z.boolean().optional() }).strict()).optional(), actions: z.array(z.object({ id: z.string(), element: z.string(), effect: z.object({ navigates_to: z.string().optional() }).strict().optional() }).strict()).optional() }).strict(),
  workflow: workflowSchema,
  navigation_rules: z.object({ schema_version: z.literal(1), id: z.string().min(1).max(120).regex(/^[\w-]+$/), name: z.string().min(1).max(300).default('Navigation rules'), kind: z.literal('navigation_rules'), rules: z.array(z.object({ id: z.string().min(1).max(120), from: z.string(), to: z.string(), via: z.object({ action: z.enum(['click', 'navigate']), target: locator.optional() }).strict(), preconditions: z.array(z.record(z.unknown()).refine(value => Object.keys(value).length > 0)).max(20).optional(), verify: z.object({ condition: z.string().min(1).max(120), pattern: z.string().max(500).optional() }).strict().optional() }).strict()) }).strict(),
};

const toPosixRelative = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');
type Doc = { file: string; doc: any; hash: string };
type RedactedDoc=Doc&{validated:ValidatedYamlDocument};
type PreparedDoc = Doc & { normalized: string; fingerprint:YamlRecordFingerprint; observation?:import('../memory/store.js').CandidateObservationInput };
type Entity = { type: string; key: string; name: string; attrs: LearningAttributes; hash: string; parent?: string; source: string };
type Edge = { key: string; from: string; to: string; relation: string; attrs: LearningAttributes; source: string };
const YAML_PROJECTION_VERSION='yaml-projection-v1';

function validateReferences(docs:Array<{doc:any}>):void{
  const byKey=new Map<string,{doc:any}>();
  for(const entry of docs){const key=`${entry.doc.kind}:${entry.doc.id}`;if(byKey.has(key))throw new Error('Duplicate knowledge identity');byKey.set(key,entry);}
  const ref=(value:string,kind:string)=>{
    const key=value.includes(':')?value:`${kind}:${value}`;
    if(!byKey.has(key))throw new Error('Knowledge reference is missing');
    if(key.split(':')[0]!==kind)throw new Error('Knowledge reference has the wrong kind');
    return key;
  };
  for(const entry of docs){
    const doc=entry.doc;
    if(doc.kind==='screen')for(const action of doc.actions??[]){
      if(!(doc.elements??[]).some((element:any)=>element.id===action.element))throw new Error('Knowledge action references an unknown element');
      if(action.effect?.navigates_to)ref(action.effect.navigates_to,'screen');
    }
    if(doc.kind==='application'){
      if(doc.start_screen)ref(doc.start_screen,'screen');
      for(const route of doc.route_patterns??[])ref(route.screen,'screen');
    }
    if(doc.kind==='workflow'){
      if(doc.start_screen)ref(doc.start_screen,'screen');
      if(doc.end_screen)ref(doc.end_screen,'screen');
      if(doc.requires?.role)ref(doc.requires.role,'role');
      const checkTarget=(target:any)=>{
        if(!target?.screen)return;
        const targetKey=ref(target.screen,'screen'),screen=byKey.get(targetKey)!.doc;
        if(target.element&&!(screen.elements??[]).some((element:any)=>element.id===target.element))throw new Error('Workflow target references an unknown element');
      };
      for(const check of doc.preconditions??[])checkTarget(check.target);
      for(const step of doc.steps)checkTarget(step.target);
    }
    if(doc.kind==='navigation_rules')for(const rule of doc.rules){ref(rule.from,'screen');ref(rule.to,'screen');}
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Knowledge symlink not allowed: ${filename}`);
    if (entry.isDirectory()) out.push(...await walk(filename));
    else if (/\.ya?ml$/i.test(entry.name)) out.push(filename);
  }
  return out.sort();
}

export async function reconcile(root: string, store: Store, writer: LearningWriter): Promise<number> {
  await writer.ensureReady();
  let all: string[] = [];
  try { all = await walk(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const rawDocs: Doc[] = [];
  for (const file of all) {
    if (!(await lstat(file)).isFile()) continue;
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > 1_048_576) throw new Error('Knowledge document is too large');
    let raw: unknown;
    try { raw = parse(text, { uniqueKeys: true }); } catch { throw new Error('Knowledge document could not be parsed safely'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as any).kind !== 'string' || !schemas[(raw as any).kind]) {
      throw new Error('Invalid or unsupported knowledge document');
    }
    const schema = schemas[(raw as any).kind]!;
    let parsed: any;
    try { parsed = schema.parse(raw); } catch { throw new Error('Knowledge document failed validation'); }
    const rawHash=createHash('sha256').update(text).digest('hex');
    rawDocs.push({file,doc:parsed,hash:rawHash});
  }

  const redactedDocs:RedactedDoc[]=[];
  for(const entry of rawDocs){
    const sourcePath=toPosixRelative(root,entry.file),schema=schemas[entry.doc.kind]!;
    const validated=await writer.validateYamlDocument(entry.doc,{sourcePath,documentKind:entry.doc.kind,documentId:entry.doc.id,rawHash:entry.hash,projectionVersion:YAML_PROJECTION_VERSION},value=>{
      try{return schema.parse(value);}catch{throw new Error('Redacted knowledge document failed validation');}
    });
    redactedDocs.push({...entry,doc:validated.value,validated});
  }

  // Validate the complete redacted source set before allowing any NLP cache hit or analysis.
  validateReferences(redactedDocs);

  const docs:PreparedDoc[]=[];
  for(const entry of redactedDocs){
    const prepared=await writer.normalizeYamlDocument(entry.validated);
    docs.push({...entry,doc:prepared.value,normalized:prepared.normalized,fingerprint:entry.validated.fingerprint,observation:prepared.observation});
  }

  const byKey = new Map<string, PreparedDoc>();
  for (const entry of docs) {
    const key = `${entry.doc.kind}:${entry.doc.id}`;
    if (byKey.has(key)) throw new Error('Duplicate knowledge identity');
    byKey.set(key, entry);
  }
  const ref = (value: string, kind: string) => {
    const key = value.includes(':') ? value : `${kind}:${value}`;
    if (!byKey.has(key)) throw new Error('Knowledge reference is missing');
    if (key.split(':')[0] !== kind) throw new Error('Knowledge reference has the wrong kind');
    return key;
  };

  const entities: Entity[] = [];
  const edges: Edge[] = [];
  for (const entry of docs) {
    const doc = entry.doc;
    const key = `${doc.kind}:${doc.id}`;
    const source = toPosixRelative(root, entry.file);
    const push = (type: string, entityKey: string, name: string, attrs: Record<string, unknown>, parent?: string) => {
      entities.push({ type, key: entityKey, name, attrs: withNlpMetadata(attrs, entry.normalized), hash: entry.hash, parent, source });
    };
    push(doc.kind, doc.id, doc.name, doc);
    if (doc.kind !== 'screen') continue;
    for (const element of doc.elements ?? []) {
      push('ui_element', `${key}/${element.id}`, element.description ?? element.id, element, key);
      edges.push({ key: `${key}:contains:${element.id}`, from: key, to: `ui_element:${key}/${element.id}`, relation: 'CONTAINS', attrs: withNlpMetadata({}, entry.normalized), source });
    }
    for (const action of doc.actions ?? []) {
      if (!(doc.elements ?? []).some((element: any) => element.id === action.element)) throw new Error('Knowledge action references an unknown element');
      const actionKey = `${key}/${action.id}`;
      push('action', actionKey, action.id, action, key);
      edges.push({ key: `${key}:trigger:${action.id}`, from: key, to: `action:${actionKey}`, relation: 'TRIGGERED_BY', attrs: withNlpMetadata({}, entry.normalized), source });
      edges.push({ key: `${key}:uses:${action.id}`, from: `action:${actionKey}`, to: `ui_element:${key}/${action.element}`, relation: 'USES_ELEMENT', attrs: withNlpMetadata({}, entry.normalized), source });
      if (action.effect?.navigates_to) edges.push({ key: `${key}:nav:${action.id}`, from: `action:${actionKey}`, to: ref(action.effect.navigates_to, 'screen'), relation: 'NAVIGATES_TO', attrs: withNlpMetadata({}, entry.normalized), source });
    }
  }

  const app = docs.find(entry => entry.doc.kind === 'application');
  for (const entry of docs) {
    const doc = entry.doc;
    const key = `${doc.kind}:${doc.id}`;
    const source = toPosixRelative(root, entry.file);
    if (doc.kind === 'application') {
      if (doc.start_screen) ref(doc.start_screen, 'screen');
      for (const route of doc.route_patterns ?? []) {
        const target = ref(route.screen, 'screen');
        edges.push({ key: `${key}:route:${route.path}:${target}`, from: key, to: target, relation: 'HAS_SCREEN', attrs: withNlpMetadata({ path: route.path }, entry.normalized), source });
      }
    }
    if (doc.kind === 'workflow') {
      if (doc.start_screen) edges.push({ key: `${key}:start`, from: key, to: ref(doc.start_screen, 'screen'), relation: 'LEADS_TO', attrs: withNlpMetadata({ kind: 'start' }, entry.normalized), source });
      if (doc.end_screen) edges.push({ key: `${key}:end`, from: key, to: ref(doc.end_screen, 'screen'), relation: 'LEADS_TO', attrs: withNlpMetadata({ kind: 'end' }, entry.normalized), source });
      if (doc.requires?.role) edges.push({ key: `${key}:role`, from: key, to: ref(doc.requires.role, 'role'), relation: 'REQUIRES_ROLE', attrs: withNlpMetadata({}, entry.normalized), source });
      const checkTarget = (target: any) => {
        if (!target?.screen) return undefined;
        const targetKey = ref(target.screen, 'screen');
        const screen = byKey.get(targetKey)!.doc;
        if (target.element && !(screen.elements ?? []).some((element: any) => element.id === target.element)) throw new Error('Workflow target references an unknown element');
        return targetKey;
      };
      for (const check of doc.preconditions ?? []) checkTarget(check.target);
      for (let index = 0; index < doc.steps.length; index += 1) {
        const step = doc.steps[index]!;
        const target = checkTarget(step.target);
        if (target) edges.push({ key: `${key}:step:${step.id}`, from: key, to: step.target.element ? `ui_element:${target}/${step.target.element}` : target, relation: step.target.element ? 'USES_ELEMENT' : 'EXECUTES', attrs: withNlpMetadata({ step_id: step.id, order: index, action: step.action }, entry.normalized), source });
      }
    }
    if (doc.kind === 'navigation_rules') {
      for (const rule of doc.rules) edges.push({ key: `${key}:rule:${rule.id}`, from: ref(rule.from, 'screen'), to: ref(rule.to, 'screen'), relation: 'NAVIGATES_TO', attrs: withNlpMetadata({ via: rule.via, preconditions: rule.preconditions, verify: rule.verify, rule_id: rule.id }, entry.normalized), source });
    }
  }
  if (app) {
    for (const entry of docs.filter(item => item.doc.kind === 'screen' && item.doc.route)) {
      edges.push({ key: `application:${app.doc.id}:route:${entry.doc.id}:${entry.doc.route}`, from: `application:${app.doc.id}`, to: `screen:${entry.doc.id}`, relation: 'HAS_SCREEN', attrs: withNlpMetadata({ path: entry.doc.route }, entry.normalized), source: toPosixRelative(root, app.file) });
    }
  }

  const plan: YamlReconciliationPlan = {
    sources: docs.map(entry => ({ path: toPosixRelative(root, entry.file), hash: entry.hash })),
    entities,
    edges,
    recordFingerprints:docs.map(entry=>entry.fingerprint),
    candidateObservations:docs.flatMap(entry=>entry.observation?[entry.observation]:[]),
  };
  return writer.commitReconciliation(plan);
}

/** Validate knowledge documents without opening a store or changing filesystem state. */
export async function validateKnowledge(root: string): Promise<number> {
  let all: string[] = [];
  try { all = await walk(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const docs: Doc[] = [];
  for (const file of all) {
    if (!(await lstat(file)).isFile()) continue;
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > 1_048_576) throw new Error(`YAML too large: ${file}`);
    const raw = parse(text, { uniqueKeys: true });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !schemas[(raw as any).kind]) throw new Error(`Invalid or unsupported document kind in ${file}`);
    docs.push({ file, doc: schemas[(raw as any).kind]!.parse(raw), hash: createHash('sha256').update(text).digest('hex') });
  }
  const byKey = new Map<string, Doc>();
  for (const entry of docs) {
    const key = `${entry.doc.kind}:${entry.doc.id}`;
    if (byKey.has(key)) throw new Error(`Duplicate knowledge id ${key}`);
    byKey.set(key, entry);
  }
  const ref = (value: string, kind: string) => {
    const key = value.includes(':') ? value : `${kind}:${value}`;
    if (!byKey.has(key)) throw new Error(`Unknown ${kind} reference ${value}`);
    if (key.split(':')[0] !== kind) throw new Error(`Wrong kind for reference ${value}; expected ${kind}`);
    return key;
  };
  for (const entry of docs) {
    const doc = entry.doc;
    const key = `${doc.kind}:${doc.id}`;
    if (doc.kind === 'screen') {
      for (const action of doc.actions ?? []) {
        if (!(doc.elements ?? []).some((element: any) => element.id === action.element)) throw new Error(`Unknown local element ${action.element} in ${key}`);
        if (action.effect?.navigates_to) ref(action.effect.navigates_to, 'screen');
      }
    }
    if (doc.kind === 'application') {
      if (doc.start_screen) ref(doc.start_screen, 'screen');
      for (const route of doc.route_patterns ?? []) ref(route.screen, 'screen');
    }
    if (doc.kind === 'workflow') {
      if (doc.start_screen) ref(doc.start_screen, 'screen');
      if (doc.end_screen) ref(doc.end_screen, 'screen');
      if (doc.requires?.role) ref(doc.requires.role, 'role');
      const checkTarget = (target: any) => {
        if (!target?.screen) return;
        const targetKey = ref(target.screen, 'screen');
        if (target.element && !((byKey.get(targetKey)!.doc.elements ?? []).some((element: any) => element.id === target.element))) throw new Error(`Unknown local element ${target.element} in ${targetKey}`);
      };
      for (const check of doc.preconditions ?? []) checkTarget(check.target);
      for (const step of doc.steps) checkTarget(step.target);
    }
    if (doc.kind === 'navigation_rules') for (const rule of doc.rules) { ref(rule.from, 'screen'); ref(rule.to, 'screen'); }
  }
  return docs.length;
}
