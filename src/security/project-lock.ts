import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

type Owner = { token: string; pid: number; host: string; acquiredAt: string };
export type ProjectLock = { release(): Promise<void> };
/** Per-call fault injection seam for lifecycle tests; omit in production. */
export type ProjectLockTestHooks = { afterMainLockCreate?: (file: string) => void | Promise<void> };
type OwnedFile = { file: string; token: string; dev?: number; ino?: number; metadataWritten?: boolean };

function key(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Acquire locks for the project and its database target. Lock files are exclusive-created. */
export async function acquireProjectLock(root: string, projectId: string, database: string, testHooks?: ProjectLockTestHooks): Promise<ProjectLock> {
  const canonicalRoot = await realpath(root);
  const requestedDb = path.resolve(canonicalRoot, database);
  const rel = path.relative(canonicalRoot, requestedDb);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Database path escapes project root: ${database}`);
  let probe = requestedDb;
  while (true) {
    try {
      const resolved = await realpath(probe);
      const remainder = path.relative(probe, requestedDb);
      const canonicalDb = path.resolve(resolved, remainder);
      const contained = path.relative(canonicalRoot, canonicalDb);
      if (contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) throw new Error(`Database symlink escapes project root: ${database}`);
      const projectDirectory = path.join(canonicalRoot, '.umb', 'locks');
      await mkdir(projectDirectory, { recursive: true });
      const canonicalLocks = await realpath(projectDirectory);
      const lockRel = path.relative(canonicalRoot, canonicalLocks);
      if (lockRel === '..' || lockRel.startsWith(`..${path.sep}`) || path.isAbsolute(lockRel)) throw new Error('Project lock directory escapes project root through a symlink.');
      await mkdir(path.dirname(canonicalDb), { recursive: true });
      const canonicalParent = await realpath(path.dirname(canonicalDb));
      const parentRel = path.relative(canonicalRoot, canonicalParent);
      if (parentRel === '..' || parentRel.startsWith(`..${path.sep}`) || path.isAbsolute(parentRel)) throw new Error(`Database parent escapes project root: ${database}`);
      const finalDb = path.join(canonicalParent, path.basename(canonicalDb));
      const databaseLock = path.join(canonicalParent, `.${path.basename(finalDb)}.umb-lock`);
      const projectLock = path.join(canonicalLocks, `${key(`project:${canonicalRoot}:${projectId}`)}.lock`);
      return await acquireFiles([projectLock, databaseLock], testHooks);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
}

async function acquireFiles(paths: string[], testHooks?: ProjectLockTestHooks): Promise<ProjectLock> {
  paths = [...new Set(paths)].sort();
  const owner: Owner = { token: randomUUID(), pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() };
  const created: OwnedFile[] = [];
  try {
    for (const file of paths) await acquireOne(file, owner, created, testHooks);
  } catch (error) {
    for (const item of created.reverse()) await removeOwned(item).catch(() => undefined);
    throw error;
  }
  let released = false;
  return { async release() { if (released) return; released = true; for (const item of created.reverse()) await removeOwned(item); } };
}

async function acquireOne(file: string, owner: Owner, created: OwnedFile[], testHooks?: ProjectLockTestHooks): Promise<void> {
  const gate = `${file}.gate`;
  let gateOwned = false;
  let mainOwned: OwnedFile | undefined;
  try {
    let gateHandle;
    try { gateHandle = await open(gate, 'wx', 0o600); gateOwned = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const gateOwner = await readOwner(gate, 'Lock acquisition gate');
      if (gateOwner.host !== owner.host) throw new Error(`Lock gate ${gate} is owned on remote host ${gateOwner.host}; manual recovery is required.`);
      if (!processIsAlive(gateOwner.pid)) throw new Error(`Lock gate ${gate} belongs to dead PID ${gateOwner.pid}; a crash during the short gate critical section may require manual gate cleanup after verifying no UMB process is active.`);
      throw new Error(`Lock gate ${gate} is busy (PID ${gateOwner.pid}); refusing concurrent recovery. A crash during the short gate critical section may require manual gate cleanup after verifying no UMB process is active.`);
    }
    try { await gateHandle.writeFile(JSON.stringify(owner)); await gateHandle.sync(); }
    catch (error) { await gateHandle.close().catch(() => undefined); await unlink(gate).catch(() => undefined); gateOwned = false; throw error; }
    await gateHandle.close();

    try {
      for (;;) {
        try {
          const handle = await open(file, 'wx', 0o600);
          // Record exclusive ownership synchronously, before any write/stat/close await can fail.
          const owned: OwnedFile = { file, token: owner.token };
          mainOwned = owned;
          created.push(owned);
          try {
            const stat = await handle.stat(); owned.dev = stat.dev; owned.ino = stat.ino;
            await handle.writeFile(JSON.stringify(owner));
            owned.metadataWritten = true;
            await handle.sync();
          } finally { await handle.close(); }
          if (testHooks?.afterMainLockCreate) await testHooks.afterMainLockCreate(file);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const existing = await readOwner(file, 'Project lock');
          if (existing.host !== owner.host) throw new Error(`Project lock is owned on host ${existing.host}; refusing unsafe recovery.`);
          if (processIsAlive(existing.pid)) throw new Error(`Project is already locked by PID ${existing.pid} on ${existing.host}; stop that process or verify it before removing ${file}.`);
          // Verify the exact dead owner while serialized, immediately before atomic quarantine.
          const verified = await readOwner(file, 'Project lock');
          if (verified.token !== existing.token) continue;
          if (verified.host !== owner.host || processIsAlive(verified.pid)) throw new Error(`Project lock ${file} changed owner during stale recovery; refusing unsafe recovery.`);
          const quarantine = `${file}.stale-${randomUUID()}`;
          await rename(file, quarantine);
          const quarantined = await readOwner(quarantine, 'Quarantined project lock');
          if (quarantined.token !== existing.token) {
            await rename(quarantine, file).catch(() => undefined);
            throw new Error(`Project lock ${file} changed during stale recovery; refusing unsafe recovery.`);
          }
          await rm(quarantine, { force: true });
        }
      }
    } finally {
      if (gateOwned) await removeOwned({ file: gate, token: owner.token });
    }
  } catch (error) {
    if (mainOwned && gateOwned) await removeOwned(mainOwned).catch(() => undefined);
    if (gateOwned) await removeOwned({ file: gate, token: owner.token }).catch(() => undefined);
    throw error;
  }
}

async function readOwner(file: string, label: string): Promise<Owner> {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Not a regular file');
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('Not an object');
    const owner = parsed as Owner;
    if (typeof owner.token !== 'string' || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.host !== 'string' || typeof owner.acquiredAt !== 'string') throw new Error('Invalid fields');
    return owner;
  } catch {
    throw new Error(`${label} ${file} has malformed or unsafe owner metadata; remove it manually only after verifying no UMB process is running. Stale/dead gates require manual recovery.`);
  }
}

async function removeOwned(owned: OwnedFile): Promise<void> {
  try {
    const stat = await lstat(owned.file);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    try {
      const data = JSON.parse(await readFile(owned.file, 'utf8')) as Owner;
      if (data.token !== owned.token) return;
    } catch (error) {
      // Before complete metadata write, the exclusive-create identity is the ownership proof.
      if (owned.metadataWritten || owned.dev === undefined || owned.ino === undefined || stat.dev !== owned.dev || stat.ino !== owned.ino || (error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    }
    await rm(owned.file, { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
