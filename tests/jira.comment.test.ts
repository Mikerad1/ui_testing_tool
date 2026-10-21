import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { publishJiraScreenshotComment } from '../src/jira/comment.js';
import type { Config } from '../src/config/config.js';

const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-jira-')); const art = path.join(root, 'artifacts');
  await mkdir(path.join(art, '.umb-managed'), { recursive: true }); await writeFile(path.join(art, '.umb-managed', 'shot.png'), png);
  const config = { artifacts: { directory: './artifacts', redact_sensitive: true, max_file_bytes: 1000 } } as Config;
  return { root, art, config, clean: () => rm(root, { recursive: true, force: true }) };
}
const base = { issueKey: 'PROJ-12', site: 'https://example.atlassian.net', image: '.umb-managed/shot.png', experimentalInlineWiki: true };
function response(status: number, data: unknown) { return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
const commentPage = (comments: unknown[], startAt = 0, total = comments.length) => ({ startAt, maxResults: 100, total, comments });
const issue = (attachments: unknown[] = []) => ({ fields: { attachment: attachments } });

test('validates issue key, Jira site and environment variable names', async () => {
  const s = await setup(); try {
    for (const options of [{ ...base, issueKey: 'bad' }, { ...base, site: 'http://example.atlassian.net' }, { ...base, site: 'https://example.com' }, { ...base, tokenEnv: 'not-valid!' }])
      await assert.rejects(publishJiraScreenshotComment(s.config, s.root, options));
    await assert.rejects(publishJiraScreenshotComment(s.config, s.root, { ...base, experimentalInlineWiki: false }));
    await assert.rejects(publishJiraScreenshotComment(s.config, s.root, { ...base, experimentalInlineWiki: false }), /--experimental-inline-wiki/);
  } finally { await s.clean(); }
});

test('dry-run is local-only and requires explicit inline opt-in', async () => {
  const s = await setup(); let calls = 0; try {
    const output = await publishJiraScreenshotComment(s.config, s.root, base, (async () => { calls++; throw Error('called'); }) as typeof fetch);
    assert.match(output, /DRY RUN/); assert.match(output, /example\.atlassian\.net/); assert.equal(calls, 0);
  } finally { await s.clean(); }
});

test('path containment rejects outside files and symlinks', async () => {
  const s = await setup(); try {
    await writeFile(path.join(s.root, 'outside.png'), png);
    await assert.rejects(publishJiraScreenshotComment(s.config, s.root, { ...base, image: '../outside.png' }));
    await writeFile(path.join(s.art, 'root-image.png'), png);
    await writeFile(path.join(s.art, 'sibling.png'), png);
    await assert.rejects(publishJiraScreenshotComment(s.config, s.root, { ...base, image: 'root-image.png' }), /\.umb-managed/);
    await assert.rejects(publishJiraScreenshotComment(s.config, s.root, { ...base, image: 'sibling.png' }), /\.umb-managed/);
    await symlink(path.join(s.root, 'outside.png'), path.join(s.art, '.umb-managed', 'link.png'));
    await assert.rejects(publishJiraScreenshotComment(s.config, s.root, { ...base, image: '.umb-managed/link.png' }));
    assert.match(await publishJiraScreenshotComment(s.config, s.root, base), /DRY RUN/);
  } finally { await s.clean(); }
});

test('uploads multipart safely then comments to explicit issue only', async () => {
  const s = await setup(); process.env.JIRA_EMAIL = 'person@example.invalid'; process.env.JIRA_API_TOKEN = 'SECRET_TOKEN';
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, init });
    if (!init.method || init.method === 'GET') return url.includes('/comment?') ? response(200, commentPage([])) : response(200, issue());
    if (url.endsWith('/attachments')) {
      assert.equal((init.headers as Record<string,string>)['X-Atlassian-Token'], 'no-check');
      assert.ok(init.body instanceof FormData); assert.equal((init.body as FormData).get('file') instanceof File, true);
      assert.equal((init.body as FormData).get('file') instanceof File ? ((init.body as FormData).get('file') as File).type : '', 'image/png');
      return response(200, [{ id: '44', filename: (init.body as FormData).get('file') instanceof File ? ((init.body as FormData).get('file') as File).name : '' }]);
    }
    assert.equal(url, 'https://example.atlassian.net/rest/api/2/issue/PROJ-12/comment');
    const body = JSON.parse(String(init.body)).body;
    assert.doesNotMatch(body, /UMB-JIRA-/); assert.match(body, /^!umb-screenshot-[a-f0-9]{24}\.png!$/);
    return response(201, { id: 'comment-1' });
  }) as typeof fetch;
  try {
    const result = await publishJiraScreenshotComment(s.config, s.root, { ...base, write: true }, fetcher);
    assert.match(result, /attachment 44/); assert.equal(calls.length, 4); assert.ok(calls.every(c => !c.url.includes('/search')));
    assert.ok(calls.every(c => (c.init.headers as Record<string,string>).Authorization?.startsWith('Basic ')));
    assert.ok(calls.every(c => c.init.redirect === 'manual'));
  } finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; await s.clean(); }
});

test('legacy marker and deterministic filename avoid duplicate writes; attachment match is reused', async () => {
  const s = await setup(); process.env.JIRA_EMAIL = 'person@example.invalid'; process.env.JIRA_API_TOKEN = 'SECRET_TOKEN'; let count = 0;
  const hash = createHash('sha256').update(png).digest('hex');
  const fetcher = (async () => { count++; return response(200, commentPage([{ body: `existing UMB-JIRA-SCREENSHOT:${hash}` }])); }) as typeof fetch;
  try {
    const markerFetch = (async (input: string | URL | Request, init: RequestInit = {}) => { count++; const url = String(input); if (!init.method || init.method === 'GET') return url.includes('/comment?') ? response(200, commentPage([])) : response(200, issue([{ id: 'attachment-9', size: png.length, filename: `umb-screenshot-${hash.slice(0,24)}.png` }])); const body = JSON.parse(String(init.body)).body; assert.match(body, new RegExp(`!umb-screenshot-${hash.slice(0,24)}\\.png!`)); assert.doesNotMatch(body, /UMB-JIRA-/); return response(201, { id: 'comment-1' }); }) as typeof fetch;
    const unchanged = await publishJiraScreenshotComment(s.config, s.root, { ...base, write: true }, fetcher);
    assert.match(unchanged, /no write made/); assert.equal(count, 1);
    const out = await publishJiraScreenshotComment(s.config, s.root, { ...base, write: true }, markerFetch);
    assert.match(out, /attachment attachment-9/);
    assert.equal(count, 4);
  } finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; await s.clean(); }
});

test('table mode posts the fixed table and reuses a size-matched attachment', async () => {
  const s = await setup(); process.env.JIRA_EMAIL = 'person@example.invalid'; process.env.JIRA_API_TOKEN = 'SECRET_TOKEN';
  const hash = createHash('sha256').update(png).digest('hex'); const filename = `umb-screenshot-${hash.slice(0,24)}.png`; const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input); calls.push(`${init.method ?? 'GET'} ${url}`);
    if (url.includes('/comment?')) return response(200, commentPage([{ body: `existing regular marker UMB-JIRA-SCREENSHOT:${hash}` }]));
    if (url.endsWith('?fields=attachment')) return response(200, issue([{ id: 'attachment-table', filename, size: png.length }]));
    if (init.method === 'POST' && url.endsWith('/comment')) {
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.body, `|| Field || Result ||\n| Evidence | !${filename}! |`);
      assert.doesNotMatch(payload.body, /UMB-JIRA-/);
      return response(201, { id: 'table-comment' });
    }
    throw Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  try {
    const result = await publishJiraScreenshotComment(s.config, s.root, { ...base, write: true, table: true }, fetcher);
    assert.match(result, /table and inline image/); assert.ok(!calls.some(call => call.includes('/attachments')));
    assert.equal(calls.length, 3);
  } finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; await s.clean(); }
});

test('an exact marker-free comment body prevents a duplicate write', async () => {
  const s = await setup(); process.env.JIRA_EMAIL = 'person@example.invalid'; process.env.JIRA_API_TOKEN = 'SECRET_TOKEN'; let calls = 0;
  const hash = createHash('sha256').update(png).digest('hex');
  const filename = `umb-screenshot-${hash.slice(0, 24)}.png`;
  const fetcher = (async () => { calls++; return response(200, commentPage([{ body: `!${filename}!` }])); }) as typeof fetch;
  try {
    assert.match(await publishJiraScreenshotComment(s.config, s.root, { ...base, write: true }, fetcher), /matching comment.*no write made/);
    assert.equal(calls, 1);
  } finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; await s.clean(); }
});

test('table mode skips an existing table-specific marker', async () => {
  const s = await setup(); process.env.JIRA_EMAIL = 'person@example.invalid'; process.env.JIRA_API_TOKEN = 'SECRET_TOKEN'; let calls = 0;
  const hash = createHash('sha256').update(png).digest('hex');
  const fetcher = (async () => { calls++; return response(200, commentPage([{ body: `already posted UMB-JIRA-SCREENSHOT-TABLE:${hash}` }])); }) as typeof fetch;
  try {
    const result = await publishJiraScreenshotComment(s.config, s.root, { ...base, write: true, table: true }, fetcher);
    assert.match(result, /no write made/); assert.equal(calls, 1);
  } finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; await s.clean(); }
});

test('structured table rejects unsafe cells and invalid shapes before any fetch', async () => {
  const s = await setup(); process.env.JIRA_EMAIL = 'person@example.invalid'; process.env.JIRA_API_TOKEN = 'SECRET_TOKEN'; let calls = 0;
  const fetcher = (async () => { calls++; throw Error('unexpected network request'); }) as typeof fetch;
  const good = { headers: ['Criterion', 'Result'], rows: [['Visible', 'Pass']], imageCell: { row: 0, column: 1 } };
  try {
    for (const tableData of [
      { ...good, rows: [['Visible', 'Unsafe | value']] },
      { ...good, rows: [['Visible', '+bold+']] },
      { ...good, rows: [['Visible', '-strike-']] },
      { ...good, rows: [['Visible', 'https://example.test/path?query=1']] },
      { ...good, rows: [['Visible\nUnsafe', 'Pass']] },
      { ...good, rows: [['Only one cell']] },
      { ...good, headers: ['Only one header'], rows: [['Only one cell']] },
      { ...good, imageCell: { row: 1, column: 0 } },
    ]) {
      await assert.rejects(publishJiraScreenshotComment(s.config, s.root, { ...base, write: true, experimentalInlineWiki: true, tableData, structuredResult: true }, fetcher), (error: Error) => {
        assert.doesNotMatch(error.message, /Unsafe \| value|\+bold\+|-strike-|https:\/\//); return true;
      });
    }
    assert.equal(calls, 0);
  } finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; await s.clean(); }
});

test('structured markers are stable for identical canonical table data and vary with table content', async () => {
  const s = await setup(); const tableData = { headers: ['Criterion', 'Result'], rows: [['Ready', 'Pass']], imageCell: { row: 0, column: 1 } };
  const noNetwork = (async () => { throw Error('dry-run must not fetch'); }) as typeof fetch;
  try {
    const first = await publishJiraScreenshotComment(s.config, s.root, { ...base, tableData, structuredResult: true }, noNetwork);
    const same = await publishJiraScreenshotComment(s.config, s.root, { ...base, tableData: { ...tableData, headers: ['Criterion', 'Result'] }, structuredResult: true }, noNetwork);
    const different = await publishJiraScreenshotComment(s.config, s.root, { ...base, tableData: { ...tableData, rows: [['Ready', 'Fail']] }, structuredResult: true }, noNetwork);
    assert.equal(first.status, 'dry_run'); assert.equal(first.marker, same.marker); assert.notEqual(first.marker, different.marker);
  } finally { await s.clean(); }
});

test('structured table comments omit the marker while structured results retain it', async () => {
  const s = await setup(); process.env.JIRA_EMAIL = 'person@example.invalid'; process.env.JIRA_API_TOKEN = 'SECRET_TOKEN';
  const tableData = { headers: ['Criterion', 'Result'], rows: [['Ready', 'Pass']], imageCell: { row: 0, column: 1 } };
  let postedBody = '';
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (!init.method || init.method === 'GET') return url.includes('/comment?') ? response(200, commentPage([])) : response(200, issue());
    if (url.endsWith('/attachments')) return response(200, [{ id: 'structured-attachment', filename: `umb-screenshot-${createHash('sha256').update(png).digest('hex').slice(0, 24)}.png` }]);
    postedBody = JSON.parse(String(init.body)).body;
    return response(201, { id: 'structured-comment' });
  }) as typeof fetch;
  try {
    const result = await publishJiraScreenshotComment(s.config, s.root, { ...base, write: true, tableData, structuredResult: true }, fetcher);
    assert.equal(postedBody, `|| Criterion || Result ||\n| Ready | Pass !umb-screenshot-${createHash('sha256').update(png).digest('hex').slice(0, 24)}.png! |`);
    assert.doesNotMatch(postedBody, /UMB-JIRA-/);
    assert.equal(result.status, 'published'); assert.match(result.marker, /^UMB-JIRA-STRUCTURED-TABLE:/);
  } finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; await s.clean(); }
});

test('ambiguous POSTs are not retried and failures never expose credentials', async () => {
  const s = await setup(); process.env.JIRA_EMAIL = 'private@example.invalid'; process.env.JIRA_API_TOKEN = 'TOP_SECRET'; let calls = 0;
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => { calls++; if (!init.method || init.method === 'GET') return String(input).includes('/comment?') ? response(200, commentPage([])) : response(200, issue()); throw Error('TOP_SECRET'); }) as typeof fetch;
  try {
    await assert.rejects(publishJiraScreenshotComment(s.config, s.root, { ...base, write: true }, fetcher), (error: Error) => {
      assert.match(error.message, /ambiguous/); assert.doesNotMatch(error.message, /TOP_SECRET|private@example/); return true;
    });
    assert.equal(calls, 3);
  } finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; await s.clean(); }
});

test('finds a marker beyond the first comment page without writing', async () => {
  const s = await setup(); process.env.JIRA_EMAIL = 'person@example.invalid'; process.env.JIRA_API_TOKEN = 'SECRET_TOKEN'; const urls: string[] = [];
  const hash = createHash('sha256').update(png).digest('hex');
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ body: `comment-${index}` }));
  const secondPage = [{ body: `old UMB-JIRA-SCREENSHOT:${hash}` }];
  const fetcher = (async (input: string | URL | Request) => { const url = String(input); urls.push(url); if (url.includes('startAt=0')) return response(200, commentPage(firstPage, 0, 101)); if (url.includes('startAt=100')) return response(200, commentPage(secondPage, 100, 101)); throw Error('Unexpected Jira request'); }) as typeof fetch;
  try {
    assert.match(await publishJiraScreenshotComment(s.config, s.root, { ...base, write: true }, fetcher), /no write made/);
    assert.equal(urls.length, 2); assert.ok(urls.every(url => url.includes('/issue/PROJ-12/comment?'))); assert.ok(urls.every(url => !url.includes('/search')));
  } finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; await s.clean(); }
});

test('fails closed when comment pagination exceeds the safe limit', async () => {
  const s = await setup(); process.env.JIRA_EMAIL = 'person@example.invalid'; process.env.JIRA_API_TOKEN = 'SECRET_TOKEN'; let calls = 0;
  const fetcher = (async () => { calls++; return response(200, commentPage(Array.from({ length: 100 }, (_, index) => ({ body: `comment-${index}` })), 0, 1001)); }) as typeof fetch;
  try {
    await assert.rejects(publishJiraScreenshotComment(s.config, s.root, { ...base, write: true }, fetcher), /marker absence cannot be established/);
    assert.equal(calls, 1);
  } finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; await s.clean(); }
});

test('refuses same-name attachment reuse when its size differs', async () => {
  const s = await setup(); process.env.JIRA_EMAIL = 'person@example.invalid'; process.env.JIRA_API_TOKEN = 'SECRET_TOKEN'; let calls = 0;
  const hash = createHash('sha256').update(png).digest('hex');
  const fetcher = (async (input: string | URL | Request) => { calls++; if (String(input).includes('/comment?')) return response(200, commentPage([])); return response(200, issue([{ id: 'wrong-size', size: png.length + 1, filename: `umb-screenshot-${hash.slice(0,24)}.png` }])); }) as typeof fetch;
  try {
    await assert.rejects(publishJiraScreenshotComment(s.config, s.root, { ...base, write: true }, fetcher), /unexpected size/);
    assert.equal(calls, 2);
  } finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; await s.clean(); }
});

test('refuses redirects without retrying or forwarding credentials', async () => {
  const s = await setup(); process.env.JIRA_EMAIL = 'person@example.invalid'; process.env.JIRA_API_TOKEN = 'SECRET_TOKEN'; let calls = 0;
  const fetcher = (async (_url: string | URL | Request, init: RequestInit = {}) => { calls++; assert.equal(init.redirect, 'manual'); return new Response('', { status: 302, headers: { location: 'https://evil.invalid/' } }); }) as typeof fetch;
  try {
    await assert.rejects(publishJiraScreenshotComment(s.config, s.root, { ...base, write: true }, fetcher), /redirect refused/); assert.equal(calls, 1);
  } finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; await s.clean(); }
});
