import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRgbaPng } from '../png-fixture.js';
import { DesktopService, type DesktopCapture, type DesktopCandidateSummary, type DesktopConfig, type DesktopTreeNode } from '../../src/desktop/index.js';
import type { Config } from '../../src/config/config.js';
import { Store } from '../../src/memory/store.js';
import { serve } from '../../src/mcp/server.js';
import { testLearningWriter } from '../helpers/learning.js';

const root = path.resolve(process.argv[2]!);
const fixtureMode = process.argv[3];
const png = createRgbaPng();
const config = {
  project: { id: 'desktop-image', name: 'desktop-image', base_url: 'http://127.0.0.1:3000' },
  server: { host: '127.0.0.1', port: 7317, auth: { mode: 'token', token_env: 'UMB_MCP_TOKEN' } },
  desktop: { enabled: true, framework: 'tauri', root: '.', automation: { provider: 'tauri-driver', ready_timeout_seconds: 1 }, window: { title: 'Fixture Window', screenshot_mode: 'window' }, visual: { return_mcp_images: true, ...(fixtureMode === 'mask-policy' ? { mask_selectors: ['.private'] } : {}), ...(['retention','retention-query-failure'].includes(fixtureMode ?? '') ? { retain_artifacts_max_age_days: 1 } : {}), ...(['assert-capture','assert-capture-failure','assert-rollback-failure','assert-service-cleanup-failure','assert-partial-cleanup-failure'].includes(fixtureMode ?? '') ? { capture_on_failure: true } : {}) }, ...(fixtureMode === 'unhandled-rejections' ? { diagnostics: { unhandled_rejections: true, capacity: 2 } } : {}) },
  artifacts: { directory: './.umb/artifacts', redact_sensitive: true, max_file_bytes: 100000, max_total_bytes: 1000000, max_count: 10, max_age_days: 30 },
  memory: { database: './memory.sqlite', environment: 'local', persistent_learning_writes: fixtureMode === 'memory-learning', trust_yaml_seeds: false, sensitive_paths: [], sensitive_values_env: fixtureMode === 'memory-learning' ? ['DESKTOP_MEMORY_SECRET'] : [] },
  knowledge: { path: root },
} as unknown as Config;

class FakeDesktopService extends DesktopService {
  private readonly fixtureDiagnostics: { unhandledRejections?: boolean; capacity?: number };
  constructor(settings: DesktopConfig) { super(settings); this.fixtureDiagnostics = (settings as DesktopConfig & { diagnostics?: { unhandledRejections?: boolean; capacity?: number } }).diagnostics; }
  private captureIndex = 0;
  private windowSize?: { width: number; height: number };
  async unhandledRejections(after = 0, limit = 100) {
    if (fixtureMode === 'unhandled-rejections') return {
      events: after < 1 && limit > 0 ? [{ cursor: 1, kind: 'unhandled_rejection' as const, at: 1761000000000 }] : [],
      next_cursor: 1,
      oldest_cursor: 1,
      fixture_diagnostics: { unhandledRejections: this.fixtureDiagnostics?.unhandledRejections, capacity: this.fixtureDiagnostics?.capacity },
      received: { after, limit },
    };
    throw Error('Unhandled rejection diagnostics are disabled in this fixture.');
  }
  override async withWindowSize<T>(width: number, height: number, callback: () => Promise<T>): Promise<T> {
    this.windowSize = { width, height };
    try {
      const result = await callback();
      if (['restore-failure', 'rollback-restore'].includes(fixtureMode ?? '')) throw Error('Fixture window rect restoration failed.');
      return result;
    } finally { this.windowSize = undefined; }
  }
  override async status() {
    if (['fail-status', 'rollback-status', 'assert-rollback-failure'].includes(fixtureMode ?? '') && this.captureIndex > 0) throw Error('Fixture status failure after capture.');
    return { id: 'webdriver-session', state: 'running' as const, endpoint: 'http://127.0.0.1:4444', startedAt: '2026-10-22T00:00:00.000Z' };
  }
  override async tree(): Promise<DesktopTreeNode[]> { return [{ role: 'button', accessibleName: 'Save', text: 'Save', enabled: true, visible: true, rect: { x: 10, y: 10, width: 80, height: 30 } }]; }
  override async find(selector: string, limit = 50): Promise<DesktopCandidateSummary[]> {
    if (selector === ':invalid') throw Error('Invalid selector.');
    if (selector === '#missing') return [];
    if (selector === '.multiple') return [{ index: 0, role: 'button', accessibleName: 'Save', text: 'Fixture text', enabled: true, visible: true, rect: { x: 10, y: 10, width: 80, height: 30 } }, { index: 1, role: 'button', accessibleName: 'Cancel', text: 'Fixture text', enabled: true, visible: false, rect: { x: 100, y: 10, width: 80, height: 30 } }].slice(0, limit);
    return [{ index: 0, role: 'button', accessibleName: 'Save', text: 'Fixture text', enabled: selector !== '#disabled', visible: selector !== '#hidden', rect: { x: 10, y: 10, width: 80, height: 30 } }].slice(0, limit);
  }
  override async text(selector: string): Promise<string> {
    if (selector === ':invalid') throw Error('Invalid selector.');
    if (selector === '#missing') throw Error('Selector must match exactly one element (matches: 0).');
    return 'Fixture text';
  }
  override async readArtifact(reference: string, sha256: string, bytes: number): Promise<Buffer> {
    if (fixtureMode === 'rollback-baseline' && this.captureIndex > 0) throw Error('Fixture baseline verification failed.');
    if (fixtureMode === 'rollback-compare' && this.captureIndex > 1) throw Error('Fixture after-image verification failed.');
    return super.readArtifact(reference, sha256, bytes);
  }
  override async removeArtifact(reference: string): Promise<void> {
    if (['rollback-status', 'rollback-restore', 'rollback-baseline', 'rollback-compare', 'assert-rollback-failure'].includes(fixtureMode ?? '')) throw Error('Fixture artifact rollback failed.');
    return super.removeArtifact(reference);
  }
  override async capture(kind: 'window' | 'webview'): Promise<DesktopCapture> {
    if (fixtureMode === 'assert-capture-failure') throw Error('Fixture capture backend failed.');
    if (fixtureMode === 'assert-service-cleanup-failure') throw new AggregateError([Error('mask state changed during capture'), new AggregateError([Error('artifact deletion failed: fixture cleanup error')], 'Could not restore desktop mask; managed session stop failed.')], 'Nested DesktopService cleanup failure.');
    const directory = path.join(root, '.umb', 'artifacts', '.umb-managed', 'desktop');
    await mkdir(directory, { recursive: true });
    if (fixtureMode === 'assert-partial-cleanup-failure') {
      const openDescriptor = Object.getOwnPropertyDescriptor(fsPromises, 'open')!;
      const rmDescriptor = Object.getOwnPropertyDescriptor(fsPromises, 'rm')!;
      const originalOpen = openDescriptor.value as (...args: any[]) => Promise<any>;
      Object.defineProperty(fsPromises, 'open', { ...openDescriptor, value: async (...args: any[]) => {
        const handle = await originalOpen.apply(fsPromises, args);
        return new Proxy(handle, { get(target, property) {
          if (property === 'writeFile') return async (data: Uint8Array) => { await target.writeFile(Buffer.from(data).subarray(0, 12)); throw Error('Fixture partial PNG write failed.'); };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      } });
      Object.defineProperty(fsPromises, 'rm', { ...rmDescriptor, value: async (target: string, ...args: any[]) => {
        if (target.startsWith(directory) && target.endsWith('.png')) throw Error('Fixture partial PNG deletion failed.');
        return (rmDescriptor.value as (...args: any[]) => Promise<void>).apply(fsPromises, [target, ...args]);
      } });
      try { return await (this as any).savePng(directory, png) as DesktopCapture; }
      finally { Object.defineProperty(fsPromises, 'open', openDescriptor); Object.defineProperty(fsPromises, 'rm', rmDescriptor); }
    }
    const size = this.windowSize ? `-${this.windowSize.width}x${this.windowSize.height}` : '';
    const filename = `${kind}${size}-${++this.captureIndex}.png`, target = path.join(directory, filename);
    await writeFile(target, png, { flag: 'wx', mode: 0o600 });
    return { kind, path: target, artifactRef: path.relative(root, target).split(path.sep).join('/'), sha256: createHash('sha256').update(png).digest('hex'), byteLength: png.length, width: 1, height: 1, mimeType: 'image/png', bytes: png };
  }
  override async stop() { return { stopped: true }; }
}

await mkdir(root, { recursive: true });
const store = new Store(path.join(root, 'memory.sqlite'), 'desktop-image', 'local');
if (fixtureMode === 'mask-policy') {
  const artifact = { ref: 'artifacts/.umb-managed/desktop/seed.png', sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length };
  for (const [baselineKey, profile] of [['old-unmasked', {}], ['other-mask', { __umb_mask_policy_v1: 'sha256-v1:other-policy' }]] as const) store.saveDesktopBaseline({ baselineKey, captureKind: 'window', profile, artifact, width: 1, height: 1, approval_attestation: 'approved' });
}
const learningWriter = fixtureMode === 'memory-learning' ? testLearningWriter(store, { sensitiveValuesEnv: ['DESKTOP_MEMORY_SECRET'], env: process.env }) : undefined;
if (fixtureMode === 'retention-query-failure') store.listDesktopArtifactReferences = () => { throw new Error('Fixture reference query failure.'); };
const stop = await serve(config, store, { revision: 0 } as any, {
  stdio: true,
  projectRoot: root,
  knowledgeRoot: root,
  desktopServiceFactory: (settings: DesktopConfig) => new FakeDesktopService(settings),
  ...(learningWriter ? { learningWriter } : {}),
  approver: async prompt => !prompt.includes('deny-approval'),
});

process.stdin.once('end', () => {
  void (async () => { try { await stop(); } finally { store.close(); } })();
});
