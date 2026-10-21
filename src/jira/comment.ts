import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { safePath } from '../config/config.js';

export interface JiraCommentOptions {
  issueKey: string; site: string; image: string; write?: boolean; experimentalInlineWiki?: boolean; table?: boolean;
  emailEnv?: string; tokenEnv?: string; tableData?: JiraTableData; structuredResult?: boolean;
}
export interface JiraTableData { headers: string[]; rows: string[][]; imageCell: { row: number; column: number } }
export type JiraStructuredResult =
  | { status: 'dry_run'; issue_key: string; marker: string; filename: string; destination: string; rendering: 'experimental_unverified' }
  | { status: 'already_published'; issue_key: string; marker: string; filename: string; comment_id: string | null; attachment_id: string | null; rendering: 'experimental_unverified' }
  | { status: 'published'; issue_key: string; marker: string; filename: string; comment_id: string; attachment_id: string; rendering: 'experimental_unverified' };
type FetchLike = typeof fetch;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const maxResponseBytes = 1024 * 1024;
const commentPageSize = 100;
const maxCommentCount = 1000;
const maxTableBytes = 16_000;

function canonicalTable(table: JiraTableData): JiraTableData {
  if (!Array.isArray(table.headers) || table.headers.length < 2 || table.headers.length > 6 || !Array.isArray(table.rows) || table.rows.length < 1 || table.rows.length > 25) throw Error('Table shape must have 2–6 headers and 1–25 rows.');
  const normalizeCell = (value: unknown, location: string): string => {
    if (typeof value !== 'string' || value.length > 500) throw Error(`Invalid table cell at ${location}.`);
    const normalized = value.normalize('NFC');
    if (!/^[\p{L}\p{N}\p{M} .,;:'"()]*$/u.test(normalized)) throw Error(`Unsafe table cell at ${location}.`);
    return normalized;
  };
  const headers = table.headers.map((cell, index) => normalizeCell(cell, `header ${index}`));
  const rows = table.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== headers.length) throw Error(`Invalid table row ${rowIndex}: width must match headers.`);
    return row.map((cell, column) => normalizeCell(cell, `row ${rowIndex}, column ${column}`));
  });
  const { row, column } = table.imageCell ?? ({} as JiraTableData['imageCell']);
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || row >= rows.length || column < 0 || column >= headers.length) throw Error('Invalid image-cell row or column.');
  const canonical = { headers, rows, imageCell: { row, column } };
  if (Buffer.byteLength(JSON.stringify(canonical), 'utf8') > maxTableBytes) throw Error(`Table data exceeds the ${maxTableBytes}-byte limit.`);
  return canonical;
}

function validate(options: JiraCommentOptions) {
  if (!/^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]*$/.test(options.issueKey)) throw Error('Invalid Jira issue key.');
  let site: URL;
  try { site = new URL(options.site); } catch { throw Error('Invalid Jira site; provide an HTTPS *.atlassian.net origin.'); }
  if (site.protocol !== 'https:' || !/^[a-z0-9-]+\.atlassian\.net$/i.test(site.hostname) || site.port || site.username || site.password || site.pathname !== '/' || site.search || site.hash) throw Error('Invalid Jira site; provide an HTTPS *.atlassian.net origin.');
  if (!options.experimentalInlineWiki && (options.write || !options.structuredResult)) throw Error(options.structuredResult
    ? 'Refusing to publish: explicitly set experimental_inline_wiki=true for this MCP tool.'
    : 'Refusing to publish: explicitly select --experimental-inline-wiki.');
  const emailEnv = options.emailEnv ?? 'JIRA_EMAIL', tokenEnv = options.tokenEnv ?? 'JIRA_API_TOKEN';
  if (!envName.test(emailEnv) || !envName.test(tokenEnv)) throw Error('Invalid credential environment variable name.');
  return { site: site.origin, emailEnv, tokenEnv };
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxResponseBytes) { await reader.cancel(); throw Error('Jira response exceeded the safe size limit.'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function safeResponseError(status: number, body: string) {
  // Do not surface server-provided text: Jira may echo account details or request data.
  void body;
  return `Jira returned HTTP ${status}.`;
}

async function request(fetcher: FetchLike, url: string, init: RequestInit, kind: string): Promise<{ response: Response; text: string }> {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) }); }
  catch { throw Error(`${kind} request failed before a response.`); }
  if (response.status >= 300 && response.status < 400) throw Error('Jira redirect refused; credentials were not forwarded.');
  const text = await boundedText(response);
  return { response, text };
}

export function publishJiraScreenshotComment(config: Config, root: string, options: JiraCommentOptions & { structuredResult: true }, fetcher?: FetchLike): Promise<JiraStructuredResult>;
export function publishJiraScreenshotComment(config: Config, root: string, options: JiraCommentOptions & { structuredResult?: false | undefined }, fetcher?: FetchLike): Promise<string>;
export async function publishJiraScreenshotComment(config: Config, root: string, options: JiraCommentOptions, fetcher: FetchLike = fetch): Promise<string | JiraStructuredResult> {
  const { site, emailEnv, tokenEnv } = validate(options);
  const tableData = options.tableData ? canonicalTable(options.tableData) : undefined;
  if (options.structuredResult && !tableData) throw Error('Structured Jira publishing requires table data.');
  if (!options.image || path.isAbsolute(options.image)) throw Error('--image must be a project-relative managed artifact path.');
  const artifacts = config.artifacts;
  if (!artifacts || !artifacts.redact_sensitive) throw Error('Jira publishing requires artifacts.redact_sensitive: true.');
  const artifactRoot = await safePath(root, artifacts.directory, false);
  const managedRoot = await safePath(root, path.join(artifactRoot, '.umb-managed'), false);
  const source = await safePath(root, path.resolve(artifactRoot, options.image), false);
  const [canonicalManagedRoot, canonicalSource] = await Promise.all([realpath(managedRoot), realpath(source)]);
  const relative = path.relative(canonicalManagedRoot, canonicalSource);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('Image must be inside the configured artifacts/.umb-managed directory.');
  const bytes = await readFile(canonicalSource);
  if (bytes.length === 0 || bytes.length > artifacts.max_file_bytes) throw Error('Image exceeds the configured artifact size limit.');
  const extension = path.extname(canonicalSource).toLowerCase();
  const formats: Record<string, { mime: string; signature: (data: Buffer) => boolean }> = {
    '.png': { mime: 'image/png', signature: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
    '.jpg': { mime: 'image/jpeg', signature: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    '.jpeg': { mime: 'image/jpeg', signature: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    '.webp': { mime: 'image/webp', signature: b => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  };
  const format = formats[extension]; if (!format || !format.signature(bytes)) throw Error('Only valid PNG, JPEG, or WebP images can be published.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const filename = `umb-screenshot-${hash.slice(0, 24)}${extension}`;
  const contentHash = tableData ? createHash('sha256').update(hash).update('\0').update(JSON.stringify(tableData)).digest('hex') : hash;
  const marker = tableData ? `UMB-JIRA-STRUCTURED-TABLE:${contentHash}` : options.table ? `UMB-JIRA-SCREENSHOT-TABLE:${hash}` : `UMB-JIRA-SCREENSHOT:${hash}`;
  const body = tableData
    ? `|| ${tableData.headers.join(' || ')} ||\n${tableData.rows.map((row, rowIndex) => `| ${row.map((cell, column) => rowIndex === tableData.imageCell.row && column === tableData.imageCell.column ? `${cell} !${filename}!` : cell).join(' | ')} |`).join('\n')}`
    : options.table ? `|| Field || Result ||\n| Evidence | !${filename}! |` : `!${filename}!`;
  const issueUrl = `${site}/rest/api/2/issue/${encodeURIComponent(options.issueKey)}`;
  if (!options.write && options.structuredResult) return { status: 'dry_run', issue_key: options.issueKey, marker, filename, destination: `${issueUrl}/comment`, rendering: 'experimental_unverified' };
  if (!options.write) return `DRY RUN: would inspect comments at ${issueUrl}/comment and attachments at ${issueUrl}?fields=attachment, reuse a same-name/size-matched ${filename} attachment if present or upload it otherwise, then post an experimental ${options.table ? 'wiki table' : 'wiki-inline'} comment to ${issueUrl}/comment. No Jira requests were made.`;
  const email = process.env[emailEnv], token = process.env[tokenEnv];
  if (!email || !token) throw Error(`Set ${emailEnv} and ${tokenEnv} in the environment before using --write.`);
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const commentsUrl = `${issueUrl}/comment`;
  let expectedTotal: number | undefined, inspected = 0;
  while (expectedTotal === undefined || inspected < expectedTotal) {
    const pageUrl = `${commentsUrl}?startAt=${inspected}&maxResults=${commentPageSize}`;
    const page = await request(fetcher, pageUrl, { headers: { Authorization: auth, Accept: 'application/json' } }, 'Jira comment inspection');
    if (!page.response.ok) throw Error(safeResponseError(page.response.status, page.text));
    let data: any; try { data = JSON.parse(page.text); } catch { throw Error('Jira returned an invalid comment page.'); }
    if (!Number.isSafeInteger(data?.startAt) || data.startAt !== inspected || !Number.isSafeInteger(data?.total) || data.total < 0 || !Array.isArray(data?.comments)) throw Error('Jira comment pagination metadata is incomplete; refusing to publish because marker absence cannot be established.');
    if (expectedTotal === undefined) {
      expectedTotal = data.total;
      if (data.total > maxCommentCount) throw Error(`Issue has more than ${maxCommentCount} comments; marker absence cannot be established within the safe pagination limit.`);
    } else if (data.total !== expectedTotal) throw Error('Jira comment count changed during pagination; marker absence cannot be established.');
    const total = expectedTotal;
    if (total === undefined || data.comments.length > commentPageSize || inspected + data.comments.length > total || (data.comments.length === 0 && inspected < total)) throw Error('Jira returned an incomplete comment page; marker absence cannot be established.');
    const priorComment = data.comments.find((comment: any) => typeof comment?.body === 'string' && (comment.body === body || comment.body.includes(marker)));
    if (priorComment) {
      if (!options.structuredResult) return `Already published: matching comment exists on ${options.issueKey}; no write made.`;
      const priorIssue = await request(fetcher, `${issueUrl}?fields=attachment`, { headers: { Authorization: auth, Accept: 'application/json' } }, 'Jira attachment inspection');
      if (!priorIssue.response.ok) throw Error(safeResponseError(priorIssue.response.status, priorIssue.text));
      let priorData: any; try { priorData = JSON.parse(priorIssue.text); } catch { throw Error('Jira returned an invalid issue response.'); }
      if (!Array.isArray(priorData?.fields?.attachment)) throw Error('Jira issue response did not include attachments.');
      const priorAttachment = priorData.fields.attachment.find((item: any) => item?.filename === filename);
      if (priorAttachment && (!Number.isSafeInteger(priorAttachment.size) || priorAttachment.size !== bytes.length)) throw Error(`An attachment named ${filename} already exists with an unexpected size; refusing to reuse it.`);
      return { status: 'already_published', issue_key: options.issueKey, marker, filename, comment_id: priorComment.id == null ? null : String(priorComment.id), attachment_id: priorAttachment?.id == null ? null : String(priorAttachment.id), rendering: 'experimental_unverified' };
    }
    inspected += data.comments.length;
    if (inspected < total && data.comments.length !== commentPageSize) throw Error('Jira returned a short comment page; marker absence cannot be established.');
    if (total === 0) break;
  }
  const get = await request(fetcher, `${issueUrl}?fields=attachment`, { headers: { Authorization: auth, Accept: 'application/json' } }, 'Jira attachment inspection');
  if (!get.response.ok) throw Error(safeResponseError(get.response.status, get.text));
  let issue: any; try { issue = JSON.parse(get.text); } catch { throw Error('Jira returned an invalid issue response.'); }
  const attachments = issue?.fields?.attachment;
  if (!Array.isArray(attachments)) throw Error('Jira issue response did not include attachments.');
  let attachment = attachments.find((item: any) => item?.filename === filename);
  if (attachment && (!Number.isSafeInteger(attachment.size) || attachment.size !== bytes.length)) throw Error(`An attachment named ${filename} already exists with an unexpected size; refusing to reuse or upload a duplicate.`);
  if (!attachment) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: format.mime }), filename);
    let uploaded: { response: Response; text: string };
    try { uploaded = await request(fetcher, `${site}/rest/api/3/issue/${encodeURIComponent(options.issueKey)}/attachments`, { method: 'POST', headers: { Authorization: auth, 'X-Atlassian-Token': 'no-check', Accept: 'application/json' }, body: form }, 'Attachment upload'); }
    catch { throw Error(`Attachment upload outcome is ambiguous; do not retry blindly. Intended filename: ${filename}.`); }
    if (!uploaded.response.ok) throw Error(`Attachment POST outcome may be partial/ambiguous; ${safeResponseError(uploaded.response.status, uploaded.text)} Filename: ${filename}. Do not retry blindly.`);
    let result: any; try { result = JSON.parse(uploaded.text); } catch { throw Error(`Attachment POST outcome is ambiguous; Jira response was invalid. Filename: ${filename}. Do not retry blindly.`); }
    attachment = Array.isArray(result) ? result.find((item: any) => item?.filename === filename) : undefined;
    if (!attachment?.id) throw Error(`Attachment POST outcome is ambiguous; no confirmed attachment id for ${filename}. Do not retry blindly.`);
  }
  let posted: { response: Response; text: string };
  try { posted = await request(fetcher, `${site}/rest/api/2/issue/${encodeURIComponent(options.issueKey)}/comment`, { method: 'POST', headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }, 'Comment creation'); }
  catch { throw Error(`Attachment ${attachment.id} (${filename}) is confirmed, but comment outcome is ambiguous; do not retry blindly. Wiki inline rendering remains experimental.`); }
  if (!posted.response.ok) throw Error(`Attachment ${attachment.id} (${filename}) is confirmed, but comment POST may be partial/ambiguous: ${safeResponseError(posted.response.status, posted.text)} Do not retry blindly. Wiki inline rendering remains experimental.`);
  if (options.structuredResult) {
    let comment: any; try { comment = JSON.parse(posted.text); } catch { throw Error(`Comment POST outcome is ambiguous; attachment ${attachment.id} (${filename}) is confirmed, but no comment id was returned. Do not retry blindly.`); }
    if (comment?.id == null) throw Error(`Comment POST outcome is ambiguous; attachment ${attachment.id} (${filename}) is confirmed, but no comment id was returned. Do not retry blindly.`);
    return { status: 'published', issue_key: options.issueKey, marker, filename, comment_id: String(comment.id), attachment_id: String(attachment.id), rendering: 'experimental_unverified' };
  }
  return `Published to ${options.issueKey}: attachment ${attachment.id} (${filename}) and comment. Legacy wiki ${options.table ? 'table and inline image' : 'inline image'} rendering is experimental and must be verified in a Jira sandbox.`;
}
