import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isExpectedFirewallBlock, isExpectedNetnsBlock } from './assert-network-blocked.mjs';

test('classifies only explicit Windows firewall block outcomes as blocked', () => {
  for (const code of ['EACCES', 'EPERM', 'ETIMEDOUT']) {
    assert.equal(isExpectedFirewallBlock({ kind: 'error', code }), true, code);
  }
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'UNKNOWN']) {
    assert.equal(isExpectedFirewallBlock({ kind: 'error', code }), false, code);
  }
  assert.equal(isExpectedFirewallBlock({ kind: 'connected' }), false);
});

test('accepts only ENETUNREACH as proof of a route-less Linux namespace', () => {
  assert.equal(isExpectedNetnsBlock({ kind: 'error', code: 'ENETUNREACH' }), true);
  for (const code of ['EHOSTUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EACCES', 'EPERM', 'UNKNOWN']) {
    assert.equal(isExpectedNetnsBlock({ kind: 'error', code }), false, code);
  }
  assert.equal(isExpectedNetnsBlock({ kind: 'connected' }), false);
});

test('probe rejects missing and malformed modes before attempting any socket', () => {
  const probe = fileURLToPath(new URL('./assert-network-blocked.mjs', import.meta.url));
  for (const args of [[], ['--unrecognized']]) {
    const result = spawnSync(process.execPath, [probe, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: assert-network-blocked\.mjs/);
  }
});
