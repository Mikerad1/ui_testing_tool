import type {BackfillEdgeValue,BackfillNodeValue} from './content-fingerprint.js';

export type BackfillNodeRecord=BackfillNodeValue&{id:string;payloadHash:string;redactedHash:string};
export type BackfillEdgeRecord=BackfillEdgeValue&{id:string;payloadHash:string;redactedHash:string};
export type BackfillRecord={kind:'node';record:BackfillNodeRecord;backfillStatus:'pending'|'processed'}|{kind:'edge';record:BackfillEdgeRecord;backfillStatus:'pending'|'processed'};
export type BackfillRedactedHash={entityKind:'node'|'edge';entityId:string;redactedHash:string};
/** Invocation counters describe only this call; merged is always zero because backfill updates existing graph IDs in place and has no merge path. */
export type BackfillInvocationSummary={scanned:number;migrated:number;merged:0;rejected:number;stale:number;failed:number;unchanged:number};
export type BackfillSummary={jobId:string;environment:string;status:'running'|'interrupted'|'completed';total:number;processed:number;pending:number;obsolete:number;invocation:BackfillInvocationSummary};
export type BackfillCursor={entityKind:'node'|'edge';entityId:string};
