import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRedactor } from '../src/memory/redactor.js';

test('redacts built-in credentials while retaining safe exact identifiers', () => {
  const redactor = createMemoryRedactor({ sensitive_paths: [], sensitive_values_env: [] }, {});
  const source = 'JIRA-42 #EmailInput Authorization: Bearer bearer-sentinel password="password-sentinel" token: token-sentinel https://user:pass-sentinel@example.test/?access_token=query-sentinel';
  const result = redactor.redactText(source);
  for (const secret of ['bearer-sentinel', 'password-sentinel', 'token-sentinel', 'pass-sentinel', 'query-sentinel']) assert.equal(result.includes(secret), false);
  assert.match(result, /JIRA-42 #EmailInput/);
  assert.match(result, /\[REDACTED\]/);
});

test('redacts configured JSON Pointer fields and environment literals without mutating input', () => {
  const source = { profile: { email: 'person@example.test', safe: 'user-supplied-safe-value' }, note: 'configured-literal user-supplied-safe-value' };
  const redactor = createMemoryRedactor({
    sensitive_paths: ['/profile/email'],
    sensitive_values_env: ['MEMORY_TEST_LITERAL'],
  }, { MEMORY_TEST_LITERAL: 'configured-literal' });
  const result = redactor.redactValue(source) as typeof source;
  assert.equal(result.profile.email, '[REDACTED]');
  assert.equal(result.profile.safe, 'user-supplied-safe-value');
  assert.equal(result.note, '[REDACTED] user-supplied-safe-value');
  assert.equal(source.profile.email, 'person@example.test');
});

test('workflow variables marked sensitive in YAML are fully redacted for memory', () => {
  const redactor = createMemoryRedactor({ sensitive_paths: [], sensitive_values_env: [] }, {});
  const workflow = { variables: { PASSWORD: { from_env: 'LOGIN_PASSWORD', sensitive: true }, REGION: { from_env: 'REGION', sensitive: false } } };
  assert.deepEqual(redactor.redactWorkflowVariables(workflow, { PASSWORD: 'workflow-secret', REGION: 'eu-west' }), {
    PASSWORD: '[REDACTED]',
    REGION: 'eu-west',
  });
});

test('missing configured values and excessive recursive input fail with generic errors', () => {
  assert.throws(
    () => createMemoryRedactor({ sensitive_paths: [], sensitive_values_env: ['MISSING_SECRET'] }, {}),
    error => error instanceof Error && error.message === 'Memory input could not be safely redacted',
  );
  const redactor = createMemoryRedactor({ sensitive_paths: [], sensitive_values_env: [] }, {});
  let deep: unknown = 'sentinel';
  for (let index = 0; index < 40; index += 1) deep = { next: deep };
  assert.throws(
    () => redactor.redactValue(deep),
    error => error instanceof Error && error.message === 'Memory input could not be safely redacted' && !error.message.includes('sentinel'),
  );
});
