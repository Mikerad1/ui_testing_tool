import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/memory/store.js';
import { backupSqlite, restoreSqlite } from '../src/memory/sqlite-backup.js';

const row = (db: Database.Database, id: number) => db.prepare('SELECT value FROM records WHERE id=?').get(id) as { value: string } | undefined;

test('backup includes committed WAL data and restored artifact is self-contained', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umb-sqlite-backup-'));
  const sourcePath = path.join(dir, 'source.sqlite');
  const backupPath = path.join(dir, 'backup.sqlite');
  const restoredPath = path.join(dir, 'restored.sqlite');
  const writer = new Database(sourcePath);
  const reader = new Database(sourcePath);
  try {
    writer.pragma('journal_mode = WAL');
    writer.pragma('foreign_keys = ON');
    writer.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE references_to_records(record_id INTEGER NOT NULL REFERENCES records(id), note TEXT NOT NULL);');
    writer.prepare('INSERT INTO records VALUES(?,?)').run(1, 'before');
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM records').all();
    writer.transaction(() => {
      writer.prepare('INSERT INTO records VALUES(?,?)').run(2, 'committed-in-wal');
      writer.prepare('INSERT INTO references_to_records VALUES(?,?)').run(2, 'same transaction');
    })();
    const checkpoint = writer.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    assert.equal(checkpoint[0]?.busy, 1, 'reader should prevent checkpointing the committed write');
    assert.equal(row(writer, 2)?.value, 'committed-in-wal');

    await backupSqlite(sourcePath, backupPath);
    await restoreSqlite(backupPath, restoredPath);
    for (const filename of [backupPath, restoredPath]) {
      assert.equal(existsSync(filename + '-wal'), false);
      assert.equal(existsSync(filename + '-shm'), false);
      const db = new Database(filename);
      try {
        assert.equal(row(db, 2)?.value, 'committed-in-wal');
        assert.equal((db.prepare('SELECT note FROM references_to_records WHERE record_id=2').get() as { note: string }).note, 'same transaction');
        assert.deepEqual(db.pragma('quick_check'), [{ quick_check: 'ok' }]);
        assert.deepEqual(db.pragma('foreign_key_check'), []);
      } finally {
        db.close();
      }
    }
  } finally {
    reader.exec('ROLLBACK');
    reader.close();
    writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('backup API observes a write during online backup and preserves transaction invariants', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umb-sqlite-online-backup-'));
  const sourcePath = path.join(dir, 'source.sqlite');
  const backupPath = path.join(dir, 'backup.sqlite');
  const source = new Database(sourcePath);
  try {
    source.pragma('journal_mode = WAL');
    source.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE references_to_records(record_id INTEGER NOT NULL REFERENCES records(id));');
    const insert = source.prepare('INSERT INTO records(value) VALUES(?)');
    source.transaction(() => { for (let i = 0; i < 100_000; i++) insert.run('payload-'.padEnd(120, String(i % 10))); })();
    let writerCommitted = false;
    let backupFinished = false;
    const backup = backupSqlite(sourcePath, backupPath);
    setTimeout(() => {
      assert.equal(backupFinished, false, 'large online copy should still be in progress');
      source.transaction(() => {
        const result = insert.run('concurrent-write');
        source.prepare('INSERT INTO references_to_records VALUES(?)').run(Number(result.lastInsertRowid));
      })();
      writerCommitted = true;
    }, 10);
    await backup;
    backupFinished = true;
    assert.equal(writerCommitted, true, 'the online copy should yield while the concurrent writer commits');
    const copied = new Database(backupPath);
    try {
      const concurrent = copied.prepare("SELECT id FROM records WHERE value='concurrent-write'").get() as { id: number } | undefined;
      if (concurrent) assert.equal(copied.prepare('SELECT record_id FROM references_to_records WHERE record_id=?').get(concurrent.id) !== undefined, true);
      assert.deepEqual(copied.pragma('quick_check'), [{ quick_check: 'ok' }]);
      assert.deepEqual(copied.pragma('foreign_key_check'), []);
    } finally {
      copied.close();
    }
  } finally {
    source.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('restored copy opens through Store and migrates normally', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umb-sqlite-store-restore-'));
  const sourcePath = path.join(dir, 'source.sqlite');
  const backupPath = path.join(dir, 'backup.sqlite');
  const restoredPath = path.join(dir, 'restored.sqlite');
  let store: Store | undefined;
  let fixtureDb: Database.Database | undefined;
  let restoredStore: Store | undefined;
  try {
    store = new Store(sourcePath, 'backup-project');
    fixtureDb = new Database(sourcePath);
    fixtureDb.prepare("INSERT INTO nodes(id,project_id,environment,type,stable_key,canonical_key,display_name,attributes_json,origin,verification_status,confidence) VALUES('preserved','backup-project','legacy','screen','preserved','preserved','Preserved','{}','human','verified',1)").run();
    fixtureDb.close();
    fixtureDb = undefined;
    await backupSqlite(sourcePath, backupPath);
    await restoreSqlite(backupPath, restoredPath);
    restoredStore = new Store(restoredPath, 'backup-project');
    assert.equal((restoredStore.get('preserved') as { display_name: string }).display_name, 'Preserved');
    assert.equal((restoredStore.db.prepare('SELECT max(version) version FROM schema_migrations').get() as { version: number }).version, 11);
    assert.deepEqual(restoredStore.db.pragma('foreign_key_check'), []);
  } finally {
    fixtureDb?.close();
    restoredStore?.close();
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('existing destinations and malformed inputs are rejected without cleanup damage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umb-sqlite-failures-'));
  const sourcePath = path.join(dir, 'source.sqlite');
  const existingPath = path.join(dir, 'existing.sqlite');
  const malformedPath = path.join(dir, 'malformed.sqlite');
  const failedOutput = path.join(dir, 'failed-output.sqlite');
  const source = new Database(sourcePath);
  try {
    source.exec('CREATE TABLE records(id INTEGER PRIMARY KEY); INSERT INTO records VALUES(1);');
    source.close();
    await writeFile(existingPath, 'keep me');
    await writeFile(malformedPath, 'not a sqlite database');
    await assert.rejects(backupSqlite(sourcePath, existingPath), /already exists/);
    await assert.rejects(restoreSqlite(malformedPath, existingPath), /already exists/);
    await assert.rejects(restoreSqlite(malformedPath, failedOutput));
    assert.equal(await readFile(existingPath, 'utf8'), 'keep me');
    assert.equal(existsSync(failedOutput), false);
    assert.equal((await readdir(dir)).some(name => name.startsWith('.sqlite-artifact-')), false);
  } finally {
    if (source.open) source.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('destination WAL/SHM sidecars prevent publication and remain untouched', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umb-sqlite-sidecars-'));
  const sourcePath = path.join(dir, 'source.sqlite');
  const source = new Database(sourcePath);
  try {
    source.exec('CREATE TABLE records(id INTEGER PRIMARY KEY); INSERT INTO records VALUES(1);');
    source.close();
    for (const suffix of ['-wal', '-shm']) {
      const destination = path.join(dir, `output-${suffix.slice(1)}.sqlite`);
      const sidecar = destination + suffix;
      const contents = `pre-existing ${suffix} data`;
      await writeFile(sidecar, contents);
      await assert.rejects(backupSqlite(sourcePath, destination), /destination already exists/);
      assert.equal(existsSync(destination), false);
      assert.equal(await readFile(sidecar, 'utf8'), contents);
    }
  } finally {
    if (source.open) source.close();
    await rm(dir, { recursive: true, force: true });
  }
});
