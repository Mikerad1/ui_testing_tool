import type Database from 'better-sqlite3';

/** Add the append-only candidate evidence ledger. Kept separate so the Store's
 * migration runner can apply it atomically and record migration history. */
export function migrateCandidateObservations(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE memory_candidate_observations(
        id TEXT PRIMARY KEY CHECK(length(id)=64),
        project_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('mcp_node','mcp_edge','yaml_document','backfill_node','backfill_edge')),
        source_key TEXT NOT NULL CHECK(length(source_key) BETWEEN 1 AND 1024),
        source_revision_hash TEXT NOT NULL CHECK(length(source_revision_hash)=64),
        pipeline_fingerprint TEXT NOT NULL CHECK(length(pipeline_fingerprint)=64),
        nlp_protocol_version INTEGER NOT NULL CHECK(nlp_protocol_version BETWEEN 1 AND 100),
        python_version TEXT NOT NULL CHECK(length(python_version)<=100),
        spacy_version TEXT NOT NULL CHECK(length(spacy_version)<=100),
        model_name TEXT NOT NULL CHECK(length(model_name)<=200),
        model_version TEXT NOT NULL CHECK(length(model_version)<=100),
        rules_version TEXT NOT NULL CHECK(length(rules_version)<=200),
        patterns_schema_version INTEGER NOT NULL CHECK(patterns_schema_version BETWEEN 0 AND 100),
        patterns_digest TEXT NOT NULL CHECK(length(patterns_digest)=64),
        redaction_policy_fingerprint TEXT NOT NULL CHECK(length(redaction_policy_fingerprint)=64),
        extraction_ready INTEGER NOT NULL CHECK(extraction_ready IN (0,1)),
        redacted_source_text TEXT CHECK(redacted_source_text IS NULL OR length(redacted_source_text)<=65536),
        entities_json TEXT NOT NULL CHECK(length(entities_json)<=262144),
        relations_json TEXT NOT NULL CHECK(length(relations_json)<=262144),
        links_json TEXT NOT NULL CHECK(length(links_json)<=65536),
        status TEXT NOT NULL CHECK(status IN ('proposed','conflict','stale','superseded','rejected')),
        supersedes_observation_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id,environment,source_kind,source_key,source_revision_hash,pipeline_fingerprint),
        UNIQUE(project_id,environment,id),
        FOREIGN KEY(project_id,environment,supersedes_observation_id)
          REFERENCES memory_candidate_observations(project_id,environment,id)
      );
      CREATE INDEX memory_candidate_observations_source
        ON memory_candidate_observations(project_id,environment,source_kind,source_key,created_at);
      CREATE TRIGGER memory_candidate_observations_no_update
        BEFORE UPDATE ON memory_candidate_observations
        BEGIN SELECT RAISE(ABORT,'candidate observations are immutable'); END;
      CREATE TRIGGER memory_candidate_observations_no_delete
        BEFORE DELETE ON memory_candidate_observations
        BEGIN SELECT RAISE(ABORT,'candidate observations are immutable'); END;
    `);
    database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(13,?)').run(new Date().toISOString());
  })();
}
