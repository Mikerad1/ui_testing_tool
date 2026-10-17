import {createHash} from 'node:crypto';
import {NLP_METADATA_KEY} from './learning-types.js';

export type BackfillNodeValue={type:string;stable_key:string;display_name:string;attributes:Record<string,unknown>};
export type BackfillEdgeValue={from_id:string;to_id:string;relation:string;attributes:Record<string,unknown>};

export function stableJson(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson((value as Record<string,unknown>)[key])}`).join(',')}}`;
  const result=JSON.stringify(value);
  if(result===undefined)throw new Error('Memory content is invalid');
  return result;
}

export function hashJson(value:unknown):string{return createHash('sha256').update(stableJson(value)).digest('hex');}

export function withoutNlpMetadata(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Memory content is invalid');
  const result={...(value as Record<string,unknown>)};
  delete result[NLP_METADATA_KEY];
  return result;
}

export function hashBackfillNode(value:BackfillNodeValue):string{return hashJson({...value,attributes:withoutNlpMetadata(value.attributes)});}
export function hashBackfillEdge(value:BackfillEdgeValue):string{return hashJson({...value,attributes:withoutNlpMetadata(value.attributes)});}
