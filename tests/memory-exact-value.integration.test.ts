import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/memory/store.js';
import { testWriter } from './helpers/learning.js';

test('LearningWriter preserves byte-exact UI values through verification and exact search', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-exact-value-'));
  let store: Store | undefined;
  try {
    store = new Store(path.join(root, 'memory.sqlite'), 'exact-value-project');
    const writer = testWriter(store);
    const screen = await writer.propose({
      observation_id: 'exact-screen-proposal',
      type: 'screen',
      stable_key: 'CaseSensitiveScreen',
      display_name: 'Case-sensitive screen',
      attributes: {
        id: 'CaseSensitiveScreen',
        route: '/Orders/Review-v2',
        elements: [{
          id: 'SubmitOrder-Btn',
          locator: { by: 'test_id', value: 'SubmitOrder-Btn' },
        }],
      },
    }) as any;
    const validation = await writer.propose({
      observation_id: 'exact-validation-proposal',
      type: 'validation_rule',
      stable_key: 'OrderValidation-7',
      display_name: 'Order validation',
      attributes: {
        rule_id: 'OrderValidation-7',
        error_code: 'E_Order-409',
        error: 'Order ID "AbC-17" is invalid! Please retry.',
      },
    }) as any;
    const testRecord = await writer.propose({
      observation_id: 'exact-test-proposal',
      type: 'test',
      stable_key: 'test-record-47',
      display_name: 'Checkout UI test',
      attributes: {
        test_id: 'CheckoutTest-47',
        issue_key: 'WEB-123',
        url: 'https://example.test/Orders/Review-v2',
      },
    }) as any;

    const exactClaims = [
      { value: 'SubmitOrder-Btn', type: 'screen', key: 'CaseSensitiveScreen', paths: ['attributes.elements[0].id', 'attributes.elements[0].locator.value'] },
      { value: '/Orders/Review-v2', type: 'screen', key: 'CaseSensitiveScreen', paths: ['attributes.route'] },
      { value: 'E_Order-409', type: 'validation_rule', key: 'OrderValidation-7', paths: ['attributes.error_code'] },
      { value: 'Order ID "AbC-17" is invalid! Please retry.', type: 'validation_rule', key: 'OrderValidation-7', paths: ['attributes.error'] },
      { value: 'CheckoutTest-47', type: 'test', key: 'test-record-47', paths: ['attributes.test_id'] },
      { value: 'WEB-123', type: 'test', key: 'test-record-47', paths: ['attributes.issue_key'] },
      { value: 'https://example.test/Orders/Review-v2', type: 'test', key: 'test-record-47', paths: ['attributes.url'] },
    ];
    for (const claim of exactClaims) {
      assert.deepEqual(store.searchPage(claim.value, { mode: 'exact' }).data, [], 'proposals must not appear before verification');
    }
    assert.deepEqual(store.searchPage('SubmitOrder-Btn', { mode: 'exact' }).data, []);

    for (const node of [screen, validation, testRecord]) {
      const assertion = store.recordAssertion({
        session_id: 'exact-value-regression',
        subject_node_id: node.id,
        passed: true,
        observed_count: 1,
        actions: [],
      });
      assert.equal(await writer.verify(node.id, assertion.id, { approved: true, source: 'local_approver' }), true);
    }

    for (const claim of exactClaims) {
      const result = store.searchPage(claim.value, { mode: 'exact' });
      assert.equal(result.data.length, 1, `exact search should resolve ${claim.paths.join(', ')}`);
      const {provenance,...exactRow}=result.data[0] as any;
      assert.equal(provenance.status,'provenance_only');
      assert.deepEqual(exactRow, {
         id: claim.type === 'screen' ? screen.id : claim.type === 'test' ? testRecord.id : validation.id,
        type: claim.type,
        stable_key: claim.key,
         display_name: claim.type === 'screen' ? 'Case-sensitive screen' : claim.type === 'test' ? 'Checkout UI test' : 'Order validation',
        trust_basis: 'verified_fact',
        matched_paths: claim.paths,
      });
      assert.deepEqual(store.searchPage(claim.value.toLowerCase(), { mode: 'exact' }).data, [], 'wrong case must not match');
    }
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
