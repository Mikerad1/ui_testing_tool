import type {BackfillEdgeValue,BackfillNodeValue} from './content-fingerprint.js';

export type BackfillNodeRecord=BackfillNodeValue&{id:string;payloadHash:string;redactedHash:string};
export type BackfillEdgeRecord=BackfillEdgeValue&{id:string;payloadHash:string;redactedHash:string};
export type BackfillRecord={kind:'node';record:BackfillNodeRecord}|{kind:'edge';record:BackfillEdgeRecord};
export type BackfillRedactedHash={entityKind:'node'|'edge';entityId:string;redactedHash:string};
export type BackfillSummary={jobId:string;environment:string;status:'running'|'interrupted'|'completed';total:number;processed:number;pending:number;obsolete:number};
