import type Database from 'better-sqlite3';

export type GraphNodeIdentity={id:string;project_id:string;environment:string;type:string;canonical_key:string};
export type GraphEdgeIdentity={id:string;project_id:string;environment:string;from_node_id:string;to_node_id:string;relation_type:string};
export type GraphOwnerIdentity={project_id:string;environment:string;entity_id:string;entity_type:string;entity_key:string;source_path:string};
export type GraphSourceIdentity={project_id:string;environment:string;path:string};
export type GraphMutationWriteSet={
  nodes:Array<{operation:'insert'|'update'|'delete';old:GraphNodeIdentity|null;next:GraphNodeIdentity|null}>;
  edges:Array<{operation:'insert'|'update'|'delete';old:GraphEdgeIdentity|null;next:GraphEdgeIdentity|null}>;
  owners:Array<{operation:'insert'|'update'|'delete';old:GraphOwnerIdentity|null;next:GraphOwnerIdentity|null}>;
  sources:Array<{operation:'insert'|'update'|'delete';old:GraphSourceIdentity|null;next:GraphSourceIdentity|null}>;
  changedNodeIds:string[];
  changedEdgeIds:string[];
  changedEdgeEndpoints:string[];
  changedOwnerEntityIds:string[];
  changedOwnerKeys:string[];
  changedOwnerSourcePaths:string[];
  changedSourcePaths:string[];
  affectedOwners:GraphOwnerIdentity[];
  affectedOwnerEntityIds:string[];
  affectedActionNodeIds:string[];
};
export type GraphMutationFinalizer=(writeSet:GraphMutationWriteSet)=>void;

const identity=(row:any):GraphNodeIdentity|null=>row&&row.id!=null?{id:row.id,project_id:row.project_id,environment:row.environment,type:row.type,canonical_key:row.canonical_key}:null;
const edgeIdentity=(row:any):GraphEdgeIdentity|null=>row&&row.id!=null?{id:row.id,project_id:row.project_id,environment:row.environment,from_node_id:row.from_node_id,to_node_id:row.to_node_id,relation_type:row.relation_type}:null;
const ownerIdentity=(row:any):GraphOwnerIdentity|null=>row&&row.entity_id!=null?{project_id:row.project_id,environment:row.environment,entity_id:row.entity_id,entity_type:row.entity_type,entity_key:row.entity_key,source_path:row.source_path}:null;
const sourceIdentity=(row:any):GraphSourceIdentity|null=>row&&row.path!=null?{project_id:row.project_id,environment:row.environment,path:row.path}:null;

/** TEMP triggers journal old and new graph identities on this Store connection. */
export function installGraphMutationCapture(db:Database.Database):void{
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS _umb_graph_nodes(op TEXT,old_id TEXT,old_project TEXT,old_environment TEXT,old_type TEXT,old_key TEXT,new_id TEXT,new_project TEXT,new_environment TEXT,new_type TEXT,new_key TEXT);
    CREATE TEMP TABLE IF NOT EXISTS _umb_graph_edges(op TEXT,old_id TEXT,old_project TEXT,old_environment TEXT,old_from TEXT,old_to TEXT,old_relation TEXT,new_id TEXT,new_project TEXT,new_environment TEXT,new_from TEXT,new_to TEXT,new_relation TEXT);
    CREATE TEMP TABLE IF NOT EXISTS _umb_graph_owners(op TEXT,old_project TEXT,old_environment TEXT,old_entity TEXT,old_type TEXT,old_key TEXT,old_path TEXT,new_project TEXT,new_environment TEXT,new_entity TEXT,new_type TEXT,new_key TEXT,new_path TEXT);
    CREATE TEMP TABLE IF NOT EXISTS _umb_graph_sources(op TEXT,old_project TEXT,old_environment TEXT,old_path TEXT,new_project TEXT,new_environment TEXT,new_path TEXT);
    CREATE TEMP TRIGGER IF NOT EXISTS _umb_nodes_ai AFTER INSERT ON main.nodes BEGIN INSERT INTO _umb_graph_nodes VALUES('insert',NULL,NULL,NULL,NULL,NULL,NEW.id,NEW.project_id,NEW.environment,NEW.type,NEW.canonical_key); END;
    CREATE TEMP TRIGGER IF NOT EXISTS _umb_nodes_au AFTER UPDATE ON main.nodes WHEN OLD.id IS NOT NEW.id OR OLD.project_id IS NOT NEW.project_id OR OLD.environment IS NOT NEW.environment OR OLD.type IS NOT NEW.type OR OLD.stable_key IS NOT NEW.stable_key OR OLD.canonical_key IS NOT NEW.canonical_key OR OLD.display_name IS NOT NEW.display_name OR OLD.attributes_json IS NOT NEW.attributes_json OR OLD.origin IS NOT NEW.origin OR OLD.verification_status IS NOT NEW.verification_status OR OLD.confidence IS NOT NEW.confidence OR OLD.content_hash IS NOT NEW.content_hash OR OLD.tombstone IS NOT NEW.tombstone OR OLD.superseded_by IS NOT NEW.superseded_by OR OLD.updated_at IS NOT NEW.updated_at OR OLD.conflict_status IS NOT NEW.conflict_status OR OLD.conflicting_node_id IS NOT NEW.conflicting_node_id BEGIN INSERT INTO _umb_graph_nodes VALUES('update',OLD.id,OLD.project_id,OLD.environment,OLD.type,OLD.canonical_key,NEW.id,NEW.project_id,NEW.environment,NEW.type,NEW.canonical_key); END;
    CREATE TEMP TRIGGER IF NOT EXISTS _umb_nodes_ad AFTER DELETE ON main.nodes BEGIN INSERT INTO _umb_graph_nodes VALUES('delete',OLD.id,OLD.project_id,OLD.environment,OLD.type,OLD.canonical_key,NULL,NULL,NULL,NULL,NULL); END;
    CREATE TEMP TRIGGER IF NOT EXISTS _umb_edges_ai AFTER INSERT ON main.edges BEGIN INSERT INTO _umb_graph_edges VALUES('insert',NULL,NULL,NULL,NULL,NULL,NULL,NEW.id,NEW.project_id,NEW.environment,NEW.from_node_id,NEW.to_node_id,NEW.relation_type); END;
    CREATE TEMP TRIGGER IF NOT EXISTS _umb_edges_au AFTER UPDATE ON main.edges WHEN OLD.id IS NOT NEW.id OR OLD.project_id IS NOT NEW.project_id OR OLD.environment IS NOT NEW.environment OR OLD.from_node_id IS NOT NEW.from_node_id OR OLD.to_node_id IS NOT NEW.to_node_id OR OLD.relation_type IS NOT NEW.relation_type OR OLD.attributes_json IS NOT NEW.attributes_json OR OLD.origin IS NOT NEW.origin OR OLD.verification_status IS NOT NEW.verification_status OR OLD.tombstone IS NOT NEW.tombstone OR OLD.updated_at IS NOT NEW.updated_at OR OLD.conflict_status IS NOT NEW.conflict_status OR OLD.stable_key IS NOT NEW.stable_key BEGIN INSERT INTO _umb_graph_edges VALUES('update',OLD.id,OLD.project_id,OLD.environment,OLD.from_node_id,OLD.to_node_id,OLD.relation_type,NEW.id,NEW.project_id,NEW.environment,NEW.from_node_id,NEW.to_node_id,NEW.relation_type); END;
    CREATE TEMP TRIGGER IF NOT EXISTS _umb_edges_ad AFTER DELETE ON main.edges BEGIN INSERT INTO _umb_graph_edges VALUES('delete',OLD.id,OLD.project_id,OLD.environment,OLD.from_node_id,OLD.to_node_id,OLD.relation_type,NULL,NULL,NULL,NULL,NULL,NULL); END;
    CREATE TEMP TRIGGER IF NOT EXISTS _umb_owners_ai AFTER INSERT ON main.yaml_ownership BEGIN INSERT INTO _umb_graph_owners VALUES('insert',NULL,NULL,NULL,NULL,NULL,NULL,NEW.project_id,NEW.environment,NEW.entity_id,NEW.entity_type,NEW.entity_key,NEW.source_path); END;
    CREATE TEMP TRIGGER IF NOT EXISTS _umb_owners_au AFTER UPDATE ON main.yaml_ownership WHEN OLD.project_id IS NOT NEW.project_id OR OLD.environment IS NOT NEW.environment OR OLD.source_path IS NOT NEW.source_path OR OLD.entity_type IS NOT NEW.entity_type OR OLD.entity_key IS NOT NEW.entity_key OR OLD.entity_id IS NOT NEW.entity_id OR OLD.hash IS NOT NEW.hash OR OLD.tombstone IS NOT NEW.tombstone OR OLD.conflict_status IS NOT NEW.conflict_status OR OLD.conflicting_entity_id IS NOT NEW.conflicting_entity_id BEGIN INSERT INTO _umb_graph_owners VALUES('update',OLD.project_id,OLD.environment,OLD.entity_id,OLD.entity_type,OLD.entity_key,OLD.source_path,NEW.project_id,NEW.environment,NEW.entity_id,NEW.entity_type,NEW.entity_key,NEW.source_path); END;
    CREATE TEMP TRIGGER IF NOT EXISTS _umb_owners_ad AFTER DELETE ON main.yaml_ownership BEGIN INSERT INTO _umb_graph_owners VALUES('delete',OLD.project_id,OLD.environment,OLD.entity_id,OLD.entity_type,OLD.entity_key,OLD.source_path,NULL,NULL,NULL,NULL,NULL,NULL); END;
    CREATE TEMP TRIGGER IF NOT EXISTS _umb_sources_ai AFTER INSERT ON main.yaml_sources BEGIN INSERT INTO _umb_graph_sources VALUES('insert',NULL,NULL,NULL,NEW.project_id,NEW.environment,NEW.path); END;
    CREATE TEMP TRIGGER IF NOT EXISTS _umb_sources_au AFTER UPDATE ON main.yaml_sources WHEN OLD.project_id IS NOT NEW.project_id OR OLD.environment IS NOT NEW.environment OR OLD.path IS NOT NEW.path OR OLD.hash IS NOT NEW.hash OR OLD.imported_at IS NOT NEW.imported_at OR OLD.active IS NOT NEW.active BEGIN INSERT INTO _umb_graph_sources VALUES('update',OLD.project_id,OLD.environment,OLD.path,NEW.project_id,NEW.environment,NEW.path); END;
    CREATE TEMP TRIGGER IF NOT EXISTS _umb_sources_ad AFTER DELETE ON main.yaml_sources BEGIN INSERT INTO _umb_graph_sources VALUES('delete',OLD.project_id,OLD.environment,OLD.path,NULL,NULL,NULL); END;`);
}

export function readGraphMutationWriteSet(db:Database.Database):GraphMutationWriteSet{
  const nodeRows=db.prepare('SELECT * FROM _umb_graph_nodes').all() as any[],edgeRows=db.prepare('SELECT * FROM _umb_graph_edges').all() as any[],ownerRows=db.prepare('SELECT * FROM _umb_graph_owners').all() as any[],sourceRows=db.prepare('SELECT * FROM _umb_graph_sources').all() as any[];
  const nodes=nodeRows.map(r=>({operation:r.op,old:identity({id:r.old_id,project_id:r.old_project,environment:r.old_environment,type:r.old_type,canonical_key:r.old_key}),next:identity({id:r.new_id,project_id:r.new_project,environment:r.new_environment,type:r.new_type,canonical_key:r.new_key})})) as GraphMutationWriteSet['nodes'];
  const edges=edgeRows.map(r=>({operation:r.op,old:edgeIdentity({id:r.old_id,project_id:r.old_project,environment:r.old_environment,from_node_id:r.old_from,to_node_id:r.old_to,relation_type:r.old_relation}),next:edgeIdentity({id:r.new_id,project_id:r.new_project,environment:r.new_environment,from_node_id:r.new_from,to_node_id:r.new_to,relation_type:r.new_relation})})) as GraphMutationWriteSet['edges'];
  const owners=ownerRows.map(r=>({operation:r.op,old:ownerIdentity({project_id:r.old_project,environment:r.old_environment,entity_id:r.old_entity,entity_type:r.old_type,entity_key:r.old_key,source_path:r.old_path}),next:ownerIdentity({project_id:r.new_project,environment:r.new_environment,entity_id:r.new_entity,entity_type:r.new_type,entity_key:r.new_key,source_path:r.new_path})})) as GraphMutationWriteSet['owners'];
  const sources=sourceRows.map(r=>({operation:r.op,old:sourceIdentity({project_id:r.old_project,environment:r.old_environment,path:r.old_path}),next:sourceIdentity({project_id:r.new_project,environment:r.new_environment,path:r.new_path})})) as GraphMutationWriteSet['sources'];
  const unique=(values:string[])=>[...new Set(values.filter(Boolean))].sort();
  const nodeIds=unique(nodes.flatMap(r=>[r.old?.id??'',r.next?.id??''])),edgeIds=unique(edges.flatMap(r=>[r.old?.id??'',r.next?.id??'']));
  const endpoints=unique(edges.flatMap(r=>[r.old?.from_node_id??'',r.old?.to_node_id??'',r.next?.from_node_id??'',r.next?.to_node_id??'']));
  const ownerEntityIds=unique(owners.flatMap(r=>[r.old?.entity_id??'',r.next?.entity_id??''])),ownerKeys=unique(owners.flatMap(r=>[r.old?`${r.old.entity_type}:${r.old.entity_key}`:'',r.next?`${r.next.entity_type}:${r.next.entity_key}`:'']));
  const ownerPaths=unique(owners.flatMap(r=>[r.old?.source_path??'',r.next?.source_path??''])),sourcePaths=unique(sources.flatMap(r=>[r.old?.path??'',r.next?.path??'']));
  const sourceScopes=[...new Map(sources.flatMap(row=>[row.old,row.next]).filter((row):row is GraphSourceIdentity=>row!==null).map(row=>[`${row.project_id}\0${row.environment}\0${row.path}`,row])).values()];
  const sourceOwners:Array<GraphOwnerIdentity>=[];
  for(let index=0;index<sourceScopes.length;index+=250){const chunk=sourceScopes.slice(index,index+250);sourceOwners.push(...db.prepare(`SELECT project_id,environment,entity_id,entity_type,entity_key,source_path FROM yaml_ownership WHERE ${chunk.map(()=>'(project_id=? AND environment=? AND source_path=?)').join(' OR ')}`).all(...chunk.flatMap(row=>[row.project_id,row.environment,row.path])) as GraphOwnerIdentity[]);}
  const affectedOwners=[...new Map([...sourceOwners,...owners.flatMap(row=>[row.old,row.next]).filter((row):row is GraphOwnerIdentity=>row!==null)].map(row=>[`${row.project_id}\0${row.environment}\0${row.entity_type}\0${row.entity_key}\0${row.source_path}`,row])).values()];
  const affectedOwnerEntityIds=unique([...ownerEntityIds,...affectedOwners.map(row=>row.entity_id)]);
  const relevant=new Set([...nodeIds,...endpoints,...affectedOwnerEntityIds]);
  const actionRows:Array<{id:string}>=[];
  const relevantIds=[...relevant];
  for(let index=0;index<relevantIds.length;index+=400){const chunk=relevantIds.slice(index,index+400);actionRows.push(...db.prepare(`SELECT DISTINCT n.id FROM nodes n JOIN edges e ON e.project_id=n.project_id AND e.environment=n.environment AND e.to_node_id=n.id AND e.relation_type='TRIGGERED_BY' WHERE n.type='action' AND (e.from_node_id IN (${chunk.map(()=>'?').join(',')}) OR n.id IN (${chunk.map(()=>'?').join(',')}))`).all(...chunk,...chunk) as Array<{id:string}>);}
  const affectedActionNodeIds=unique([...nodeIds.filter(id=>nodes.some(row=>(row.next?.id===id&&row.next.type==='action')||(row.old?.id===id&&row.old.type==='action'))), ...actionRows.map(row=>row.id)]);
  return{nodes,edges,owners,sources,changedNodeIds:nodeIds,changedEdgeIds:edgeIds,changedEdgeEndpoints:endpoints,changedOwnerEntityIds:ownerEntityIds,changedOwnerKeys:ownerKeys,changedOwnerSourcePaths:ownerPaths,changedSourcePaths:sourcePaths,affectedOwners,affectedOwnerEntityIds,affectedActionNodeIds};
}
export function clearGraphMutationCapture(db:Database.Database):void{db.exec('DELETE FROM _umb_graph_nodes; DELETE FROM _umb_graph_edges; DELETE FROM _umb_graph_owners; DELETE FROM _umb_graph_sources;');}
