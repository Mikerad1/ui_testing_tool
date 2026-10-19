import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import {
  NLP_GENERIC_ERROR, NLP_MAX_LINE_BYTES, NLP_MAX_OUTSTANDING, NLP_MAX_SPANS,
  NLP_MAX_TEXT_BYTES, NLP_PROTOCOL_VERSION, NLP_TIMEOUT_MS,
  NLP_ENTITY_LABELS, NLP_RELATION_TYPES,
  type NlpRequest, type NlpResponse, type NlpSpan,
} from './nlp-protocol.js';

type SpawnFunction = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
export type NlpClientOptions = { executable: string; args: string[]; timeoutMs?: number; spawnProcess?: SpawnFunction };
type Pending = { resolve: (response: NlpResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; sourceText?: string };

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validSpan(value: unknown, textLength: number): value is NlpSpan {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.start) && Number.isInteger(value.end) && (value.start as number) >= 0 &&
    (value.end as number) > (value.start as number) && (value.end as number) <= textLength &&
    typeof value.text === 'string' && value.text.length <= 4096 && typeof value.label === 'string' && value.label.length <= 128;
}
function validateResponse(value: unknown, id: string, sourceText?: string): NlpResponse {
  const sourceLength = sourceText === undefined ? undefined : Array.from(sourceText).length;
  if (!isRecord(value) || value.version !== NLP_PROTOCOL_VERSION || value.id !== id || typeof value.ok !== 'boolean') throw new Error(NLP_GENERIC_ERROR);
  if (!value.ok) {
    if (value.error !== 'invalid_request' && value.error !== 'unavailable') throw new Error(NLP_GENERIC_ERROR);
    return value as NlpResponse;
  }
  if (value.op === 'health') {
    const health = value.health;
    if (!isRecord(health) || health.protocol !== NLP_PROTOCOL_VERSION || typeof health.python !== 'string' ||
      typeof health.spacy !== 'string' || typeof health.model !== 'string' || typeof health.model_version !== 'string' ||
      typeof health.rules !== 'string' || typeof health.patterns_schema_version !== 'number' || !Number.isInteger(health.patterns_schema_version) || typeof health.patterns_digest !== 'string' ||
      !Number.isInteger(health.pattern_count) || (health.pattern_count as number) < 0 || typeof health.patterns_ready !== 'boolean' || typeof health.ready !== 'boolean' ||
      (health.ready && !/^\d+\.\d+\.\d+(?:[.+-][A-Za-z0-9.-]+)?$/.test(health.model_version))) throw new Error(NLP_GENERIC_ERROR);
  } else if (value.op === 'analyze') {
    const normalized = value.normalized;
    if (typeof normalized !== 'string' || Buffer.byteLength(normalized, 'utf8') > NLP_MAX_TEXT_BYTES ||
       !Array.isArray(value.tokens) || !Array.isArray(value.entities) || !Array.isArray(value.relations) || value.tokens.length > NLP_MAX_SPANS || value.entities.length > NLP_MAX_SPANS || value.relations.length > NLP_MAX_SPANS ||
       sourceLength === undefined || !value.tokens.every(span => validSpan(span, sourceLength))) throw new Error(NLP_GENERIC_ERROR);
    const chars = Array.from(sourceText!);
    const entities = value.entities as unknown[];
    const relations = value.relations as unknown[];
    const entityLabels = entities.map(entity => isRecord(entity) && typeof entity.label === 'string' ? entity.label : undefined);
    if (!entities.every((entity: unknown) => {
      if (!isRecord(entity) || typeof entity.label !== 'string' || !(NLP_ENTITY_LABELS as readonly string[]).includes(entity.label) ||
        typeof entity.rule_id !== 'string' || !entity.rule_id.length || entity.rule_id.length > 128 || typeof entity.normalized !== 'string' || entity.normalized.length > 4096 ||
        !Number.isInteger(entity.start) || !Number.isInteger(entity.end) || (entity.start as number) < 0 || (entity.end as number) <= (entity.start as number) || (entity.end as number) > sourceLength ||
        typeof entity.text !== 'string' || entity.text.length > 4096) return false;
      return chars.slice(entity.start as number, entity.end as number).join('') === entity.text;
    })) throw new Error(NLP_GENERIC_ERROR);
    if (!relations.every((relation: unknown) => {
      if (!isRecord(relation) || typeof relation.type !== 'string' || !(NLP_RELATION_TYPES as readonly string[]).includes(relation.type) ||
        typeof relation.rule_id !== 'string' || !relation.rule_id.length || relation.rule_id.length > 128 ||
        !Number.isInteger(relation.from_index) || !Number.isInteger(relation.to_index) || (relation.from_index as number) < 0 || (relation.to_index as number) < 0 ||
        relation.from_index === relation.to_index ||
        (relation.from_index as number) >= entities.length || (relation.to_index as number) >= entities.length ||
        !isRecord(relation.evidence) || !Number.isInteger(relation.evidence.start) || !Number.isInteger(relation.evidence.end) ||
        (relation.evidence.start as number) < 0 || (relation.evidence.end as number) <= (relation.evidence.start as number) || (relation.evidence.end as number) > sourceLength || typeof relation.evidence.text !== 'string') return false;
      const from = entityLabels[relation.from_index as number], to = entityLabels[relation.to_index as number];
      const signatureAllowed = relation.type === 'HAS_ACTION' ? from === 'PAGE' && to === 'ACTION' :
        relation.type === 'NAVIGATES_TO' ? (from === 'ACTION' && to === 'PAGE') || (from === 'PAGE' && to === 'PAGE') :
        relation.type === 'HAS_VALIDATION' ? from === 'FIELD' && to === 'RULE' :
        relation.type === 'BELONGS_TO' ? from === 'LOCATOR' && to === 'PAGE' :
        relation.type === 'COVERS' ? from === 'TEST' && to === 'AC' : false;
      return signatureAllowed && chars.slice(relation.evidence.start as number, relation.evidence.end as number).join('') === relation.evidence.text;
    })) throw new Error(NLP_GENERIC_ERROR);
  } else if (value.op !== 'shutdown') throw new Error(NLP_GENERIC_ERROR);
  return value as NlpResponse;
}

/** Managed, explicit-executable JSONL client. Never includes request content in errors. */
export class NlpClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private closed = false;
  private ready = false;
  private readonly timeoutMs: number;

  constructor(options: NlpClientOptions) {
    if (!options.executable || !path.isAbsolute(options.executable) || !Array.isArray(options.args) || options.args.some(arg => typeof arg !== 'string')) throw new Error(NLP_GENERIC_ERROR);
    this.timeoutMs = options.timeoutMs ?? NLP_TIMEOUT_MS;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    try { this.child = (options.spawnProcess ?? spawn)(options.executable, [...options.args], { shell: false, cwd: path.dirname(options.executable), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch { throw new Error(NLP_GENERIC_ERROR); }
    this.child.stdout?.on('data', chunk => this.onData(chunk));
    this.child.stderr?.on('data', () => { /* stderr is deliberately discarded */ });
    this.child.on('error', () => this.failAll());
    this.child.on('exit', () => { this.closed = true; this.failAll(); });
  }

  async health(): Promise<Extract<NlpResponse, { op: 'health' }>> {
    this.ready = false;
    const response = await this.probeHealth();
    if (!response.health.ready) throw new Error(NLP_GENERIC_ERROR);
    this.ready = true;
    return response;
  }

  /** Validate health metadata without marking this client ready for learning. */
  async probeHealth(): Promise<Extract<NlpResponse, { op: 'health' }>> {
    this.ready = false;
    const response = await this.request({ version: NLP_PROTOCOL_VERSION, id: randomUUID(), op: 'health' });
    if (!response.ok || response.op !== 'health') throw new Error(NLP_GENERIC_ERROR);
    return response;
  }
  async analyze(text: string): Promise<Extract<NlpResponse, { op: 'analyze' }>> {
    if (!this.ready || typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > NLP_MAX_TEXT_BYTES) throw new Error(NLP_GENERIC_ERROR);
    const response = await this.request({ version: NLP_PROTOCOL_VERSION, id: randomUUID(), op: 'analyze', text }, text);
    if (!response.ok || response.op !== 'analyze') throw new Error(NLP_GENERIC_ERROR);
    return response;
  }
  async shutdown(): Promise<void> {
    if (this.closed) return;
    try { await this.request({ version: NLP_PROTOCOL_VERSION, id: randomUUID(), op: 'shutdown' }); } catch { /* teardown remains best-effort */ }
    this.closed = true;
    this.child.stdin?.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  private request(request: NlpRequest, sourceText?: string): Promise<NlpResponse> {
    if (this.closed || this.pending.size >= NLP_MAX_OUTSTANDING) return Promise.reject(new Error(NLP_GENERIC_ERROR));
    const line = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(line, 'utf8') > NLP_MAX_LINE_BYTES) return Promise.reject(new Error(NLP_GENERIC_ERROR));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(NLP_GENERIC_ERROR));
      }, this.timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer, sourceText });
      try { this.child.stdin?.write(line, error => { if (error) this.failAll(); }); }
      catch { this.failAll(); }
    });
  }
  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, 'utf8') > NLP_MAX_LINE_BYTES && !this.buffer.includes('\n')) { this.failAll(); this.child.kill(); return; }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line || Buffer.byteLength(line, 'utf8') > NLP_MAX_LINE_BYTES) { this.failAll(); this.child.kill(); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { this.failAll(); this.child.kill(); return; }
      const id = isRecord(parsed) && typeof parsed.id === 'string' ? parsed.id : '';
      const pending = this.pending.get(id);
      if (!pending) { this.failAll(); this.child.kill(); return; }
      try {
        const response = validateResponse(parsed, id, pending.sourceText);
        this.pending.delete(id); clearTimeout(pending.timer); pending.resolve(response);
      } catch { this.pending.delete(id); clearTimeout(pending.timer); pending.reject(new Error(NLP_GENERIC_ERROR)); }
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > NLP_MAX_LINE_BYTES) { this.failAll(); this.child.kill(); }
  }
  private failAll(): void {
    for (const [id, request] of this.pending) { clearTimeout(request.timer); request.reject(new Error(NLP_GENERIC_ERROR)); this.pending.delete(id); }
  }
}
