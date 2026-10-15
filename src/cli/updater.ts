import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const REPOSITORY = 'Mikerad1/ui_testing_tool';
const API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const ALLOWLIST = ['runtime', 'dist', 'node_modules', 'umb', 'umb.cmd', 'package.json', 'package-lock.json', 'UMB-BUNDLE.json'];
const WINDOWS_ARCHIVE_ROOTS = [...ALLOWLIST, 'LICENSE', 'README.md'];
type Release = { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };

function bundledRoot(): string { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../'); }
function version(value: string): number[] | undefined {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? 0 : 1] : undefined;
}
function compare(a: string, b: string): number {
  const av = version(a), bv = version(b);
  if (!av || !bv) throw new Error('The installed or latest version is not a supported stable semantic version.');
  for (let i = 0; i < 4; i++) if (av[i] !== bv[i]) return av[i]! - bv[i]!;
  return 0;
}
async function officialBundle(root: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'UMB-BUNDLE.json'), 'utf8'));
    if (manifest.format !== 1 || manifest.repository !== REPOSITORY) return false;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  try {
    const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    await Promise.all(['runtime', 'dist/src/cli/index.js', 'node_modules/better-sqlite3/package.json'].map(p => access(path.join(root, p))));
    const launcher = process.platform === 'win32' ? 'umb.cmd' : 'umb'; await access(path.join(root, launcher));
    return metadata.name === 'ui-memory-browser';
  } catch { return false; }
}
async function fetchLatest(fetcher: typeof fetch): Promise<{ tag: string; assets: any[] }> {
  const response = await fetcher(API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ui-memory-browser-updater' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`GitHub release lookup failed (HTTP ${response.status}).`);
  const release = await response.json() as Release;
  if (release.draft || release.prerelease || typeof release.tag_name !== 'string' || !/^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(release.tag_name) || !Array.isArray(release.assets)) throw new Error('GitHub returned malformed or non-stable release metadata.');
  return { tag: release.tag_name, assets: release.assets };
}
async function download(fetcher: typeof fetch, url: string, limit: number): Promise<Buffer> {
  const response = await fetcher(url, { headers: { 'user-agent': 'ui-memory-browser-updater' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Release asset download failed (HTTP ${response.status}).`);
  const data = Buffer.from(await response.arrayBuffer()); if (!data.length || data.length > limit) throw new Error('Release asset has an invalid size.'); return data;
}
function command(cmd: string, args: string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Could not safely inspect/extract release archive (${result.error?.message ?? result.stderr ?? cmd}).`);
  return result.stdout;
}
export function validateArchivePaths(listing: string, expectedTop: string, flatEntries: readonly string[] = []): 'nested' | 'flat' {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.length > 100000) throw new Error('Release archive has an invalid file list.');
  let nested = false, flat = false;
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/').replace(/\/$/, '');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('Release archive contains an unsafe path.');
    const [top] = normalized.split('/');
    if (top === expectedTop) nested = true;
    else if (flatEntries.includes(top!)) flat = true;
    else throw new Error('Release archive layout is not recognized.');
    if (top === expectedTop && flat) throw new Error('Release archive layout is not recognized.');
    if (top !== expectedTop && nested) throw new Error('Release archive layout is not recognized.');
  }
  if (nested && flat) throw new Error('Release archive layout is not recognized.');
  return flat ? 'flat' : 'nested';
}

export function validateTarTypes(details: string): void {
  if (details.split(/\r?\n/).some(line => line && !/^[d-]/.test(line))) throw new Error('Release archive contains a non-regular or unsafe entry.');
}

export function updateCheckEnabled(noUpdateCheck: boolean, envValue = process.env.UMB_NO_UPDATE_CHECK): boolean {
  return !noUpdateCheck && envValue !== '1';
}

export async function rollbackPayload(root: string, backup: string, installedNow: string[], moved: string[]): Promise<void> {
  const failures: string[] = [];
  for (const name of [...installedNow].reverse()) {
    try { await rm(path.join(root, name), { recursive: true, force: true }); }
    catch (error) { failures.push(`remove ${name}: ${(error as Error).message}`); }
  }
  for (const name of [...moved].reverse()) {
    try { await rename(path.join(backup, name), path.join(root, name)); }
    catch (error) { failures.push(`restore ${name}: ${(error as Error).message}`); }
  }
  if (failures.length) throw new Error(failures.join('; '));
}

export async function checkForUpdate(fetcher: typeof fetch = fetch, root = bundledRoot()): Promise<string | undefined> {
  if (!await officialBundle(root)) return;
  const { tag } = await fetchLatest(fetcher);
  const installed = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version as string;
  return compare(tag, installed) > 0 ? tag : undefined;
}

export async function updateBundle(fetcher: typeof fetch = fetch, root = bundledRoot()): Promise<string> {
  if (!await officialBundle(root)) throw new Error('Self-update is available only in an official prebuilt UMB bundle; source and npm installs are unchanged.');
  if (process.platform !== 'linux' && process.platform !== 'win32') throw new Error('Self-update supports only official Linux x64 and Windows x64 bundles.');
  if (process.arch !== 'x64') throw new Error('Self-update supports x64 bundles only.');
  const installed = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version as string;
  const latest = await fetchLatest(fetcher);
  const ordering = compare(latest.tag, installed);
  if (ordering === 0) return `Already up to date (${installed}).`;
  if (ordering < 0) throw new Error(`Refusing downgrade from ${installed} to ${latest.tag}.`);
  const basename = process.platform === 'win32' ? 'umb-windows-x64.zip' : 'umb-linux-x64.tar.gz';
  const assets = latest.assets as any[];
  const asset = assets.find(a => a?.name === basename), checksum = assets.find(a => a?.name === `${basename}.sha256`);
  if (!asset || !checksum || typeof asset.browser_download_url !== 'string' || typeof checksum.browser_download_url !== 'string') throw new Error(`Latest release is missing ${basename} or its SHA-256 sidecar.`);
  const [archive, sidecar] = await Promise.all([download(fetcher, asset.browser_download_url, 2_000_000_000), download(fetcher, checksum.browser_download_url, 4096)]);
  const match = /^([a-fA-F0-9]{64})\s+\*?umb-(?:windows-x64\.zip|linux-x64\.tar\.gz)\s*$/.exec(sidecar.toString('utf8').trim());
  if (!match || createHash('sha256').update(archive).digest('hex') !== match[1]!.toLowerCase()) throw new Error('Release SHA-256 verification failed; no files were changed.');
  const temp = await mkdtemp(path.join(path.dirname(root), '.umb-update-'));
  let deferredWindowsInstall = false;
  let preserveRecovery = false;
  try {
    const archivePath = path.join(temp, basename), extracted = path.join(temp, 'extract'); await writeFile(archivePath, archive); await mkdir(extracted);
    const top = process.platform === 'win32' ? 'umb-windows-x64' : 'umb-linux-x64';
    let archiveLayout: 'nested' | 'flat' = 'nested';
    if (process.platform === 'win32') {
      const listing = command('tar', ['-tf', archivePath], temp);
      archiveLayout = validateArchivePaths(listing, top, WINDOWS_ARCHIVE_ROOTS);
      const details = command('tar', ['-tvf', archivePath], temp);
      validateTarTypes(details);
      command('tar', ['-xf', archivePath, '-C', extracted, '--no-same-owner'], temp);
    } else {
      const listing = command('tar', ['-tzf', archivePath], temp); validateArchivePaths(listing, top);
      const details = command('tar', ['-tvzf', archivePath], temp);
      validateTarTypes(details);
      command('tar', ['-xzf', archivePath, '-C', extracted, '--no-same-owner'], temp);
    }
    const staged = path.join(extracted, process.platform === 'win32' && archiveLayout === 'flat' ? '' : top);
    if (!(await officialBundle(staged))) throw new Error('Downloaded archive does not contain a valid UMB bundle.');
    const stagedVersion = JSON.parse(await readFile(path.join(staged, 'package.json'), 'utf8')).version;
    if (stagedVersion !== latest.tag.replace(/^v/, '')) throw new Error('Archive version does not match the release tag.');
    if (process.platform === 'win32') {
      const script = path.join(temp, 'finish-update.ps1');
      const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
      const names = ALLOWLIST.map(quote).join(',');
      const failureLog = path.join(path.dirname(root), 'umb-update-failure.log');
      await writeFile(script, `$ErrorActionPreference = 'Stop'\n$root = ${quote(root)}\n$stage = ${quote(staged)}\n$backup = ${quote(path.join(temp, 'backup'))}\n$failure = ${quote(failureLog)}\n$names = @(${names})\n$moved = @()\n$installed = @()\nNew-Item -ItemType Directory -Force -Path $backup | Out-Null\ntry {\n  $p = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue\n  if ($p) { $p.WaitForExit() }\n  foreach ($n in $names) { if (Test-Path -LiteralPath (Join-Path $root $n)) { Move-Item -LiteralPath (Join-Path $root $n) -Destination (Join-Path $backup $n); $moved += $n } }\n  foreach ($n in $names) { if (Test-Path -LiteralPath (Join-Path $stage $n)) { Copy-Item -LiteralPath (Join-Path $stage $n) -Destination (Join-Path $root $n) -Recurse; $installed += $n } }\n  Remove-Item -LiteralPath $failure -Force -ErrorAction SilentlyContinue\n  Remove-Item -LiteralPath ${quote(temp)} -Recurse -Force\n} catch {\n  foreach ($n in $installed) { Remove-Item -LiteralPath (Join-Path $root $n) -Recurse -Force -ErrorAction SilentlyContinue }\n  foreach ($n in $moved) { $old = Join-Path $backup $n; if (Test-Path -LiteralPath $old) { Move-Item -LiteralPath $old -Destination (Join-Path $root $n) } }\n  Set-Content -LiteralPath $failure -Value ('UMB update failed; rollback attempted. Details: ' + $_.Exception.Message)\n}\n`);
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { detached: true, stdio: 'ignore', windowsHide: true });
      if (!child.pid) throw new Error('Could not start the deferred Windows update helper.');
      child.unref();
      deferredWindowsInstall = true;
      // Keep the verified stage alive for the helper, which waits for this process to exit.
      return `Downloaded and verified UMB ${latest.tag}; Windows will replace the bundle after this process exits.`;
    }
    const backup = path.join(temp, 'backup'); await mkdir(backup);
    const moved: string[] = [], installedNow: string[] = [];
    try {
      for (const name of ALLOWLIST) {
        try { await stat(path.join(root, name)); await rename(path.join(root, name), path.join(backup, name)); moved.push(name); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        try { await access(path.join(staged, name)); await cp(path.join(staged, name), path.join(root, name), { recursive: true, force: false }); installedNow.push(name); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
    } catch (error) {
      try {
        await rollbackPayload(root, backup, installedNow, moved);
      } catch (rollbackError) {
        preserveRecovery = true;
        throw new Error(`Update failed: ${(error as Error).message}. Rollback was incomplete: ${(rollbackError as Error).message}. Recovery data preserved at ${temp}`);
      }
      throw new Error(`Update failed and rollback completed: ${(error as Error).message}`);
    }
    return `Updated UMB from ${installed} to ${stagedVersion}.`;
  } finally { if (!deferredWindowsInstall && !preserveRecovery) await rm(temp, { recursive: true, force: true }); }
}
