import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DesktopService, DesktopCandidateSummary } from '../src/desktop/index.js';
import type { WorkflowDocument } from '../src/workflow/contract.js';
import { createDesktopWorkflowDriver } from '../src/workflow/desktop-driver.js';

const target = { by: 'css', value: 'button.save' } as const;
const candidate: DesktopCandidateSummary = {
  index: 0, role: 'button', accessibleName: 'Save', text: 'Save', enabled: true, visible: true,
  rect: { x: 0, y: 0, width: 10, height: 10 },
};
function workflow(overrides: Record<string, unknown> = {}): WorkflowDocument {
  return {
    schema_version: 1, kind: 'workflow', id: 'desktop-flow', name: 'desktop flow',
    steps: [{ id: 'click', action: 'click', target }],
    ...overrides,
  } as WorkflowDocument;
}
function fakeService(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let matches: DesktopCandidateSummary[] = [candidate];
  let text = 'safe text';
  let waitResult = true;
  let waitHandler: ((...args: unknown[]) => Promise<boolean>) | undefined;
  const service = {
    find: async (...args: unknown[]) => { calls.push({ method: 'find', args }); return matches; },
    click: async (...args: unknown[]) => { calls.push({ method: 'click', args }); },
    type: async (...args: unknown[]) => { calls.push({ method: 'type', args }); },
    scroll: async (...args: unknown[]) => { calls.push({ method: 'scroll', args }); },
    text: async (...args: unknown[]) => { calls.push({ method: 'text', args }); return text; },
    waitFor: async (...args: unknown[]) => { calls.push({ method: 'waitFor', args }); return waitHandler ? waitHandler(...args) : waitResult; },
    setActionRequestTimeout: (timeout: number | undefined) => { calls.push({ method: 'setTimeout', args: [timeout] }); },
    ...overrides,
  } as unknown as DesktopService;
  return {
    service, calls,
    setMatches(value: DesktopCandidateSummary[]) { matches = value; },
    setText(value: string) { text = value; },
    setWaitResult(value: boolean) { waitResult = value; },
    setWaitHandler(value: (...args: unknown[]) => Promise<boolean>) { waitHandler = value; },
  };
}

test('desktop workflow driver executes the supported CSS subset without returning text content', async () => {
  const fake = fakeService();
  const driver = createDesktopWorkflowDriver({ service: fake.service });
  const doc = workflow({
    preconditions: [{ condition: 'visible', target }],
    steps: [
      { id: 'click', action: 'click', target },
      { id: 'type', action: 'type', target, value: 'hello' },
      { id: 'scroll', action: 'scroll', direction: 'up', amount: 250 },
      { id: 'wait-present', action: 'wait', condition: 'present', target },
      { id: 'wait-visible', action: 'wait', condition: 'visible', target },
      { id: 'wait-hidden', action: 'wait', condition: 'hidden', target },
      { id: 'wait-enabled', action: 'wait', condition: 'enabled', target },
      { id: 'assert-visible', action: 'assert', condition: 'visible', target },
      { id: 'assert-present', action: 'assert', condition: 'present', target },
      { id: 'assert-enabled', action: 'assert', condition: 'enabled', target },
      { id: 'assert-text', action: 'assert', condition: 'text', target, expected: 'safe', match: 'contains' },
      { id: 'assert-exact', action: 'assert', condition: 'text', target, expected: 'safe text', match: 'exact' },
    ],
    on_failure: { capture: ['desktop_screenshot'], stop: true },
  });
  await driver.validateWorkflow(doc);
  const precondition = await driver.assert(doc.preconditions![0]!, {}, 50);
  assert.deepEqual(precondition, { passed: true, observedCount: 1 });
  await driver.execute(doc.steps[0] as any, {}, 1000);
  await driver.execute(doc.steps[1] as any, {}, 1000);
  await driver.execute(doc.steps[2] as any, {}, 1000);
  for (const step of doc.steps.slice(3, 7)) await driver.wait(step as any, {}, 1000);
  const visibility = await driver.assert(doc.steps[7] as any, {}, 50);
  const present = await driver.assert(doc.steps[8] as any, {}, 50);
  const enabled = await driver.assert(doc.steps[9] as any, {}, 50);
  const assertion = await driver.assert(doc.steps[10] as any, {}, 50);
  const exact = await driver.assert(doc.steps[11] as any, {}, 50);
  assert.deepEqual(visibility, { passed: true, observedCount: 1 });
  assert.deepEqual(present, { passed: true, observedCount: 1 });
  assert.deepEqual(enabled, { passed: true, observedCount: 1 });
  assert.deepEqual(assertion, { passed: true, observedCount: 1 });
  assert.deepEqual(exact, { passed: true, observedCount: 1 });
  assert.equal(JSON.stringify(assertion).includes('safe text'), false);
  fake.setMatches([]);
  assert.deepEqual(await driver.assert({ condition: 'hidden', target } as any, {}, 50), { passed: true, observedCount: 0 });
  assert.deepEqual(fake.calls.find(call => call.method === 'scroll')?.args, [undefined, 0, -250]);
  assert.deepEqual(fake.calls.filter(call => call.method === 'waitFor').map(call => call.args[1]), ['present', 'visible', 'hidden', 'enabled']);
  driver.cleanup();
  assert.equal(fake.calls.at(-1)?.method, 'setTimeout');
  assert.equal(fake.calls.at(-1)?.args[0], undefined);
});

test('whole-document validation rejects unsupported semantics before service effects', async () => {
  const unsupported = [
    workflow({ steps: [{ id: 'fill', action: 'fill', target, value: 'x' }] }),
    workflow({ steps: [{ id: 'press', action: 'press', target, key: 'Enter' }] }),
    workflow({ steps: [{ id: 'select', action: 'select', target, value: 'x' }] }),
    workflow({ steps: [{ id: 'navigate', action: 'navigate', path: '/x' }] }),
    workflow({ steps: [{ id: 'role', action: 'click', target: { by: 'role', role: 'button' } }] }),
    workflow({ start_screen: 'screen:home' }),
    workflow({ preconditions: [{ condition: 'url_matches', expected: '/home' }] }),
    workflow({ preconditions: [{ condition: 'count', target, expected: 1 }] }),
    workflow({ preconditions: [{ condition: 'value', target, expected: 'x' }] }),
    workflow({ steps: [{ id: 'attached', action: 'wait', condition: 'attached', target }] }),
    workflow({ on_failure: { capture: ['screenshot'], stop: true } }),
  ];
  for (const doc of unsupported) {
    const fake = fakeService(); const driver = createDesktopWorkflowDriver({ service: fake.service });
    assert.throws(() => driver.validateWorkflow(doc), /precondition_failed/);
    assert.deepEqual(fake.calls, [], 'validation must not invoke DesktopService');
  }
});

test('desktop preflight allows requires role/environment for shared-runner validation', () => {
  const fake = fakeService();
  const driver = createDesktopWorkflowDriver({ service: fake.service, role: 'operator', environment: 'staging' });
  assert.doesNotThrow(() => driver.validateWorkflow(workflow({ requires: { role: 'role:operator', environment: ['staging'] } })));
  assert.deepEqual(fake.calls, []);
  assert.throws(() => driver.validateWorkflow(workflow({ start_screen: 'screen:home' })), /precondition_failed/);
  assert.throws(() => driver.validateWorkflow(workflow({ end_screen: 'screen:done' })), /precondition_failed/);
});

test('desktop preflight rejects role/environment mismatches before service effects', () => {
  const workflowWithRequirements = workflow({ requires: { role: 'role:operator', environment: ['staging'] } });
  for (const context of [
    { role: 'viewer', environment: 'staging' },
    { role: 'operator', environment: 'production' },
    { role: 'operator' },
  ]) {
    const fake = fakeService();
    const driver = createDesktopWorkflowDriver({ service: fake.service, ...context });
    assert.throws(() => driver.validateWorkflow(workflowWithRequirements), error => {
      assert.equal((error as { code?: string }).code, 'precondition_failed');
      return true;
    });
    assert.deepEqual(fake.calls, []);
  }
});

test('high-risk action-specific and any rules deny before run/action effects', async () => {
  for (const rule of [{ action: 'click' }, { action: 'any' }]) {
    const fake = fakeService(); const driver = createDesktopWorkflowDriver({ service: fake.service, highRiskRules: [rule] });
    assert.throws(() => driver.validateWorkflow(workflow()), /approval_denied/);
    assert.deepEqual(fake.calls, []);
    await assert.rejects(driver.execute({ id: 'click', action: 'click', target } as any, {}, 100), /approval_denied/);
    assert.deepEqual(fake.calls, [], 'denial precedes even target inspection');
  }
});

test('click and type require exactly one visible enabled CSS target', async () => {
  for (const values of [
    [candidate, candidate],
    [{ ...candidate, visible: false }],
    [{ ...candidate, enabled: false }],
  ]) {
    const fake = fakeService(); fake.setMatches(values);
    const driver = createDesktopWorkflowDriver({ service: fake.service });
    await assert.rejects(driver.execute({ id: 'click', action: 'click', target } as any, {}, 100), /target_invalid/);
    assert.equal(fake.calls.some(call => call.method === 'click'), false);
  }
});

test('wait false becomes timeout and action timeout control is bounded and reset', async () => {
  const fake = fakeService(); const driver = createDesktopWorkflowDriver({ service: fake.service });
  fake.setWaitResult(false);
  await assert.rejects(driver.wait({ id: 'wait', action: 'wait', condition: 'visible', target } as any, {}, 100), /timeout/);
  driver.setActionTimeout(9_000);
  assert.equal(fake.calls.at(-1)?.args[0], 5_000);
  await driver.execute({ id: 'click', action: 'click', target } as any, {}, 400);
  assert.deepEqual(fake.calls.filter(call => call.method === 'setTimeout').slice(-2).map(call => call.args[0]), [400, 5_000]);
  driver.cleanup();
  assert.equal(fake.calls.at(-1)?.args[0], undefined);
});

test('wait honors budgets beyond one service chunk and times out at the overall deadline', async () => {
  const fake = fakeService(); const driver = createDesktopWorkflowDriver({ service: fake.service });
  fake.setWaitHandler(async () => fake.calls.filter(call => call.method === 'waitFor').length > 1);
  await driver.wait({ id: 'wait', action: 'wait', condition: 'visible', target } as any, {}, 12_000);
  const longWaits = fake.calls.filter(call => call.method === 'waitFor');
  assert.equal(longWaits.length, 2);
  assert.deepEqual(longWaits.map(call => call.args[2]), [10_000, 10_000]);

  fake.calls.length = 0;
  fake.setWaitHandler(async () => false);
  const started = Date.now();
  await assert.rejects(driver.wait({ id: 'wait', action: 'wait', condition: 'visible', target } as any, {}, 35), /timeout/);
  assert.ok(Date.now() - started < 250, 'wait stops near the supplied overall timeout');
  assert.ok(fake.calls.filter(call => call.method === 'waitFor').every(call => (call.args[2] as number) <= 35));
  assert.equal(fake.calls.at(-1)?.method, 'setTimeout');
  assert.equal(fake.calls.at(-1)?.args[0], 5_000, 'wait restores the previous request bound');
});

test('assertion and wait requests use their budgets and restore action timeout on errors', async () => {
  const fake = fakeService(); const driver = createDesktopWorkflowDriver({ service: fake.service });
  driver.setActionTimeout(2_000);
  fake.calls.length = 0;
  await driver.assert({ condition: 'visible', target } as any, {}, 40);
  assert.deepEqual(fake.calls.filter(call => call.method === 'setTimeout').map(call => call.args[0]), [40, 2_000]);

  fake.calls.length = 0;
  fake.setWaitHandler(async () => { throw Error('injected wait failure'); });
  await assert.rejects(driver.wait({ id: 'wait', action: 'wait', condition: 'visible', target } as any, {}, 25), /injected wait failure/);
  assert.deepEqual(fake.calls.filter(call => call.method === 'setTimeout').map(call => call.args[0]), [25, 2_000]);

  fake.calls.length = 0;
  fake.setWaitHandler(async () => false);
  await assert.rejects(driver.wait({ id: 'wait', action: 'wait', condition: 'visible', target } as any, {}, 30), /timeout/);
  assert.equal(fake.calls.at(-1)?.args[0], 2_000);
  driver.cleanup();
});
