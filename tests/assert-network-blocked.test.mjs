import test from 'node:test';
import assert from 'node:assert/strict';
import { isExpectedFirewallBlock } from './assert-network-blocked.mjs';

test('classifies only explicit Windows firewall block outcomes as blocked', () => {
  for (const code of ['EACCES', 'EPERM', 'ETIMEDOUT']) {
    assert.equal(isExpectedFirewallBlock({ kind: 'error', code }), true, code);
  }
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'UNKNOWN']) {
    assert.equal(isExpectedFirewallBlock({ kind: 'error', code }), false, code);
  }
  assert.equal(isExpectedFirewallBlock({ kind: 'connected' }), false);
});
