import { z } from 'zod';
import { NLP_METADATA_KEY } from '../memory/learning-types.js';

const safeId = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const screenRef = z.union([safeId,z.string().max(127).regex(/^screen:[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/)]);
const roleRef = z.union([safeId,z.string().max(125).regex(/^role:[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/)]);
const boundedText = z.string().max(10_000);
const locator = z.discriminatedUnion('by', [
  z.object({by:z.literal('role'),role:z.string().min(1).max(100),name:z.string().max(500).optional()}).strict(),
  z.object({by:z.literal('label'),value:z.string().min(1).max(1000)}).strict(),
  z.object({by:z.literal('placeholder'),value:z.string().min(1).max(1000)}).strict(),
  z.object({by:z.literal('test_id'),value:z.string().min(1).max(1000)}).strict(),
  z.object({by:z.literal('text'),value:z.string().min(1).max(1000)}).strict(),
  z.object({by:z.literal('css'),value:z.string().min(1).max(1000)}).strict(),
]);
const target = z.union([
  z.object({screen:screenRef,element:safeId}).strict(),
  locator,
]);
const assertionBase = {condition:z.enum(['visible','hidden','enabled','text','url_matches','count','value','present'])};
const assertion = z.discriminatedUnion('condition', [
  z.object({...assertionBase,condition:z.enum(['visible','hidden','enabled','present']),target}).strict(),
  z.object({...assertionBase,condition:z.literal('text'),target,expected:boundedText,match:z.enum(['contains','exact']).optional()}).strict(),
  z.object({...assertionBase,condition:z.literal('value'),target,expected:boundedText,match:z.enum(['contains','exact']).optional()}).strict(),
  z.object({...assertionBase,condition:z.literal('url_matches'),expected:boundedText.min(1)}).strict(),
  z.object({...assertionBase,condition:z.literal('count'),target,expected:z.number().int().min(0).max(10000)}).strict(),
]);
const timeout=z.number().int().min(1).max(30_000).optional();
const commonStep={id:safeId,timeout_ms:timeout};
const stepSchemas=[
  z.object({...commonStep,action:z.literal('navigate'),path:z.string().min(1).max(2048).refine(x=>x.startsWith('/')&&!x.startsWith('//')&&!/^[a-z][a-z\d+.-]*:/i.test(x),'Expected a project-relative path')}).strict(),
  z.object({...commonStep,action:z.literal('click'),target}).strict(),
  z.object({...commonStep,action:z.literal('fill'),target,value:boundedText}).strict(),
  z.object({...commonStep,action:z.literal('type'),target,value:boundedText}).strict(),
  z.object({...commonStep,action:z.literal('press'),target,key:z.string().min(1).max(100)}).strict(),
  z.object({...commonStep,action:z.literal('select'),target,value:boundedText}).strict(),
  z.object({...commonStep,action:z.literal('scroll'),direction:z.enum(['up','down']),amount:z.number().int().min(1).max(3000).optional()}).strict(),
  z.object({...commonStep,action:z.literal('wait'),condition:z.enum(['visible','hidden','attached','detached','enabled','url']),target:z.union([target,boundedText]).optional(),max_attempts:z.number().int().min(2).max(3).optional()}).strict().superRefine((step,ctx)=>{if(step.condition==='url'&&(typeof step.target!=='string'||step.target.length===0))ctx.addIssue({code:'custom',path:['target'],message:'URL wait requires a URL substring'});if(step.condition!=='url'&&(!step.target||typeof step.target==='string'))ctx.addIssue({code:'custom',path:['target'],message:'Element wait requires a target'});}),
];
// The action-specific assertion variants are represented directly to retain discriminated parsing.
const assertSteps=[
  z.object({...commonStep,action:z.literal('assert'),condition:z.enum(['visible','hidden','enabled','present']),target}).strict(),
  z.object({...commonStep,action:z.literal('assert'),condition:z.literal('text'),target,expected:boundedText,match:z.enum(['contains','exact']).optional()}).strict(),
  z.object({...commonStep,action:z.literal('assert'),condition:z.literal('value'),target,expected:boundedText,match:z.enum(['contains','exact']).optional()}).strict(),
  z.object({...commonStep,action:z.literal('assert'),condition:z.literal('url_matches'),expected:boundedText.min(1)}).strict(),
  z.object({...commonStep,action:z.literal('assert'),condition:z.literal('count'),target,expected:z.number().int().min(0).max(10000)}).strict(),
];
const workflowStepSchema=z.union([
  stepSchemas[0]!,stepSchemas[1]!,stepSchemas[2]!,stepSchemas[3]!,stepSchemas[4]!,stepSchemas[5]!,stepSchemas[6]!,stepSchemas[7]!,
  assertSteps[0]!,assertSteps[1]!,assertSteps[2]!,assertSteps[3]!,assertSteps[4]!,
]);
export {workflowStepSchema};
const baseWorkflow=z.object({schema_version:z.literal(1),kind:z.literal('workflow'),id:safeId,name:z.string().min(1).max(300),start_screen:screenRef.optional(),end_screen:screenRef.optional(),requires:z.object({role:roleRef.optional(),environment:z.array(z.string().min(1).max(100)).max(20).optional()}).strict().optional(),variables:z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),z.object({from_env:z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),sensitive:z.boolean().default(true)}).strict()).optional(),preconditions:z.array(assertion).max(20).optional(),steps:z.array(workflowStepSchema).min(1).max(100),on_failure:z.object({capture:z.array(z.enum(['snapshot','screenshot','desktop_screenshot','console_errors'])).max(4).optional(),stop:z.literal(true).default(true)}).strict().optional()}).strict();
export const workflowSchema=baseWorkflow.superRefine((workflow,ctx)=>{
  const input=workflow as any;const ids=new Set<string>();for(const step of input.steps){if(ids.has(step.id))ctx.addIssue({code:'custom',path:['steps'],message:'Step IDs must be unique'});ids.add(step.id);}
  const refs=new Set<string>();
  const visit=(v:unknown,path:(string|number)[]=[]):void=>{
    if(typeof v==='string'&&v.includes('${{')){
      const [root,index,field]=path;const owner=root==='steps'?input.steps[index as number]:root==='preconditions'?input.preconditions?.[index as number]:undefined;
      const permitted=(root==='steps'&&field==='value'&&['fill','type','select'].includes(owner?.action))||(root==='steps'&&field==='expected'&&owner?.action==='assert'&&['text','value'].includes(owner?.condition))||(root==='preconditions'&&field==='expected'&&['text','value'].includes(owner?.condition));
      const matches=[...v.matchAll(/\$\{\{\s*variables\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)];
      if(!permitted||matches.length!==1||matches[0]![0]!==v)ctx.addIssue({code:'custom',message:'Variable references must be whole-field payload references'});else refs.add(matches[0]![1]!);
    } else if(Array.isArray(v))v.forEach((entry,i)=>visit(entry,[...path,i]));
    else if(v&&typeof v==='object')for(const [key,entry] of Object.entries(v)){if(key.includes('${{'))ctx.addIssue({code:'custom',message:'Variable references are not allowed in configuration keys'});visit(entry,[...path,key]);}
  };
  input.steps.forEach((step:any,i:number)=>visit(step,['steps',i]));input.preconditions?.forEach((check:any,i:number)=>visit(check,['preconditions',i]));
  for(const name of refs)if(!input.variables?.[name])ctx.addIssue({code:'custom',message:`Undeclared workflow variable ${name}`});
});
export type WorkflowTarget=z.infer<typeof target>;
export type WorkflowAssertion=z.infer<typeof assertion>;
type StepBase={id:string;timeout_ms?:number};
export type WorkflowStep=StepBase & (
  | {action:'navigate';path:string}
  | {action:'click';target:WorkflowTarget}
  | {action:'fill'|'type'|'select';target:WorkflowTarget;value:string}
  | {action:'press';target:WorkflowTarget;key:string}
  | {action:'scroll';direction:'up'|'down';amount?:number}
  | {action:'wait';condition:'visible'|'hidden'|'attached'|'detached'|'enabled'|'url';target:WorkflowTarget|string;max_attempts?:2|3}
  | {action:'assert';condition:'visible'|'hidden'|'enabled'|'present';target:WorkflowTarget}
  | {action:'assert';condition:'text'|'value';target:WorkflowTarget;expected:string;match?:'contains'|'exact'}
  | {action:'assert';condition:'url_matches';expected:string}
  | {action:'assert';condition:'count';target:WorkflowTarget;expected:number}
);
export type WorkflowDocument={schema_version:1;kind:'workflow';id:string;name:string;start_screen?:string;end_screen?:string;requires?:{role?:string;environment?:string[]};variables?:Record<string,{from_env:string;sensitive:boolean}>;preconditions?:WorkflowAssertion[];steps:WorkflowStep[];on_failure?:{capture?:('snapshot'|'screenshot'|'desktop_screenshot'|'console_errors')[];stop:true}};
export function parseWorkflowDocument(input:unknown):WorkflowDocument{return workflowSchema.parse(input) as WorkflowDocument;}
export function parseStoredWorkflowDocument(input:unknown):WorkflowDocument{
  if(!input||typeof input!=='object'||Array.isArray(input))return parseWorkflowDocument(input);
  const copy={...(input as Record<string,unknown>)};
  const metadata=copy[NLP_METADATA_KEY];
  if(metadata!==undefined){
    if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error('Invalid stored workflow metadata');
    const record=metadata as Record<string,unknown>;
    if(record.protocol!==1||typeof record.normalized!=='string'||record.normalized.length>64*1024)throw Error('Invalid stored workflow metadata');
    delete copy[NLP_METADATA_KEY];
  }
  return parseWorkflowDocument(copy);
}
export function resolveWorkflowVariables(workflow:WorkflowDocument,env:NodeJS.ProcessEnv=process.env):Record<string,string>{
  const resolved:Record<string,string>={};for(const [name,declaration] of Object.entries(workflow.variables??{})){const value=env[declaration.from_env];if(value===undefined)throw new Error(`Missing environment variable ${declaration.from_env} for workflow variable ${name}`);if(value.length>10_000)throw new Error(`Environment variable ${declaration.from_env} exceeds the workflow value limit`);resolved[name]=value;}return resolved;
}
