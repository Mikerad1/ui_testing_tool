import type Database from 'better-sqlite3';

type CountRow = { count: number };

function count(database: Database.Database, table: string): number {
  if (!['nodes', 'edges', 'yaml_sources', 'yaml_ownership', 'runs'].includes(table)) throw new Error('Invalid migration table');
  return (database.prepare(`SELECT count(*) count FROM ${table}`).get() as CountRow).count;
}

/** Rebuild graph identity tables atomically while retaining every v10 row in legacy scope. */
export function migrateEnvironmentSchema(database: Database.Database): void {
  const counts = Object.fromEntries(['nodes', 'edges', 'yaml_sources', 'yaml_ownership', 'runs'].map(table => [table, count(database, table)]));
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.exec(`
        CREATE TEMP TABLE umb_v10_nodes AS SELECT * FROM nodes;
        CREATE TEMP TABLE umb_v10_edges AS SELECT * FROM edges;
        CREATE TEMP TABLE umb_v10_yaml_sources AS SELECT * FROM yaml_sources;
        CREATE TEMP TABLE umb_v10_yaml_ownership AS SELECT * FROM yaml_ownership;

        DROP TABLE edges;
        DROP TABLE yaml_ownership;
        DROP TABLE yaml_sources;
        DROP TABLE nodes;

        CREATE TABLE nodes(
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL CHECK(length(environment) BETWEEN 1 AND 64),
          type TEXT NOT NULL,
          stable_key TEXT NOT NULL,
          display_name TEXT NOT NULL,
          attributes_json TEXT NOT NULL,
          origin TEXT NOT NULL,
          verification_status TEXT NOT NULL,
          confidence REAL NOT NULL,
          content_hash TEXT,
          tombstone INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT '',
          superseded_by TEXT,
          canonical_key TEXT NOT NULL DEFAULT '',
          conflict_status TEXT NOT NULL DEFAULT 'none',
          conflicting_node_id TEXT,
          UNIQUE(project_id,environment,id),
          UNIQUE(project_id,environment,type,stable_key)
        );
        INSERT INTO nodes(id,project_id,environment,type,stable_key,display_name,attributes_json,origin,verification_status,confidence,content_hash,tombstone,created_at,updated_at,superseded_by,canonical_key,conflict_status,conflicting_node_id)
          SELECT id,project_id,'legacy',type,stable_key,display_name,attributes_json,origin,verification_status,confidence,content_hash,tombstone,created_at,updated_at,superseded_by,canonical_key,conflict_status,conflicting_node_id FROM umb_v10_nodes;
        CREATE UNIQUE INDEX nodes_project_id_id ON nodes(project_id,id);
        CREATE INDEX nodes_environment_canonical ON nodes(project_id,environment,type,canonical_key,tombstone);

        CREATE TABLE edges(
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL CHECK(length(environment) BETWEEN 1 AND 64),
          from_node_id TEXT NOT NULL,
          to_node_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          attributes_json TEXT NOT NULL,
          origin TEXT NOT NULL,
          verification_status TEXT NOT NULL,
          tombstone INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT '',
          conflict_status TEXT NOT NULL DEFAULT 'none',
          conflicting_edge_id TEXT,
          stable_key TEXT NOT NULL,
          UNIQUE(project_id,environment,origin,stable_key),
          FOREIGN KEY(project_id,environment,from_node_id) REFERENCES nodes(project_id,environment,id),
          FOREIGN KEY(project_id,environment,to_node_id) REFERENCES nodes(project_id,environment,id)
        );
        INSERT INTO edges(id,project_id,environment,from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,tombstone,created_at,updated_at,conflict_status,conflicting_edge_id,stable_key)
          SELECT id,project_id,'legacy',from_node_id,to_node_id,relation_type,attributes_json,origin,verification_status,tombstone,created_at,updated_at,conflict_status,conflicting_edge_id,stable_key FROM umb_v10_edges;
        CREATE INDEX edges_from ON edges(project_id,environment,from_node_id);
        CREATE INDEX edges_to ON edges(project_id,environment,to_node_id);

        CREATE TABLE yaml_sources(
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL CHECK(length(environment) BETWEEN 1 AND 64),
          path TEXT NOT NULL,
          hash TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(project_id,environment,path)
        );
        INSERT INTO yaml_sources(project_id,environment,path,hash,imported_at,active)
          SELECT project_id,'legacy',path,hash,imported_at,active FROM umb_v10_yaml_sources;

        CREATE TABLE yaml_ownership(
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL CHECK(length(environment) BETWEEN 1 AND 64),
          source_path TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_key TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          hash TEXT NOT NULL,
          tombstone INTEGER NOT NULL DEFAULT 0,
          conflict_status TEXT NOT NULL DEFAULT 'none',
          conflicting_entity_id TEXT,
          PRIMARY KEY(project_id,environment,source_path,entity_type,entity_key)
        );
        INSERT INTO yaml_ownership(project_id,environment,source_path,entity_type,entity_key,entity_id,hash,tombstone,conflict_status,conflicting_entity_id)
          SELECT project_id,'legacy',source_path,entity_type,entity_key,entity_id,hash,tombstone,conflict_status,conflicting_entity_id FROM umb_v10_yaml_ownership;
        CREATE UNIQUE INDEX yaml_ownership_active_identity ON yaml_ownership(project_id,environment,entity_type,entity_key) WHERE tombstone=0;

        ALTER TABLE runs ADD COLUMN memory_environment TEXT NOT NULL DEFAULT 'legacy' CHECK(length(memory_environment) BETWEEN 1 AND 64);

        DROP TABLE umb_v10_nodes;
        DROP TABLE umb_v10_edges;
        DROP TABLE umb_v10_yaml_sources;
        DROP TABLE umb_v10_yaml_ownership;
      `);

      for (const table of ['nodes', 'edges', 'yaml_sources', 'yaml_ownership', 'runs']) {
        if (count(database, table) !== counts[table]) throw new Error(`Cannot migrate v11: ${table} row count changed`);
      }
      if (database.prepare('PRAGMA quick_check').all().some((row: any) => Object.values(row)[0] !== 'ok')) throw new Error('Cannot migrate v11: SQLite integrity check failed');
      if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Cannot migrate v11: foreign-key validation failed');
      database.prepare('INSERT INTO schema_migrations VALUES(11,?)').run(new Date().toISOString());
    })();
  } finally {
    database.pragma('foreign_keys = ON');
  }
}
