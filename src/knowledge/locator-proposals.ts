import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
import type {Store} from '../memory/store.js';
import type {LearningWriter} from '../memory/learning-writer.js';
import {validateKnowledge,reconcile} from './reconcile.js';

export type SafeLocator=Record<string,string|boolean> & {by:'role'|'label'|'placeholder'|'test_id'|'text'|'css'};
const BY=new Set(['role','label','placeholder','test_id','text','css']);
export function normalizeLocator(value:unknown):SafeLocator{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid semantic locator');const v=value as Record<string,unknown>;
 if(Object.keys(v).some(key=>!['by','role','name','value','exact'].includes(key))||typeof v.by!=='string'||!BY.has(v.by))throw Error('Invalid semantic locator');
 const out:Record<string,string|boolean>={by:v.by as SafeLocator['by']};
 if(v.by==='role'){if(typeof v.role!=='string'||!v.role.length||v.role.length>100)throw Error('Invalid role locator');out.role=v.role;if(v.name!==undefined){if(typeof v.name!=='string'||v.name.length>500)throw Error('Invalid role locator');out.name=v.name;}if(v.value!==undefined)throw Error('Invalid role locator');}
 else{if(typeof v.value!=='string'||!v.value.length||v.value.length>1000)throw Error('Invalid semantic locator');out.value=v.value;if(v.role!==undefined||v.name!==undefined)throw Error('Invalid semantic locator');}
 if(v.exact!==undefined){if(typeof v.exact!=='boolean')throw Error('Invalid semantic locator');out.exact=v.exact;}return out as SafeLocator;
}
const canonical=(value:any):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const inside=(root:string,file:string)=>{const relative=path.relative(root,file);return relative!== '..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};

export async function readLocatorProposalSource(knowledgeRoot:string,sourcePath:string,screenId:string,elementId:string){
 if(!sourcePath||path.isAbsolute(sourcePath)||path.win32.isAbsolute(sourcePath)||sourcePath.split(/[\\/]/).some(part=>part==='..'||part===''))throw Error('Unsafe knowledge source path');
 const root=await realpath(knowledgeRoot),file=path.resolve(root,sourcePath);if(!inside(root,file))throw Error('Unsafe knowledge source path');let current=root;
 for(const part of path.relative(root,file).split(path.sep)){current=path.join(current,part);const info=await lstat(current);if(info.isSymbolicLink())throw Error('Knowledge symlink is not allowed');}
 const canonicalFile=await realpath(file);if(!inside(root,canonicalFile)||!(await lstat(canonicalFile)).isFile())throw Error('Unsafe knowledge source path');
 const raw=await readFile(canonicalFile,'utf8');if(raw.length>1_048_576)throw Error('Knowledge source is too large');const doc=parse(raw,{uniqueKeys:true}) as any;
 if(!doc||doc.kind!=='screen'||doc.id!==screenId||!Array.isArray(doc.elements))throw Error('Knowledge screen identity changed');const element=doc.elements.find((entry:any)=>entry?.id===elementId);if(!element)throw Error('Knowledge element identity changed');
 const normalized=structuredClone(doc),target=normalized.elements.find((entry:any)=>entry.id===elementId);target.locator='__UMB_LOCATOR__';target.fallback_locators='__UMB_FALLBACKS__';
 return{document:doc,element,sourceHash:hash(raw),baselineHash:hash(canonical(normalized)),canonicalPath:canonicalFile};
}

export function locatorEquals(left:unknown,right:unknown){try{return canonical(normalizeLocator(left))===canonical(normalizeLocator(right));}catch{return false;}}

export async function confirmWorkflowLocatorProposal(store:Store,proposalId:string,knowledgeRoot:string,writer:LearningWriter){
 const proposal=store.getWorkflowLocatorProposal(proposalId) as any;if(!proposal)throw Error('Unknown locator proposal');if(proposal.status==='accepted')return{status:'accepted' as const};if(proposal.status!=='pending')return{status:proposal.status as 'rejected'|'stale'};
 const stale=()=>{try{store.setWorkflowLocatorProposalStatus(proposalId,'stale');}catch{}return{status:'stale' as const};};
 try{
  const workflow=store.get(proposal.workflow_node_id) as any,screen=store.get(proposal.screen_node_id) as any,element=store.get(proposal.element_node_id) as any;if(!workflow||workflow.origin!=='yaml'||workflow.type!=='workflow'||workflow.canonical_key!==proposal.workflow_id||!screen||screen.origin!=='yaml'||screen.type!=='screen'||screen.canonical_key!==proposal.screen_id||!element||element.origin!=='yaml'||element.type!=='ui_element'||element.canonical_key!==`screen:${proposal.screen_id}/${proposal.element_id}`)return stale();const workflowDoc=JSON.parse(workflow.attributes_json);const step=Array.isArray(workflowDoc.steps)?workflowDoc.steps.find((item:any)=>item?.id===proposal.step_id):undefined;if(!step?.target||typeof step.target!=='object'||!('screen'in step.target)||String(step.target.screen).replace(/^screen:/,'')!==proposal.screen_id||step.target.element!==proposal.element_id)return stale();
  const ownership=store.db.prepare("SELECT source_path FROM yaml_ownership WHERE project_id=? AND entity_id=? AND entity_type='ui_element' AND tombstone=0 ORDER BY source_path LIMIT 1").get(store.projectId,proposal.element_node_id) as {source_path:string}|undefined;if(!ownership||ownership.source_path!==proposal.source_path)return stale();
  const source=await readLocatorProposalSource(knowledgeRoot,proposal.source_path,proposal.screen_id,proposal.element_id);
  if(source.baselineHash!==proposal.baseline_hash||source.document.id!==proposal.screen_id||!locatorEquals(source.element.locator,JSON.parse(proposal.candidate_locator_json)))return stale();
  const previous=normalizeLocator(JSON.parse(proposal.previous_locator_json)),oldHistory=JSON.parse(proposal.fallback_history_json) as unknown[];
  if(locatorEquals(previous,source.element.locator)||!Array.isArray(source.element.fallback_locators)||!source.element.fallback_locators.some((item:unknown)=>locatorEquals(item,previous))||!oldHistory.every(item=>source.element.fallback_locators.some((current:unknown)=>locatorEquals(current,item))))return stale();
   await validateKnowledge(knowledgeRoot);await reconcile(knowledgeRoot,store,writer);const verified=await readLocatorProposalSource(knowledgeRoot,proposal.source_path,proposal.screen_id,proposal.element_id),reconciledElement=store.getByTypeKey('ui_element',`screen:${proposal.screen_id}/${proposal.element_id}`) as any;if(verified.baselineHash!==proposal.baseline_hash||!locatorEquals(verified.element.locator,JSON.parse(proposal.candidate_locator_json))||!verified.element.fallback_locators?.some((item:unknown)=>locatorEquals(item,previous))||!reconciledElement||!locatorEquals(JSON.parse(reconciledElement.attributes_json).locator,JSON.parse(proposal.candidate_locator_json)))return stale();store.setWorkflowLocatorProposalStatus(proposalId,'accepted');return{status:'accepted' as const};
 }catch{return stale();}
}
