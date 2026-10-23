import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRgbaPng } from './png-fixture.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('direct desktop navigation and W3C history tools pass configured origins to the managed service', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-navigation-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'navigation'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-navigation-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    for (const name of ['desktop_navigate', 'desktop_history_back', 'desktop_history_forward']) assert.ok(listed.tools.some(tool => tool.name === name), `${name} is registered directly`);
    const definition = listed.tools.find(tool => tool.name === 'desktop_navigate')!;
    assert.deepEqual((definition.inputSchema as any).required, ['url']);
    assert.deepEqual((definition.inputSchema as any).properties.url, { type: 'string', minLength: 1, maxLength: 4096 });
    const navigated = await client.callTool({ name: 'desktop_navigate', arguments: { url: 'https://allowed.example/path?secret=1' } }) as any;
    assert.equal(navigated.structuredContent.ok, true);
    assert.deepEqual(navigated.structuredContent.data.fixture_navigation, { receivedOrigin: 'https://allowed.example', allowedOrigins: ['https://allowed.example', 'tauri://localhost'] });
    assert.equal(navigated.structuredContent.data.origin, 'https://allowed.example');
    for (const args of [{}, { url: '' }, { url: 'x'.repeat(4097) }, { url: 'https://allowed.example', extra: true }]) {
      const invalid = await client.callTool({ name: 'desktop_navigate', arguments: args }) as any;
      assert.equal(invalid.structuredContent.ok, false);
      assert.equal(invalid.structuredContent.error.code, 'invalid_input');
    }
    for (const [name, action] of [['desktop_history_back', 'back'], ['desktop_history_forward', 'forward']]) {
      const result = await client.callTool({ name, arguments: {} }) as any;
      assert.equal(result.structuredContent.ok, true);
      assert.equal(result.structuredContent.data.action, action);
    }
  } finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('desktop navigation remains disabled with the default empty origin allowlist', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-navigation-disabled-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'navigation-disabled'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-navigation-disabled-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    for (const [name, args] of [['desktop_navigate', { url: 'https://allowed.example' }], ['desktop_history_back', {}], ['desktop_history_forward', {}]]) {
      const result = await client.callTool({ name, arguments: args }) as any;
      assert.equal(result.structuredContent.ok, false);
      assert.match(result.structuredContent.error.message, /desktop\.navigation\.allowed_origins/);
    }
  } finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('desktop_unhandled_rejections is a direct bounded read-only tool and is disabled by default', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-unhandled-rejections-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-unhandled-rejections-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const definition = listed.tools.find(tool => tool.name === 'desktop_unhandled_rejections');
    assert.ok(definition, 'direct desktop diagnostics tool is registered');
    assert.match(definition!.description ?? '', /unhandled promise rejection/);
    assert.match(definition!.description ?? '', /Window ErrorEvents are not collected/);
    assert.match(definition!.description ?? '', /never returns rejection reasons/);
    const input = definition!.inputSchema as any;
    assert.deepEqual(input.required ?? [], []);
    assert.deepEqual(input.properties.after, { type: 'integer', minimum: 0, default: 0 });
    assert.deepEqual(input.properties.limit, { type: 'integer', minimum: 1, maximum: 100, default: 100 });
    const defaults = await client.callTool({ name: 'desktop_unhandled_rejections', arguments: {} }) as any;
    assert.equal(defaults.structuredContent.ok, false);
    assert.match(defaults.structuredContent.error.message, /disabled/);
    for (const args of [{ after: -1 }, { after: 1.5 }, { limit: 0 }, { limit: 101 }, { unexpected: true }]) {
      const invalid = await client.callTool({ name: 'desktop_unhandled_rejections', arguments: args }) as any;
      assert.equal(invalid.structuredContent.ok, false);
      assert.equal(invalid.structuredContent.error.code, 'invalid_input');
    }
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop_unhandled_rejections passes configured diagnostics and pagination to DesktopService', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-unhandled-rejections-on-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'unhandled-rejections'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-unhandled-rejections-pass-through-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const first = await client.callTool({ name: 'desktop_unhandled_rejections', arguments: { after: 0, limit: 1 } }) as any;
    assert.deepEqual(first.structuredContent.data, {
      events: [{ cursor: 1, kind: 'unhandled_rejection', at: 1761000000000 }],
      next_cursor: 1,
      oldest_cursor: 1,
      fixture_diagnostics: { unhandledRejections: true, capacity: 2 },
      received: { after: 0, limit: 1 },
    });
    const next = await client.callTool({ name: 'desktop_unhandled_rejections', arguments: { after: 1, limit: 7 } }) as any;
    assert.deepEqual(next.structuredContent.data.received, { after: 1, limit: 7 });
    assert.deepEqual(next.structuredContent.data.fixture_diagnostics, { unhandledRejections: true, capacity: 2 });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop screenshot removes a captured artifact when post-capture status fails', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-cleanup-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'fail-status'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-cleanup-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'desktop_screenshot', arguments: { kind: 'window' } }) as any;
    assert.equal(result.structuredContent.ok, false);
    const artifactDirectory = path.join(root, '.umb', 'artifacts', '.umb-managed', 'desktop');
    let entries: string[] = [];
    try { entries = await readdir(artifactDirectory); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); }
    assert.deepEqual(entries, [], 'captured PNG must be removed after the later status failure');
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('masked MCP metadata and baseline profile policy reject spoofing and unmasked/different-policy comparisons', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-mask-policy-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'mask-policy'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-mask-policy-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const shot = await client.callTool({ name: 'desktop_screenshot', arguments: { kind: 'window' } }) as any;
    const metadata = shot.structuredContent.data;
    assert.equal(metadata.redaction.applied, true);
    assert.match(metadata.redaction.scope, /top-level WebView DOM regions only/);
    assert.match(metadata.redaction.warning, /UI-tree tool responses/);
    assert.doesNotMatch(JSON.stringify(metadata), /\.private/);
    const spoof = await client.callTool({ name: 'desktop_baseline_save', arguments: { baseline_key: 'spoof', kind: 'window', profile: { __umb_mask_policy_v1: 'sha256-v1:attacker' }, approval_attestation: 'approved' } }) as any;
    assert.equal(spoof.structuredContent.ok, false);
    assert.equal((spoof.content as Array<any>).some(item => item.type === 'image'), false);
    for (const baseline_key of ['old-unmasked', 'other-mask']) {
      const compared = await client.callTool({ name: 'desktop_compare_screenshots', arguments: { baseline_key, kind: 'window', profile: {} } }) as any;
      assert.equal(compared.structuredContent.ok, false);
      assert.match(compared.structuredContent.error.message, /profile must exactly match/);
      assert.doesNotMatch(JSON.stringify(compared), /image\/png|artifact_ref/);
    }
    const saved = await client.callTool({ name: 'desktop_baseline_save', arguments: { baseline_key: 'masked', kind: 'window', profile: { viewport: 'fixture' }, approval_attestation: 'approved' } }) as any;
    assert.equal(saved.structuredContent.ok, true);
    const profile = JSON.parse(saved.structuredContent.data.profile_json);
    assert.match(profile.__umb_mask_policy_v1, /^sha256-v1:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(profile).includes('.private'), false);
    const samePolicy = await client.callTool({ name: 'desktop_compare_screenshots', arguments: { baseline_key: 'masked', kind: 'window', profile: { viewport: 'fixture' } } }) as any;
    assert.equal(samePolicy.structuredContent.ok, true);
    assert.equal(samePolicy.structuredContent.data.comparison.profile_json.includes(profile.__umb_mask_policy_v1), true);
  } finally {
    await client.close().catch(() => undefined); await transport.close().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test('legacy unmasked baseline comparison remains compatible when mask policy is absent', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-legacy-profile-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'legacy-profile'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-legacy-profile-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const baseline = await client.callTool({ name: 'desktop_baseline_save', arguments: { baseline_key: 'legacy', kind: 'window', profile: { viewport: 'fixture' }, approval_attestation: 'approved' } }) as any;
    assert.equal(baseline.structuredContent.ok, true);
    assert.equal(JSON.parse(baseline.structuredContent.data.profile_json).__umb_mask_policy_v1, undefined);
    const comparison = await client.callTool({ name: 'desktop_compare_screenshots', arguments: { baseline_key: 'legacy', kind: 'window', profile: { viewport: 'fixture' } } }) as any;
    assert.equal(comparison.structuredContent.ok, true);
  } finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('MCP artifact rollback failures preserve original and cleanup errors without returning refs or images', { timeout: 60000 }, async () => {
  for (const mode of ['rollback-status', 'rollback-restore', 'rollback-baseline', 'rollback-compare']) {
    const root = await mkdtemp(path.join(os.tmpdir(), `umb-desktop-${mode}-`));
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, mode], cwd: repo, stderr: 'pipe' });
    const client = new Client({ name: `desktop-${mode}-test`, version: '1.0.0' });
    try {
      await client.connect(transport);
      let result: any;
      if (mode === 'rollback-status') result = await client.callTool({ name: 'desktop_screenshot', arguments: { kind: 'window' } });
      if (mode === 'rollback-restore') result = await client.callTool({ name: 'desktop_baseline_save', arguments: { baseline_key: 'restore', kind: 'window', profile: { window_size: { width: 1280, height: 720 } }, approval_attestation: 'approved' } });
      if (mode === 'rollback-baseline') result = await client.callTool({ name: 'desktop_baseline_save', arguments: { baseline_key: 'verify', kind: 'window', profile: {}, approval_attestation: 'approved' } });
      if (mode === 'rollback-compare') {
        const baseline = await client.callTool({ name: 'desktop_baseline_save', arguments: { baseline_key: 'compare', kind: 'window', profile: {}, approval_attestation: 'approved' } }) as any;
        assert.equal(baseline.structuredContent.ok, true);
        result = await client.callTool({ name: 'desktop_compare_screenshots', arguments: { baseline_key: 'compare', kind: 'window', profile: {} } });
      }
      assert.equal(result.structuredContent.ok, false, `${mode} returns an MCP error`);
      assert.match(result.structuredContent.error.message, /artifact rollback failed/);
      assert.match(result.structuredContent.error.message, /Fixture artifact rollback failed/);
      assert.doesNotMatch(JSON.stringify(result), /artifacts\/\.umb-managed\/desktop\/.*\.png/);
      assert.equal((result.content as Array<any>).some(item => item.type === 'image'), false);
    } finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
  }
});

test('baseline capture is removed when temporary size restoration fails', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-restore-cleanup-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'restore-failure'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-restore-cleanup-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'desktop_baseline_save', arguments: {
      baseline_key: 'restore-failure', kind: 'window', profile: { window_size: { width: 1280, height: 720 } }, approval_attestation: 'approved',
    } }) as any;
    assert.equal(result.structuredContent.ok, false);
    assert.match(result.structuredContent.error.message, /restoration failed/);
    const artifactDirectory = path.join(root, '.umb', 'artifacts', '.umb-managed', 'desktop');
    let entries: string[] = [];
    try { entries = await readdir(artifactDirectory); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); }
    assert.deepEqual(entries, [], 'unlinked captured PNG must be removed after restoration failure');
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent finding report and retention sweep never leave a dangling artifact reference', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-retention-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'retention'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-retention-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const capture = await client.callTool({ name: 'desktop_screenshot', arguments: { kind: 'window' } }) as any;
    const data = capture.structuredContent.data;
    const target = path.join(root, data.artifact_ref);
    const expired = new Date(Date.now() - 3 * 86400_000);
    await utimes(target, expired, expired);
    const report = client.callTool({ name: 'desktop_finding_report', arguments: {
      screen: 'old-screen', severity: 'low', confidence: 0.8, category: 'layout', observed_issue: 'Caller reported an issue.',
      screenshot_ref: data.artifact_ref, screenshot_sha256: data.sha256, screenshot_bytes: data.byte_length,
    } }) as Promise<any>;
    const nextCapture = client.callTool({ name: 'desktop_screenshot', arguments: { kind: 'window' } }) as Promise<any>;
    const [linked, captured] = await Promise.all([report, nextCapture]);
    assert.equal(captured.structuredContent.ok, true);
    const listed = await client.callTool({ name: 'desktop_finding_list', arguments: { limit: 100 } }) as any;
    const rows = listed.structuredContent.data as Array<{ screenshot_ref: string }>;
    const hasReference = rows.some(finding => finding.screenshot_ref === data.artifact_ref);
    const hasFile = await readdir(path.dirname(target)).then(names => names.includes(path.basename(target)));
    assert.equal(hasReference, linked.structuredContent.ok, 'a finding ref is persisted only when its verify-and-link operation succeeds');
    if (linked.structuredContent.ok) {
      assert.equal(hasFile, true, 'a successful finding link is visible to the later sweep and preserves its artifact');
    } else {
      assert.equal(hasFile, false, 'if the sweep wins the queue race, it removes the expired unreferenced artifact before linking is attempted');
      assert.match(linked.structuredContent.error.message, /artifact is missing/);
    }
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('age retention is disabled when the optional config field is absent', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-retention-off-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-retention-off-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const first = await client.callTool({ name: 'desktop_screenshot', arguments: { kind: 'window' } }) as any;
    const target = path.join(root, first.structuredContent.data.artifact_ref);
    const expired = new Date(Date.now() - 365 * 86400_000);
    await utimes(target, expired, expired);
    const second = await client.callTool({ name: 'desktop_screenshot', arguments: { kind: 'window' } }) as any;
    assert.equal(second.structuredContent.ok, true);
    assert.ok(await readdir(path.dirname(target)).then(names => names.includes(path.basename(target))));
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop assertions default to no capture and passing assertions never capture', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-assert-off-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-assert-off-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const failed = await client.callTool({ name: 'desktop_assert', arguments: { selector: '#missing', assertion: 'present' } }) as any;
    assert.equal(failed.structuredContent.data.assertion.status, 'FAIL');
    assert.equal(failed.structuredContent.data.capture.status, 'disabled');
    const passed = await client.callTool({ name: 'desktop_assert', arguments: { selector: '#save', assertion: 'text', match: 'contains', expected: 'Fixture' } }) as any;
    assert.equal(passed.structuredContent.data.assertion.status, 'PASS');
    assert.equal(passed.structuredContent.data.capture.status, 'not_needed');
    for (const args of [
      { selector: '#save', assertion: 'present' },
      { selector: '#hidden', assertion: 'hidden' },
      { selector: '#save', assertion: 'enabled' },
      { selector: '#save', assertion: 'text', match: 'exact', expected: 'Fixture text' },
    ]) {
      const result = await client.callTool({ name: 'desktop_assert', arguments: args }) as any;
      assert.equal(result.structuredContent.data.assertion.status, 'PASS');
      assert.equal(result.structuredContent.data.capture.status, 'not_needed');
    }
    const artifactDirectory = path.join(root, '.umb', 'artifacts', '.umb-managed', 'desktop');
    await assert.rejects(readdir(artifactDirectory), { code: 'ENOENT' });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('opted-in failed desktop assertions capture only the WebView and return a PNG image block', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-assert-capture-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'assert-capture'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-assert-capture-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'desktop_assert', arguments: { selector: '#missing', assertion: 'visible' } }) as any;
    assert.equal(result.structuredContent.data.assertion.status, 'FAIL');
    assert.equal(result.structuredContent.data.capture.status, 'captured');
    assert.equal(result.structuredContent.data.capture.capture_type, 'webview');
    assert.match(result.structuredContent.data.capture.artifact_ref, /\.umb-managed\/desktop\/webview-1\.png$/);
    const image = result.content.find((item: any) => item.type === 'image');
    assert.equal(image?.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(image.data, 'base64').subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal('expected' in result.structuredContent.data.assertion, false);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('assertion capture failure preserves FAIL and invalid assertions do not capture', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-assert-error-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'assert-capture-failure'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-assert-error-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const captureFailure = await client.callTool({ name: 'desktop_assert', arguments: { selector: '#missing', assertion: 'present' } }) as any;
    assert.equal(captureFailure.structuredContent.data.assertion.status, 'FAIL');
    assert.deepEqual(captureFailure.structuredContent.data.capture, { status: 'failed', code: 'capture_failed' });
    const invalidSelector = await client.callTool({ name: 'desktop_assert', arguments: { selector: ':invalid', assertion: 'visible' } }) as any;
    assert.equal(invalidSelector.structuredContent.ok, false);
    const ambiguousSelector = await client.callTool({ name: 'desktop_assert', arguments: { selector: '.multiple', assertion: 'visible' } }) as any;
    assert.equal(ambiguousSelector.structuredContent.ok, false, 'visibility state assertions fail closed for non-unique selectors');
    const invalidInput = await client.callTool({ name: 'desktop_assert', arguments: { selector: '#save', assertion: 'text' } }) as any;
    assert.equal(invalidInput.structuredContent.ok, false);
    const artifactDirectory = path.join(root, '.umb', 'artifacts', '.umb-managed', 'desktop');
    assert.deepEqual(await readdir(artifactDirectory), [], 'failed capture and invalid assertions must leave no artifact');
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop_assert reports artifact rollback failure distinctly without image or artifact reference', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-assert-rollback-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'assert-rollback-failure'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-assert-rollback-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'desktop_assert', arguments: { selector: '#missing', assertion: 'present' } }) as any;
    assert.equal(result.structuredContent.data.assertion.status, 'FAIL');
    assert.deepEqual(result.structuredContent.data.capture, { status: 'failed', code: 'artifact_rollback_failed' });
    assert.equal('artifact_ref' in result.structuredContent.data.capture, false);
    assert.equal((result.content as Array<any>).some(item => item.type === 'image'), false);
    assert.doesNotMatch(JSON.stringify(result.structuredContent.data.capture), /\.png|selector/i);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop_assert recursively recognizes nested DesktopService artifact-deletion cleanup failures', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-assert-service-cleanup-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'assert-service-cleanup-failure'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-assert-service-cleanup-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'desktop_assert', arguments: { selector: '#missing', assertion: 'present' } }) as any;
    assert.equal(result.structuredContent.data.assertion.status, 'FAIL');
    assert.deepEqual(result.structuredContent.data.capture, { status: 'failed', code: 'artifact_rollback_failed' });
    assert.equal((result.content as Array<any>).some(item => item.type === 'image'), false);
    assert.doesNotMatch(JSON.stringify(result.structuredContent.data.capture), /\.png|selector|\/tmp\//i);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop_assert classifies partial PNG write plus deletion failure through DesktopService without image or ref', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-assert-partial-cleanup-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'assert-partial-cleanup-failure'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-assert-partial-cleanup-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'desktop_assert', arguments: { selector: '#missing', assertion: 'present' } }) as any;
    assert.equal(result.structuredContent.data.assertion.status, 'FAIL', 'the assertion failure is preserved');
    assert.deepEqual(result.structuredContent.data.capture, { status: 'failed', code: 'artifact_rollback_failed' });
    assert.equal('artifact_ref' in result.structuredContent.data.capture, false);
    assert.equal((result.content as Array<any>).some(item => item.type === 'image'), false);
    assert.doesNotMatch(JSON.stringify(result.structuredContent.data.capture), /\.png|selector|\/tmp\//i);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('reference enumeration failure prevents capture and leaves expired managed PNG unchanged', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-retention-query-error-'));
  const artifactDirectory = path.join(root, '.umb', 'artifacts', '.umb-managed', 'desktop');
  const expiredPath = path.join(artifactDirectory, 'desktop-expired.png');
  const contents = createRgbaPng();
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(expiredPath, contents);
  const expired = new Date(Date.now() - 3 * 86400_000);
  await utimes(expiredPath, expired, expired);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'retention-query-failure'], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-retention-query-failure-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'desktop_screenshot', arguments: { kind: 'window' } }) as any;
    assert.equal(result.structuredContent.ok, false);
    assert.match(result.structuredContent.error.message, /reference query failure/);
    assert.deepEqual(await readdir(artifactDirectory), ['desktop-expired.png'], 'screenshot publication must not run after reference enumeration fails');
    assert.deepEqual(await readFile(expiredPath), contents);
    const stopped = await client.callTool({ name: 'desktop_session_stop', arguments: {} }) as any;
    assert.equal(stopped.structuredContent.ok, true, 'non-artifact cleanup must remain available when retention enumeration fails');
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop screenshot and visual lifecycle MCP tools use verified artifact evidence', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-image-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root], cwd: repo, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-image-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = new Set(listed.tools.map(tool => tool.name));
    for (const name of ['desktop_assert', 'desktop_screenshot', 'desktop_baseline_save', 'desktop_baseline_read', 'desktop_compare_screenshots', 'desktop_finding_report', 'desktop_finding_list', 'desktop_finding_update']) assert.ok(names.has(name), `${name} is registered`);
    const result = await client.callTool({ name: 'desktop_screenshot', arguments: { kind: 'window' } }) as any;
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.data.capture_type, 'window');
    assert.equal(result.structuredContent.data.source, 'verified X11 window capture via wmctrl + ImageMagick import');
    assert.deepEqual(result.structuredContent.data.dimensions, { width: 1, height: 1 });
    assert.equal(result.structuredContent.data.artifact_ref, '.umb/artifacts/.umb-managed/desktop/window-1.png');
    assert.equal(result.structuredContent.data.artifact_directory, '.umb/artifacts/.umb-managed/desktop');
    assert.equal('managed_artifact_ref' in result.structuredContent.data, false);
    assert.equal('bytes' in result.structuredContent.data, false);
    const image = result.content.find((item: any) => item.type === 'image');
    assert.equal(image?.mimeType, 'image/png');
    const bytes = Buffer.from(image.data, 'base64');
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.deepEqual(bytes.subarray(16, 24), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]));
    assert.equal(result.structuredContent.data.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(result.structuredContent.data.byte_length, bytes.length);
    assert.equal((result.structuredContent.image_delivery as any).status, 'included_in_mcp_result');

    const review = await client.callTool({ name: 'desktop_review_ui', arguments: { kind: 'window', screen: 'settings/profile', design_guidance: 'Use compact spacing.' } }) as any;
    assert.equal(review.structuredContent.data.review_bundle.screen, 'settings/profile');
    assert.equal(review.structuredContent.data.review_bundle.visual_assessment_performed, false);
    assert.deepEqual(review.structuredContent.data.review_bundle.findings, []);
    assert.equal(review.structuredContent.data.review_bundle.ui_tree[0].accessibleName, 'Save');
    assert.ok(review.content.some((item: any) => item.type === 'image' && item.mimeType === 'image/png'));

    const baselineArgs = { baseline_key: 'settings-default', kind: 'window', profile: { viewport: 'fixture', theme: 'light', window_size: { width: 1280, height: 720 } }, approval_attestation: 'approved' };
    const invalidSize = await client.callTool({ name: 'desktop_baseline_save', arguments: { ...baselineArgs, profile: { ...baselineArgs.profile, window_size: { width: 0, height: 720 } } } }) as any;
    assert.equal(invalidSize.structuredContent.ok, false);
    assert.equal(invalidSize.structuredContent.error.code, 'invalid_input');
    const refused = await client.callTool({ name: 'desktop_baseline_save', arguments: { ...baselineArgs, approval_attestation: 'not-approved' } }) as any;
    assert.equal(refused.structuredContent.ok, false);
    const approvalDenied = await client.callTool({ name: 'desktop_baseline_save', arguments: { ...baselineArgs, baseline_key: 'deny-approval' } }) as any;
    assert.equal(approvalDenied.structuredContent.error.code, 'approval_denied');
    // The fixture's options.approver callback confirms this key; baseline capture is internal to this tool.
    const saved = await client.callTool({ name: 'desktop_baseline_save', arguments: baselineArgs }) as any;
    assert.equal(saved.structuredContent.ok, true);
    const baseline = saved.structuredContent.data;
    assert.equal(baseline.revision, 1);
    assert.ok(baseline.artifact_ref);
    assert.equal(path.basename(baseline.artifact_ref), 'window-1280x720-3.png', 'invalid dimensions and declined approval must not capture; profile size is applied for capture');
    assert.match(baseline.artifact_sha256, /^[a-f0-9]{64}$/);
    assert.ok(baseline.artifact_bytes > 0);
    const read = await client.callTool({ name: 'desktop_baseline_read', arguments: { baseline_key: 'settings-default' } }) as any;
    assert.equal(read.structuredContent.data.artifact_ref, baseline.artifact_ref);
    const overwriteRefused = await client.callTool({ name: 'desktop_baseline_save', arguments: baselineArgs }) as any;
    assert.equal(overwriteRefused.structuredContent.ok, false);
    const replaced = await client.callTool({ name: 'desktop_baseline_save', arguments: {
      ...baselineArgs, replace: true, expected_revision: 1,
    } }) as any;
    assert.equal(replaced.structuredContent.ok, true);
    assert.equal(replaced.structuredContent.data.revision, 2);
    const staleCas = await client.callTool({ name: 'desktop_baseline_save', arguments: { ...baselineArgs, replace: true, expected_revision: 1 } }) as any;
    assert.equal(staleCas.structuredContent.ok, false);
    // Comparisons and finding evidence must use the current approved revision.
    const activeBaseline = await client.callTool({ name: 'desktop_baseline_read', arguments: { baseline_key: 'settings-default' } }) as any;
    assert.equal(activeBaseline.structuredContent.data.revision, 2);

    const badFinding = await client.callTool({ name: 'desktop_finding_report', arguments: {
      screen: 'settings', severity: 'medium', confidence: 0.9, category: 'layout', observed_issue: 'Control overlaps label.',
      screenshot_ref: '../outside.png', screenshot_sha256: '0'.repeat(64), screenshot_bytes: 11,
    } }) as any;
    assert.equal(badFinding.structuredContent.ok, false);
    const badHash = await client.callTool({ name: 'desktop_finding_report', arguments: {
      screen: 'settings', severity: 'medium', confidence: 0.9, category: 'layout', observed_issue: 'Bad digest.',
      screenshot_ref: baseline.artifact_ref, screenshot_sha256: '0'.repeat(64), screenshot_bytes: baseline.artifact_bytes,
    } }) as any;
    assert.equal(badHash.structuredContent.ok, false);
    const badRef = await client.callTool({ name: 'desktop_finding_report', arguments: {
      screen: 'settings', severity: 'medium', confidence: 0.9, category: 'layout', observed_issue: 'Noncanonical ref.',
      screenshot_ref: '../outside.png', screenshot_sha256: baseline.artifact_sha256, screenshot_bytes: baseline.artifact_bytes,
    } }) as any;
    assert.equal(badRef.structuredContent.ok, false);
    const findingResult = await client.callTool({ name: 'desktop_finding_report', arguments: {
      screen: 'settings', severity: 'medium', confidence: 0.9, category: 'layout', observed_issue: 'Control overlaps label.',
      region: { x: 1, y: 2 }, screenshot_ref: baseline.artifact_ref,
      screenshot_sha256: baseline.artifact_sha256, screenshot_bytes: baseline.artifact_bytes,
    } }) as any;
    assert.equal(findingResult.structuredContent.ok, true);
    const findingId = findingResult.structuredContent.data.id;
    assert.equal(findingResult.structuredContent.data.screenshot_ref, baseline.artifact_ref);

    const compare = await client.callTool({ name: 'desktop_compare_screenshots', arguments: {
      baseline_key: 'settings-default', kind: 'window', profile: { viewport: 'fixture', theme: 'light', window_size: { width: 1280, height: 720 } }, finding_ids: [findingId],
    } }) as any;
    assert.equal(compare.structuredContent.ok, true);
    assert.ok(compare.structuredContent.data.comparison.id);
    assert.ok(compare.structuredContent.data.metrics);
    const comparisonId = compare.structuredContent.data.comparison.id;
    const imageBlocks = compare.content.filter((item: any) => item.type === 'image' && item.mimeType === 'image/png');
    assert.equal(imageBlocks.length, 3, 'baseline, after, and diff images arrive together');
    assert.ok(compare.structuredContent.data.comparison.finding_ids?.includes(findingId));
    assert.equal(compare.structuredContent.data.baseline_ref, activeBaseline.structuredContent.data.artifact_ref);
    assert.ok(compare.structuredContent.data.after_ref);
    assert.match(path.basename(compare.structuredContent.data.after_ref), /^window-1280x720-/);
    assert.ok(compare.structuredContent.data.diff_ref);

    const unresolved = await client.callTool({ name: 'desktop_finding_update', arguments: {
      id: findingId, expected_version: 1, status: 'resolved', assessment: 'Tried to resolve without linked evidence.', comparison_id: '00000000-0000-4000-8000-000000000000',
    } }) as any;
    assert.equal(unresolved.structuredContent.ok, false);
    const noAssessment = await client.callTool({ name: 'desktop_finding_update', arguments: {
      id: findingId, expected_version: 1, status: 'resolved', comparison_id: comparisonId,
    } }) as any;
    assert.equal(noAssessment.structuredContent.ok, false);
    const resolved = await client.callTool({ name: 'desktop_finding_update', arguments: {
      id: findingId, expected_version: 1, status: 'resolved', assessment: 'The overlap is no longer present in the linked comparison.', comparison_id: comparisonId,
    } }) as any;
    assert.equal(resolved.structuredContent.ok, true);
    assert.equal(resolved.structuredContent.data.status, 'resolved');

  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop finding reuse is an explicit caller-authored memory_save step', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-memory-'));
  const secret = 'desktop-memory-secret-sentinel';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx/esm', path.join(repo, 'tests/fixtures/desktop-image-server.ts'), root, 'memory-learning'],
    cwd: repo,
    env: { ...process.env, DESKTOP_MEMORY_SECRET: secret },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'desktop-memory-reuse-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const baselineResult = await client.callTool({ name: 'desktop_baseline_save', arguments: {
      baseline_key: 'memory-reuse-screen', kind: 'window', profile: { screen: 'memory-reuse' }, approval_attestation: 'approved',
    } }) as any;
    assert.equal(baselineResult.structuredContent.ok, true);
    const baseline = baselineResult.structuredContent.data;
    const findingResult = await client.callTool({ name: 'desktop_finding_report', arguments: {
      screen: 'memory-reuse', severity: 'low', confidence: 0.8, category: 'layout', observed_issue: 'Caller-reported spacing concern.',
      screenshot_ref: baseline.artifact_ref, screenshot_sha256: baseline.artifact_sha256, screenshot_bytes: baseline.artifact_bytes,
    } }) as any;
    assert.equal(findingResult.structuredContent.ok, true);
    const findingId = findingResult.structuredContent.data.id;
    const comparisonResult = await client.callTool({ name: 'desktop_compare_screenshots', arguments: {
      baseline_key: 'memory-reuse-screen', kind: 'window', profile: { screen: 'memory-reuse' }, finding_ids: [findingId],
    } }) as any;
    assert.equal(comparisonResult.structuredContent.ok, true);
    const comparisonId = comparisonResult.structuredContent.data.comparison.id;
    const resolved = await client.callTool({ name: 'desktop_finding_update', arguments: {
      id: findingId, expected_version: 1, status: 'resolved', assessment: 'The linked comparison was recorded for the finding.', comparison_id: comparisonId,
    } }) as any;
    assert.equal(resolved.structuredContent.ok, true);

    // This is the separate, explicit authoring step. The finding lifecycle above does not write learning.
    const authoredContent = `Caller-authored bounded desktop learning: review visual evidence before deciding whether a finding is reusable; do not infer quality from pixel metrics. Finding ${findingId}; comparison ${comparisonId}; configured secret ${secret}.`;
    const beforeSave = await client.callTool({ name: 'memory_search', arguments: { query: 'Caller-authored bounded desktop learning' } }) as any;
    assert.equal(beforeSave.structuredContent.ok, true);
    assert.equal((beforeSave.structuredContent.data as Array<any>).length, 0, 'desktop lifecycle calls do not auto-create this learning note');
    const saved = await client.callTool({ name: 'memory_save', arguments: {
      title: 'Desktop finding reuse boundary', content: authoredContent,
    } }) as any;
    assert.equal(saved.structuredContent.ok, true);
    const noteId = saved.structuredContent.data.id;
    assert.equal(saved.structuredContent.data.saved, true);
    assert.equal(saved.structuredContent.data.immediately_available, true);
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(secret));

    const search = await client.callTool({ name: 'memory_search', arguments: { query: 'Caller-authored bounded desktop learning' } }) as any;
    assert.equal(search.structuredContent.ok, true);
    const match = (search.structuredContent.data as Array<any>).find(item => item.id === noteId);
    assert.ok(match, 'explicitly saved learning is available in ordinary memory search');
    assert.equal(match.trust_basis, 'agent_learned');
    assert.notEqual(match.trust_basis, 'verified_fact');
    const fetched = await client.callTool({ name: 'memory_get_node', arguments: { id: noteId } }) as any;
    assert.equal(fetched.structuredContent.ok, true);
    assert.equal(fetched.structuredContent.data.trust_basis, 'agent_learned');
    assert.notEqual(fetched.structuredContent.data.trust_basis, 'verified_fact');
    const stored = JSON.stringify(fetched.structuredContent.data);
    assert.match(stored, /\[REDACTED\]/);
    assert.doesNotMatch(stored, new RegExp(secret));
    assert.match(stored, new RegExp(findingId));
    assert.match(stored, new RegExp(comparisonId));
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
