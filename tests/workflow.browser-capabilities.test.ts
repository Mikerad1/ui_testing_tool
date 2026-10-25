import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowDocument } from '../src/workflow/contract.js';
import { createBrowserWorkflowDriver } from '../src/workflow/browser-driver.js';
import { isDesktopPressKeySupported } from '../src/browser/desktop-adapter.js';

const capabilities = { actions: ['click'], waits: ['visible'], assertions: ['text:exact'], locatorStrategies: ['css'], failureCapture: ['screenshot'], routeChecks: false } as const;
const expandedCapabilities = { actions: ['navigate','click','fill','type','press','select','scroll'], waits: ['visible'], assertions: ['text:exact'], locatorStrategies: ['css'], failureCapture: ['screenshot'], routeChecks: false, minimumStepTimeoutMs: 100, supportsPressKey: isDesktopPressKeySupported } as const;
function workflow(overrides: Record<string, unknown> = {}): WorkflowDocument {
  return { schema_version: 1, kind: 'workflow', id: 'narrow', name: 'narrow', steps: [
    { id: 'click', action: 'click', target: { by: 'css', value: '#go' } },
    { id: 'wait', action: 'wait', condition: 'visible', target: { by: 'css', value: '#done' } },
    { id: 'assert', action: 'assert', condition: 'text', match: 'exact', target: { by: 'css', value: '#status' }, expected: 'Ready' },
  ], ...overrides } as WorkflowDocument;
}
function driver() {
  const calls: string[] = [];
  const browser = { workflowCapabilities: capabilities, takeScreenshot: async (request: unknown) => { calls.push(JSON.stringify(request)); return { artifactPath: 'shot.png' }; } } as any;
  const value = createBrowserWorkflowDriver({ store: {} as any, browser, authorize: async () => undefined });
  return { value, calls };
}

test('restricted browser workflow preflight accepts only verified CSS workflow', () => {
  driver().value.validateWorkflow(workflow());
});

test('restricted workflow preflight rejects later unsupported operation before any execution', () => {
  const { value } = driver();
  const doc = workflow({ steps: [
    { id: 'click', action: 'click', target: { by: 'css', value: '#go' } },
    { id: 'bad', action: 'fill', target: { by: 'css', value: '#input' }, value: 'x' },
  ] });
  assert.throws(() => value.validateWorkflow(doc), (error: any) => error.code === 'capability_unavailable');
});

test('restricted workflow preflight separates CSS and semantic locators, checks preconditions and failure capture', () => {
  const { value } = driver();
  const unavailable = (error: any) => error.code === 'capability_unavailable';
  assert.throws(() => value.validateWorkflow(workflow({ steps: [{ id: 'click', action: 'click', target: { by: 'role', role: 'button' } }] })), unavailable);
  assert.throws(() => value.validateWorkflow(workflow({ preconditions: [{ condition: 'text', target: { by: 'css', value: '#status' }, expected: 'Ready', match: 'exact' }, { condition: 'visible', target: { by: 'css', value: '#x' } }] })), unavailable);
  assert.throws(() => value.validateWorkflow(workflow({ on_failure: { capture: ['screenshot', 'snapshot'], stop: true } })), unavailable);
  assert.throws(() => value.validateWorkflow(workflow({ on_failure: { capture: ['screenshot'], stop: true }, start_screen: 'home' })), unavailable);
  value.validateWorkflow(workflow({ preconditions: [{ condition: 'text', target: { by: 'css', value: '#status' }, expected: 'Ready', match: 'exact' }], on_failure: { capture: ['screenshot'], stop: true } }));
});

test('restricted desktop screenshot failure capture uses the webview VisualWorkflow request', async () => {
  const { value, calls } = driver();
  assert.deepEqual(await value.captureFailure!('screenshot'), { screenshot: 'shot.png', screenshot_status: 'captured' });
  assert.deepEqual(calls, ['{"kind":"webview"}']);
});

test('attached workflow beginRun does not call unsupported console diagnostics', () => {
  const browser = { workflowCapabilities: capabilities, consoleErrorCount: () => { throw new Error('unsupported'); } } as any;
  const value = createBrowserWorkflowDriver({ store: {} as any, browser, authorize: async () => undefined });
  assert.doesNotThrow(() => value.beginRun({ workflow: workflow(), workflowNodeId: 'node', workflowId: 'narrow', runId: 'run' }));
});

test('attached screenshot capture exposes cleanup failure with bounded status', async () => {
  for (const error of [
    new Error('cleanup_failed: private artifact detail'),
    new AggregateError([Error('result construction failed'), Error('EACCES: permission denied, unlink /PRIVATE/cleanup/path')], 'Screenshot result construction failed: result construction failed; persisted artifact cleanup failed: EACCES: permission denied, unlink /PRIVATE/cleanup/path'),
  ]) {
    const browser = { workflowCapabilities: capabilities, takeScreenshot: async () => { throw error; } } as any;
    const value = createBrowserWorkflowDriver({ store: {} as any, browser, authorize: async () => undefined });
    assert.deepEqual(await value.captureFailure!('screenshot'), { screenshot: null, screenshot_status: 'cleanup_failed' });
  }
});

test('attached workflow preflight and execution cover only native-verified schema actions', async () => {
  const calls:string[]=[],authorized:string[]=[];
  const browser={workflowCapabilities:expandedCapabilities,revision:0,navigate:async(path:string)=>{calls.push(`navigate:${path}`);return{};},act:async(action:string,_target:unknown,value?:string)=>{calls.push(`${action}:${value??''}`);return{};},type:async(_target:unknown,value:string)=>{calls.push(`type:${value}`);return{};},scroll:async(direction:string)=>{calls.push(`scroll:${direction}`);return{};}} as any;
  const value=createBrowserWorkflowDriver({store:{} as any,browser,authorize:async(action)=>{authorized.push(action);return undefined;}});
  const doc=workflow({steps:[
    {id:'nav',action:'navigate',path:'/next'},
    {id:'fill',action:'fill',target:{by:'css',value:'#input'},value:'filled'},
    {id:'type',action:'type',target:{by:'css',value:'#input'},value:'typed'},
    {id:'press',action:'press',target:{by:'css',value:'#input'},key:'ENTER'},
    {id:'select',action:'select',target:{by:'css',value:'#select'},value:'option'},
    {id:'scroll',action:'scroll',direction:'down',amount:50},
  ]});
  value.validateWorkflow(doc);
  for(const step of doc.steps)await value.execute(step as any,{},1000);
  assert.deepEqual(calls,['navigate:/next','fill:filled','type:typed','press:ENTER','select:option','scroll:down']);
  assert.deepEqual(authorized,['navigate','fill','type','press','select','scroll']);
});

test('attached workflow authorization failure blocks action effects', async () => {
  let mutations=0;
  const browser={workflowCapabilities:expandedCapabilities,revision:0,act:async()=>{mutations++;return{};}} as any;
  const value=createBrowserWorkflowDriver({store:{} as any,browser,authorize:async(action)=>{if(action==='fill')throw Error('approval_denied');return undefined;}});
  const step={id:'fill',action:'fill',target:{by:'css',value:'#input'},value:'sensitive'} as any;
  await assert.rejects(value.execute(step,{},1000),/approval_denied/);
  assert.equal(mutations,0);
});

test('attached preflight validates desktop press keys and timeout boundary before execution', () => {
  let executions = 0;
  const browser={workflowCapabilities:expandedCapabilities,revision:0,act:async()=>{executions++;return{};}} as any;
  const value=createBrowserWorkflowDriver({store:{} as any,browser,authorize:async()=>undefined});
  const press=(key:string,timeout_ms?:number)=>workflow({steps:[{id:'press',action:'press',target:{by:'css',value:'#input'},key,...(timeout_ms===undefined?{}:{timeout_ms})}]});
  value.validateWorkflow(press('ENTER'));
  value.validateWorkflow(press('x'));
  value.validateWorkflow(press('é'));
  value.validateWorkflow(press('x',100));
  const unavailable=(error:any)=>error.code==='capability_unavailable';
  for(const doc of [press('NOT_A_KEY'),press('ENTERX'),press('😀'),press('x',99)]) {
    assert.throws(()=>value.validateWorkflow(doc),unavailable);
    assert.equal(executions,0,'preflight rejection must happen before action execution');
  }
});
