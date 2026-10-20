import Database from 'better-sqlite3';
import { link, lstat, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

function assertHealthy(db: Database.Database): void {
  const quickCheck = db.pragma('quick_check') as Array<{ quick_check: string }>;
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
    throw new Error('SQLite quick_check failed');
  }
  const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[];
  if (foreignKeyErrors.length > 0) throw new Error('SQLite foreign_key_check failed');
}

async function assertNoSidecars(filename: string): Promise<void> {
  for (const suffix of ['-wal', '-shm']) {
    try {
      await lstat(filename + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`SQLite artifact requires a sidecar: ${filename + suffix}`);
  }
}

async function assertDestinationClear(destination: string): Promise<void> {
  for (const filename of [destination, `${destination}-wal`, `${destination}-shm`]) {
    try {
      await lstat(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`SQLite destination already exists: ${filename}`);
  }
}

async function publishNewArtifact(stagedFile: string, destination: string): Promise<void> {
  // link() is exclusive: unlike rename(), it cannot replace a destination that
  // appeared after our initial check.
  await assertDestinationClear(destination);
  await link(stagedFile, destination);
}

async function createValidatedArtifact(
  destinationFilename: string,
  populate: (stagedFilename: string) => Promise<void>,
): Promise<void> {
  const destination = path.resolve(destinationFilename);
  const parent = path.dirname(destination);
  const stageDir = await mkdtemp(path.join(parent, '.sqlite-artifact-'));
  const stagedFile = path.join(stageDir, 'artifact.sqlite');
  let published = false;
  try {
    await populate(stagedFile);
    const validationDb = new Database(stagedFile, { fileMustExist: true });
    try {
      const journalMode = validationDb.pragma('journal_mode = DELETE') as Array<{ journal_mode: string }>;
      if (journalMode[0]?.journal_mode !== 'delete') throw new Error('SQLite artifact could not be made self-contained');
      assertHealthy(validationDb);
    } finally {
      validationDb.close();
    }
    await assertNoSidecars(stagedFile);
    await publishNewArtifact(stagedFile, destination);
    published = true;
  } finally {
    try {
      await rm(stageDir, { recursive: true, force: true });
    } catch (error) {
      // Once the exclusive hardlink succeeds, the artifact is published and
      // must be reported as success even if removing the private staging link fails.
      if (!published) throw error;
    }
  }
}

/** Create a self-contained backup at a new path; existing destinations are never replaced. */
export async function backupSqlite(sourceFilename: string, destinationFilename: string): Promise<void> {
  const destination = path.resolve(destinationFilename);
  await assertDestinationClear(destination);

  const source = new Database(sourceFilename, { readonly: true, fileMustExist: true });
  try {
    await createValidatedArtifact(destination, stagedFilename => source.backup(stagedFilename).then(() => undefined));
  } finally {
    source.close();
  }
}

/** Restore a backup into a new path via SQLite's online backup API (never in place). */
export async function restoreSqlite(backupFilename: string, destinationFilename: string): Promise<void> {
  const destination = path.resolve(destinationFilename);
  await assertDestinationClear(destination);

  const backup = new Database(backupFilename, { readonly: true, fileMustExist: true });
  try {
    assertHealthy(backup);
    // A readonly source database can still be copied by SQLite backup(); the
    // destination is created by the SQLite API in our private staging dir.
    await createValidatedArtifact(destination, stagedFilename => backup.backup(stagedFilename).then(() => undefined));
  } finally {
    backup.close();
  }
}
