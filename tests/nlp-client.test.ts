import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { NlpClient } from '../src/memory/nlp-client.js';
import { NLP_GENERIC_ERROR, NLP_MAX_OUTSTANDING } from '../src/memory/nlp-protocol.js';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  requests: Record<string, unknown>[] = [];
  constructor(private readonly respond: (request: Record<string, unknown>, child: FakeChild) => void) {
    super();
    this.stdin.on('data', chunk => {
      const line = chunk.toString().trim();
      if (!line) return;
      const request = JSON.parse(line) as Record<string, unknown>;
      this.requests.push(request);
      this.respond(request, this);
    });
  }
  kill(): boolean { this.exitCode = 0; this.emit('exit', 0, null); return true; }
  send(response: unknown): void { this.stdout.write(`${JSON.stringify(response)}\n`); }
}

function makeClient(respond: ConstructorParameters<typeof FakeChild>[0], timeoutMs = 100) {
  let child: FakeChild;
  const client = new NlpClient({ executable: '/explicit/python', args: ['worker.py'], timeoutMs,
    spawnProcess: ((file: string, args: string[], options: import('node:child_process').SpawnOptions) => {
      assert.equal(file, '/explicit/python'); assert.deepEqual(args, ['worker.py']);
      assert.equal(options.shell, false); assert.equal(options.cwd, '/explicit');
      assert.equal(options.env?.PYTHONPATH, undefined); assert.equal(options.env?.PATH, undefined);
      child = new FakeChild(respond); return child as unknown as ChildProcess;
    }) as never });
  return { client, child: () => child! };
}

test('client sends versioned JSONL and accepts health and bounded analysis', async () => {
  const fixture = makeClient((request, child) => {
    const base = { version: 3, id: request.id, ok: true };
    assert.equal(request.version, 3);
    if (request.op === 'health') child.send({ ...base, op: 'health', health: { protocol: 3, python: '3', spacy: '3', model: 'fake', model_version: '3.8.0', rules: '1', patterns_schema_version: 1, patterns_digest: 'abc', pattern_count: 1, patterns_ready: true, ready: true } });
    else child.send({ ...base, op: request.op, normalized: 'hello', tokens: [{ start: 0, end: 5, text: 'hello', label: 'TOKEN' }], entities: [], relations: [] });
  });
  assert.equal((await fixture.client.health()).health.model, 'fake');
  assert.equal((await fixture.client.analyze('hello')).normalized, 'hello');
  assert.equal(fixture.child().requests.length, 2);
  await fixture.client.shutdown();
});

test('diagnostic health probe accepts not-ready metadata without enabling analysis', async () => {
  const fixture = makeClient((request, child) => {
    const base = { version: 3, id: request.id, ok: true };
    if (request.op === 'health') child.send({ ...base, op: 'health', health: {
      protocol: 3, python: '3', spacy: 'unavailable', model: 'en_core_web_sm',
      model_version: 'unavailable', rules: '1', patterns_schema_version: 1, patterns_digest: 'abc', pattern_count: 1, patterns_ready: true, ready: false,
    } });
    else child.send({ ...base, op: 'shutdown' });
  });
  const response = await fixture.client.probeHealth();
  assert.equal(response.health.ready, false);
  await assert.rejects(fixture.client.analyze('text'), /NLP sidecar request failed/);
  await fixture.client.shutdown();
});

test('spawn ignores hostile ambient Python and PATH variables and uses executable cwd', () => {
  const saved = Object.fromEntries(['PYTHONPATH', 'PYTHONHOME', 'PATH'].map(key => [key, process.env[key]]));
  process.env.PYTHONPATH = '/hostile/imports'; process.env.PYTHONHOME = '/hostile/python'; process.env.PATH = '/hostile/bin';
  try {
    let child: FakeChild | undefined;
    new NlpClient({ executable: '/bundle/runtime/memory-sidecar/sidecar', args: [], spawnProcess: ((file: string, _args: string[], options: import('node:child_process').SpawnOptions) => {
      assert.equal(file, '/bundle/runtime/memory-sidecar/sidecar');
      assert.equal(options.shell, false); assert.equal(options.cwd, '/bundle/runtime/memory-sidecar');
      assert.equal(options.env?.PYTHONPATH, undefined); assert.equal(options.env?.PYTHONHOME, undefined); assert.equal(options.env?.PATH, undefined);
      child = new FakeChild(() => undefined); return child as unknown as ChildProcess;
    }) as never });
    child?.kill();
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('malformed and version-mismatched responses reject generically', async () => {
  const fixture = makeClient((request, child) => child.send({ version: 99, id: request.id, ok: true, op: 'health' }));
  await assert.rejects(fixture.client.health(), error => error instanceof Error && error.message === 'NLP sidecar request failed');
  await fixture.client.shutdown();
});

test('health rejects boolean schema versions but accepts structured unhealthy readiness', async () => {
  const fixture = makeClient((request, child) => {
    child.send({ version: 3, id: request.id, ok: true, op: 'health', health: {
      protocol: 3, python: '3', spacy: '3', model: 'fake', model_version: 'unavailable', rules: '1',
      patterns_schema_version: true, patterns_digest: 'safe', pattern_count: 0, patterns_ready: false, ready: false,
    } });
  });
  await assert.rejects(fixture.client.probeHealth(), /NLP sidecar request failed/);
  await fixture.client.shutdown();
});

test('unavailable child process errors reject generically', async () => {
  const fixture = makeClient((_request, child) => child.emit('error', new Error('ENOENT PRIVATE_EXECUTABLE')));
  await assert.rejects(fixture.client.health(), error => error instanceof Error && error.message === NLP_GENERIC_ERROR);
  await fixture.client.shutdown();
});

test('analysis requires ready health and validates spans against Unicode source offsets', async () => {
  const fixture = makeClient((request, child) => {
    if (request.op === 'health') {
      child.send({ version: 3, id: request.id, ok: true, op: 'health', health: { protocol: 3, python: '3', spacy: '3', model: 'fake', model_version: '3.8.0', rules: '1', patterns_schema_version: 1, patterns_digest: 'abc', pattern_count: 1, patterns_ready: true, ready: true } });
    } else if (request.op === 'analyze') {
      child.send({ version: 3, id: request.id, ok: true, op: 'analyze', normalized: 'x',
        tokens: [{ start: 0, end: 1, text: 'short', label: 'TOKEN' }], entities: [], relations: [] });
    } else child.send({ version: 3, id: request.id, ok: true, op: 'shutdown' });
  });
  await assert.rejects(fixture.client.analyze('😀 ran'), /NLP sidecar request failed/);
  await fixture.client.health();
  const result = await fixture.client.analyze('😀 ran');
  assert.equal(result.normalized, 'x');
  await fixture.client.shutdown();
});

test('protocol v3 rejects relation endpoint signatures that do not match the ontology', async () => {
  const fixture = makeClient((request, child) => {
    const base = { version: 3, id: request.id, ok: true };
    if (request.op === 'health') child.send({ ...base, op: 'health', health: {
      protocol: 3, python: '3', spacy: '3', model: 'fake', model_version: '3.8.0', rules: '1',
      patterns_schema_version: 1, patterns_digest: 'abc', pattern_count: 1, patterns_ready: true, ready: true,
    } });
    else if (request.op === 'analyze') child.send({ ...base, op: 'analyze', normalized: 'x', tokens: [],
      entities: [
        { label: 'PAGE', rule_id: 'p', text: 'Home', normalized: 'home', start: 0, end: 4 },
        { label: 'RULE', rule_id: 'r', text: 'opens', normalized: 'open', start: 5, end: 10 },
      ], relations: [{ type: 'HAS_ACTION', rule_id: 'rel', from_index: 0, to_index: 1, evidence: { start: 0, end: 4, text: 'Home' } }],
    });
    else child.send({ ...base, op: 'shutdown' });
  });
  await fixture.client.health();
  await assert.rejects(fixture.client.analyze('Home opens'), /NLP sidecar request failed/);
  await fixture.client.shutdown();
});

test('timeout and oversized input reject without including request text', async () => {
  const fixture = makeClient(() => undefined, 15);
  await assert.rejects(fixture.client.analyze('private sentinel'), /NLP sidecar request failed/);
  await assert.rejects(fixture.client.analyze('x'.repeat(64 * 1024 + 1)), error => !String(error).includes('x'.repeat(100)));
  await fixture.client.shutdown();
});

test('outstanding request saturation rejects without sending an extra request', async () => {
  const fixture = makeClient(() => undefined);
  const pending = Array.from({ length: NLP_MAX_OUTSTANDING }, () =>
    assert.rejects(fixture.client.health(), error => error instanceof Error && error.message === NLP_GENERIC_ERROR));
  const sentBeforeRejection = fixture.child().requests.length;
  await assert.rejects(fixture.client.health(), error => error instanceof Error && error.message === NLP_GENERIC_ERROR);
  assert.equal(fixture.child().requests.length, sentBeforeRejection, 'saturated request is rejected before writing to sidecar');
  await fixture.client.shutdown();
  await Promise.all(pending);
});
