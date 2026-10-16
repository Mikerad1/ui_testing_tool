import { createHash, randomUUID } from 'node:crypto';
import { access, cp, link, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPOSITORY = 'Mikerad1/ui_testing_tool';
const API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
type Release = { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };

function bundledRoot(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, dir.replaceAll('\\', '/').includes('/dist/src/cli') ? '../../../../' : '../..');
}
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
function launcherMatchesBundle(root: string, launcherRoot: string | undefined): boolean {
  if (!launcherRoot?.trim()) return false;
  const bundlePath = path.normalize(path.resolve(root));
  const launcherPath = path.normalize(path.resolve(launcherRoot));
  return process.platform === 'win32'
    ? bundlePath.toLowerCase() === launcherPath.toLowerCase()
    : bundlePath === launcherPath;
}
async function officialBundle(root: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'UMB-BUNDLE.json'), 'utf8'));
    if (manifest.format !== 2 || manifest.repository !== REPOSITORY || manifest.payload !== 'payload') return false;
  } catch { return false; }
  try {
    const metadata = JSON.parse(await readFile(path.join(root, 'payload/package.json'), 'utf8'));
    await Promise.all(['payload/runtime', 'payload/dist/src/cli/index.js', 'payload/node_modules/better-sqlite3/package.json', 'umb-update-helper.sh', 'umb-update-helper.ps1'].map(p => access(path.join(root, p))));
    const launcher = process.platform === 'win32' ? 'umb.cmd' : 'umb'; await access(path.join(root, launcher));
    return metadata.name === 'ui-memory-browser';
  } catch { return false; }
}
async function assertUpdateBundle(root: string): Promise<void> {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'UMB-BUNDLE.json'), 'utf8'));
    if (manifest.format === 1) throw new Error('This flat 0.2.6 bundle cannot self-update to the payload layout. Download and extract the latest release once; preserve project files outside the app bundle.');
  } catch (error) { if (error instanceof Error && error.message.includes('flat 0.2.6')) throw error; }
  if (!await officialBundle(root)) throw new Error('Self-update requires a current official payload-layout bundle; source and npm installs are unchanged.');
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
export function linuxUpdateLockAvailable(): boolean {
  if (process.platform !== 'linux') return true;
  const result = spawnSync('flock', ['--version'], { encoding: 'utf8', windowsHide: true });
  return !result.error && result.status === 0;
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

export async function publishUpdateRequest(root: string, stage: string, version: string): Promise<void> {
  const requestPath = path.join(root, '.umb-update-request.json');
  const requestTemp = path.join(root, `.umb-update-request.tmp-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  try {
    handle = await open(requestTemp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ format: 1, stage, version }) + '\n');
    await handle.sync();
    await handle.close(); handle = undefined;
    // Same-filesystem hard-link publication is atomic and fails if another request already exists.
    await link(requestTemp, requestPath);
    published = true;
  } catch (error) {
    throw new Error(`Could not publish exclusive update request${(error as NodeJS.ErrnoException).code === 'EEXIST' ? '; another update is pending and was not overwritten' : ''}: ${(error as Error).message}`);
  } finally {
    try { await handle?.close(); }
    finally {
      try { await rm(requestTemp, { force: true }); }
      catch (error) { if (!published) throw error; }
    }
  }
}

export async function checkForUpdate(fetcher: typeof fetch = fetch, root = bundledRoot()): Promise<string | undefined> {
  if (!await officialBundle(root)) return;
  const { tag } = await fetchLatest(fetcher);
  const installed = JSON.parse(await readFile(path.join(root, 'payload/package.json'), 'utf8')).version as string;
  return compare(tag, installed) > 0 ? tag : undefined;
}

export async function updateBundle(fetcher: typeof fetch = fetch, root = bundledRoot(), launcherRoot = process.env.UMB_INSTALL_ROOT, lockAvailable: () => boolean = linuxUpdateLockAvailable): Promise<string> {
  await assertUpdateBundle(root);
  if (!launcherMatchesBundle(root, launcherRoot)) throw new Error('Self-update must be run through the stable bundle launcher (umb.cmd on Windows or ./umb on Linux); direct Node/CLI invocation cannot apply the staged update.');
  if (process.platform !== 'linux' && process.platform !== 'win32') throw new Error('Self-update supports only official Linux x64 and Windows x64 bundles.');
  if (process.arch !== 'x64') throw new Error('Self-update supports x64 bundles only.');
  if (process.platform === 'linux' && !lockAvailable()) throw new Error('Linux self-update requires the flock utility (util-linux); install it before updating. No request was published.');
  const installed = JSON.parse(await readFile(path.join(root, 'payload/package.json'), 'utf8')).version as string;
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
  const temp = await mkdtemp(path.join(root, '.umb-update-work-'));
  let pending = false;
  let stage: string | undefined;
  try {
    const archivePath = path.join(temp, basename), extracted = path.join(temp, 'extract'); await writeFile(archivePath, archive); await mkdir(extracted);
    const top = process.platform === 'win32' ? 'umb-windows-x64' : 'umb-linux-x64';
    if (process.platform === 'win32') {
      validateArchivePaths(command('tar', ['-tf', archivePath], temp), top);
      const details = command('tar', ['-tvf', archivePath], temp);
      validateTarTypes(details);
      command('tar', ['-xf', archivePath, '-C', extracted, '--no-same-owner'], temp);
    } else {
      const listing = command('tar', ['-tzf', archivePath], temp); validateArchivePaths(listing, top);
      const details = command('tar', ['-tvzf', archivePath], temp);
      validateTarTypes(details);
      command('tar', ['-xzf', archivePath, '-C', extracted, '--no-same-owner'], temp);
    }
    const bundle = path.join(extracted, top);
    if (!(await officialBundle(bundle))) throw new Error('Downloaded archive does not contain a valid UMB bundle.');
    const stagedVersion = JSON.parse(await readFile(path.join(bundle, 'payload/package.json'), 'utf8')).version;
    if (stagedVersion !== latest.tag.replace(/^v/, '')) throw new Error('Archive version does not match the release tag.');
    stage = await mkdtemp(path.join(root, '.umb-update-stage-'));
    await rm(stage, { recursive: true, force: true });
    await cp(path.join(bundle, 'payload'), stage, { recursive: true, dereference: true, errorOnExist: true });
    await publishUpdateRequest(root, stage, stagedVersion);
    pending = true;
    return `Downloaded and verified UMB ${latest.tag}; update staged. The launcher will apply it after this command exits.`;
  } finally {
    try { await rm(temp, { recursive: true, force: true }); }
    catch (error) { if (!pending) throw error; }
    if (!pending && stage) await rm(stage, { recursive: true, force: true });
  }
}
