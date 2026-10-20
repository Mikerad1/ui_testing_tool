import type Database from 'better-sqlite3';

/** Add immutable links from MCP candidate observations to scoped assertion evidence. */
export function migrateEvidenceAssociationsV16(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`CREATE TABLE memory_candidate_evidence_refs(
      project_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      subject_node_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id,environment,observation_id,evidence_id),
      FOREIGN KEY(project_id,environment,observation_id) REFERENCES memory_candidate_observations(project_id,environment,id),
      FOREIGN KEY(evidence_id) REFERENCES evidence(id),
      FOREIGN KEY(project_id,environment,subject_node_id) REFERENCES nodes(project_id,environment,id)
    );
    CREATE INDEX memory_candidate_evidence_refs_observation ON memory_candidate_evidence_refs(project_id,environment,observation_id,evidence_id);
    CREATE TRIGGER memory_candidate_evidence_refs_no_update BEFORE UPDATE ON memory_candidate_evidence_refs BEGIN SELECT RAISE(ABORT,'evidence associations are immutable'); END;
    CREATE TRIGGER memory_candidate_evidence_refs_no_delete BEFORE DELETE ON memory_candidate_evidence_refs BEGIN SELECT RAISE(ABORT,'evidence associations are immutable'); END;`);
    database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(16,?)').run(new Date().toISOString());
  })();
}
