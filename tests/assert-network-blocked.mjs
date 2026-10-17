import assert from 'node:assert/strict';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export const PROBE_HOST = '1.1.1.1';
export const PROBE_PORT = 443;
const SOCKET_TIMEOUT_MS = 7000;
const ACCEPTED_FIREWALL_CODES = new Set(['EACCES', 'EPERM', 'ETIMEDOUT']);

export function isExpectedFirewallBlock(result) {
  return result.kind === 'error' && ACCEPTED_FIREWALL_CODES.has(result.code);
}

export function probeTcp() {
  return new Promise(resolve => {
    const socket = net.connect({ host: PROBE_HOST, port: PROBE_PORT });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ kind: 'error', code: 'ETIMEDOUT', message: `TCP connect timed out after ${SOCKET_TIMEOUT_MS} ms` });
    }, SOCKET_TIMEOUT_MS);
    socket.once('connect', () => {
      finish({ kind: 'connected' });
    });
    socket.once('error', error => {
      finish({ kind: 'error', code: error.code ?? 'UNKNOWN', message: error.message });
    });
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--self-test') {
    assert.equal(isExpectedFirewallBlock({ kind: 'error', code: 'ETIMEDOUT' }), true);
    assert.equal(isExpectedFirewallBlock({ kind: 'error', code: 'EACCES' }), true);
    assert.equal(isExpectedFirewallBlock({ kind: 'error', code: 'EPERM' }), true);
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'UNKNOWN']) {
      assert.equal(isExpectedFirewallBlock({ kind: 'error', code }), false, `${code} is not proof of firewall blocking`);
    }
    assert.equal(isExpectedFirewallBlock({ kind: 'connected' }), false);
    console.log('Network probe result-classification self-test passed.');
    return;
  }
  if (mode !== '--expect-connected' && mode !== '--expect-blocked') {
    throw new Error('Usage: assert-network-blocked.mjs --expect-connected|--expect-blocked|--self-test');
  }
  const result = await probeTcp();
  if (mode === '--expect-connected') {
    if (result.kind !== 'connected') {
      throw new Error(`Positive network control failed (${result.code ?? result.kind}: ${result.message ?? 'not connected'}); offline gate is inconclusive.`);
    }
    console.log(`Positive TCP connectivity control passed: ${PROBE_HOST}:${PROBE_PORT}.`);
    return;
  }
  if (process.env.UMB_OFFLINE_FIREWALL_ACTIVE !== '1') {
    throw new Error('Blocked probe refused: active firewall policy was not asserted by the caller.');
  }
  if (!isExpectedFirewallBlock(result)) {
    if (result.kind === 'connected') throw new Error(`TCP connection unexpectedly succeeded to ${PROBE_HOST}:${PROBE_PORT}; firewall isolation failed.`);
    throw new Error(`Unexpected blocked-probe error (${result.code}: ${result.message}); not accepted as Windows Firewall evidence.`);
  }
  console.log(`OS firewall blocked TCP ${PROBE_HOST}:${PROBE_PORT} (socket error ${result.code}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
