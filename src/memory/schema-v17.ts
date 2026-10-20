import type Database from 'better-sqlite3';

/** Add provenance lookup indexes without rewriting existing memory records. */
export function migrateProvenanceIndexesV17(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`CREATE INDEX memory_audit_verify_subject_latest
      ON memory_audit(project_id,subject_node_id,created_at,id) WHERE action='verify';
      CREATE INDEX evidence_assertion_provenance_lookup
      ON evidence(project_id,subject_node_id,run_id,kind,outcome,created_at,id);
      CREATE INDEX memory_search_edges_from_bounded
      ON edges(project_id,environment,from_node_id,id);
      CREATE INDEX memory_search_edges_to_bounded
      ON edges(project_id,environment,to_node_id,id);`);
    database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(17,?)').run(new Date().toISOString());
  })();
}
