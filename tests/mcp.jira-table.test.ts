import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serve } from '../src/mcp/server.js';
import type { Config } from '../src/config/config.js';

const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
const freePort = async () => { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as any).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; };
const response = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('MCP structured Jira table tool validates locally, defaults to dry-run, and writes only on both opt-ins', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-mcp-jira-')); const managed = path.join(root, 'artifacts', '.umb-managed');
  await mkdir(managed, { recursive: true }); await writeFile(path.join(managed, 'evidence.png'), png);
  const port = await freePort(), tokenName = 'UMB_MCP_JIRA_TEST_TOKEN', oldUmbToken = process.env[tokenName], oldEmail = process.env.JIRA_EMAIL, oldApiToken = process.env.JIRA_API_TOKEN;
  process.env[tokenName] = 'local-test-token'; process.env.JIRA_EMAIL = 'test@example.invalid'; process.env.JIRA_API_TOKEN = 'mock-token';
  const config = { project: { id: 'jira-table-test', name: 'test', base_url: 'http://127.0.0.1:3000' }, server: { host: '127.0.0.1', port, auth: { mode: 'token', token_env: tokenName } }, artifacts: { directory: './artifacts', redact_sensitive: true, max_file_bytes: 1000 }, browser: { allowed_origins: [] }, memory: { database: './memory.sqlite' }, knowledge: { path: './knowledge' } } as unknown as Config;
  const calls: string[] = []; let existingComments: Array<{ id: string; body: string }> = [];
  let existingAttachments: Array<{ id: string; filename: string; size: number }> = [];
  let attachmentPosts = 0, commentPosts = 0;
  const imageHash = createHash('sha256').update(png).digest('hex'); const filename = `umb-screenshot-${imageHash.slice(0,24)}.png`;
  const tableData = { headers: ['Criterion', 'Result'], rows: [['Ready', 'Pass']], imageCell: { row: 0, column: 1 } };
  const marker = `UMB-JIRA-STRUCTURED-TABLE:${createHash('sha256').update(imageHash).update('\0').update(JSON.stringify(tableData)).digest('hex')}`;
  const jiraFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input); calls.push(`${init.method ?? 'GET'} ${url}`);
    if (url.includes('/comment?')) return response(200, { startAt: 0, total: existingComments.length, comments: existingComments });
    if (url.endsWith('?fields=attachment')) return response(200, { fields: { attachment: existingAttachments } });
    if (url.endsWith('/attachments') && init.method === 'POST') {
      attachmentPosts++;
      assert.ok(init.body instanceof FormData);
      const file = (init.body as FormData).get('file'); assert.ok(file instanceof File);
      assert.equal(file.name, filename); assert.equal(file.size, png.length);
      existingAttachments = [{ id: 'attachment-7', filename: file.name, size: file.size }];
      return response(200, [{ id: 'attachment-7', filename: file.name, size: file.size }]);
    }
    if (url.endsWith('/comment') && init.method === 'POST') {
      commentPosts++;
      const body = JSON.parse(String(init.body)).body;
      assert.equal(body, `${marker}\n|| Criterion || Result ||\n| Ready | Pass !${filename}! |`);
      existingComments = [{ id: 'comment-7', body }]; return response(201, { id: 'comment-7' });
    }
    throw Error('Unexpected mocked Jira request.');
  }) as typeof fetch;
  const browser = { revision: 1, page: { url: () => 'http://127.0.0.1:3000/' } } as any;
  let stop: (() => Promise<void>) | undefined, transport: StreamableHTTPClientTransport | undefined, client: Client | undefined;
  try {
    stop = await serve(config, {} as any, browser, { projectRoot: root, jiraFetch });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer local-test-token' } },
      fetch: (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), accept: 'application/json, text/event-stream' } }),
    });
    client = new Client({ name: 'jira-table-integration', version: '1.0.0' }); await client.connect(transport);
    const listed = await client.listTools();
    const tableTool = listed.tools.find(tool => tool.name === 'jira_publish_screenshot_table'); assert.ok(tableTool);
    assert.match(tableTool.description ?? '', /Never use production Jira/);
    assert.match(tableTool.description ?? '', /exact task-specific user authorization naming the exact non-production issue, site, and operation/);
    const args = { issue_key: 'PROJ-12', site: 'https://example.atlassian.net', image_path: '.umb-managed/evidence.png', headers: tableData.headers, rows: tableData.rows, image_cell: tableData.imageCell };
    const dryRun: any = await client.callTool({ name: 'jira_publish_screenshot_table', arguments: args });
    assert.equal(dryRun.structuredContent.data.status, 'dry_run'); assert.equal(calls.length, 0);
    const unsafe: any = await client.callTool({ name: 'jira_publish_screenshot_table', arguments: { ...args, rows: [['Unsafe | markup', 'Pass']] } });
    assert.equal(unsafe.isError, true); assert.equal(calls.length, 0);
    const missingOptIn: any = await client.callTool({ name: 'jira_publish_screenshot_table', arguments: { ...args, write: true } });
    assert.equal(missingOptIn.isError, true); assert.equal(calls.length, 0);
    assert.match(missingOptIn.structuredContent.error.message, /experimental_inline_wiki=true/);
    assert.doesNotMatch(missingOptIn.structuredContent.error.message, /--experimental-inline-wiki/);
    const published: any = await client.callTool({ name: 'jira_publish_screenshot_table', arguments: { ...args, write: true, experimental_inline_wiki: true } });
    assert.equal(published.structuredContent.data.status, 'published');
    assert.deepEqual({ attachment_id: published.structuredContent.data.attachment_id, comment_id: published.structuredContent.data.comment_id }, { attachment_id: 'attachment-7', comment_id: 'comment-7' });
    assert.equal(published.structuredContent.data.marker, marker);
    const duplicate: any = await client.callTool({ name: 'jira_publish_screenshot_table', arguments: { ...args, write: true, experimental_inline_wiki: true } });
    assert.equal(duplicate.structuredContent.data.status, 'already_published'); assert.equal(duplicate.structuredContent.data.comment_id, 'comment-7');
    assert.equal(attachmentPosts, 1); assert.equal(commentPosts, 1);
    assert.equal(calls.length, 6); assert.ok(calls.some(call => call === 'POST https://example.atlassian.net/rest/api/3/issue/PROJ-12/attachments'));
    assert.ok(calls.every(call => !call.includes('/search')));
  } finally {
    await client?.close().catch(() => undefined); await transport?.close().catch(() => undefined); await stop?.().catch(() => undefined);
    for (const [key, value] of [[tokenName, oldUmbToken], ['JIRA_EMAIL', oldEmail], ['JIRA_API_TOKEN', oldApiToken]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
