import type { Store } from '../memory/store.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safePath as safeProjectPath } from '../config/config.js';
import { normalizeLocator } from '../knowledge/locator-proposals.js';
import { parseStoredWorkflowDocument, type WorkflowAssertion, type WorkflowDocument, type WorkflowStep, type WorkflowTarget } from './contract.js';

const literal=(value:unknown)=>JSON.stringify(value);
const screenKey=(value:string)=>value.replace(/^screen:/,'');
const variableRef=/^\$\{\{\s*variables\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
function baseUrl(input:string):URL {
 let url:URL;try{url=new URL(input);}catch{throw Error('Workflow export requires a valid configured base URL');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Unsafe application base URL for workflow export');
 return url;
}
function safeNavigationPath(input:string,base:URL):string {
 if(!input.startsWith('/')||input.startsWith('//')||input.includes('\\')||/[?#\u0000-\u001f\u007f]/.test(input)||/%(?:2f|5c)/i.test(input))throw Error('Unsafe workflow URL path');
 let decoded:string;try{decoded=decodeURIComponent(input);}catch{throw Error('Malformed workflow URL path');}
 if(decoded.split('/').some(part=>part==='..')||decoded.includes('\\'))throw Error('Unsafe workflow URL path');
 const resolved=new URL(input,base);if(resolved.origin!==base.origin||resolved.search||resolved.hash)throw Error('Workflow navigation escapes the application origin');
 return resolved.toString();
}
function runtimeValue(value:string,workflow:WorkflowDocument):string {
 const match=variableRef.exec(value);if(!match)return literal(value);
 const declaration=workflow.variables?.[match[1]!];if(!declaration)throw Error('Undeclared workflow variable');
 return `requiredEnv(${literal(declaration.from_env)})`;
}
function safeUrlMatch(value:string):string{if(/[?#\u0000-\u001f\u007f]/.test(value)||/^[a-z][a-z\d+.-]*:/i.test(value)||value.startsWith('//'))throw Error('Unsafe workflow URL assertion');return value;}
function locatorExpression(target:WorkflowTarget,store:Store):string {
 let locator:any=target;
 if('screen'in target){
  const sid=screenKey(target.screen),key=`screen:${sid}/${target.element}`;
  const node=store.getByTypeKey('ui_element',key) as any;
  if(!node||node.origin!=='yaml'||node.conflict_status!=='none'||node.tombstone)throw Error(`Workflow target is not an active conflict-free YAML locator: ${sid}/${target.element}`);
  try{const current=normalizeLocator(JSON.parse(node.attributes_json).locator);locator=store.inactiveWorkflowLocator({screenId:sid,elementId:target.element,currentLocator:current})??current;}catch{throw Error('Malformed current YAML locator');}
 }
 if(!locator||typeof locator!=='object'||Array.isArray(locator))throw Error('Unsupported workflow locator');
 const value=(input:unknown)=>{if(typeof input!=='string'||input.length<1||input.length>1000)throw Error('Malformed workflow locator value');return literal(input);};
 switch(locator.by){
   case'role':if(typeof locator.role!=='string'||!locator.role||locator.role.length>100)break;if(locator.name!==undefined&&(typeof locator.name!=='string'||locator.name.length>500))break;return `page.getByRole(${literal(locator.role)}, {exact:true${locator.name!==undefined?`,name:${literal(locator.name)}`:''}})`;
   case'label':return `page.getByLabel(${value(locator.value)},{exact:true})`;
   case'placeholder':return `page.getByPlaceholder(${value(locator.value)},{exact:true})`;
  case'test_id':return `page.getByTestId(${value(locator.value)})`;
   case'text':return `page.getByText(${value(locator.value)},{exact:true})`;
  case'css':return `page.locator(${value(locator.value)})`;
 }
 throw Error('Unsupported or malformed workflow locator');
}
function targetExpression(target:unknown,store:Store):string {
 if(typeof target==='string')throw Error('String targets are not supported for generated locators');
 if(!target||typeof target!=='object')throw Error('Workflow step requires a supported target');
 return locatorExpression(target as WorkflowTarget,store);
}
function assertionCode(assertion:WorkflowAssertion,store:Store,workflow:WorkflowDocument,indent='    ',timeout=5000):string {
 if(assertion.condition==='url_matches')return `${indent}await assertUrlIncludes(page, ${runtimeValue(safeUrlMatch(assertion.expected),workflow)}, ${timeout});`;
 const locator=targetExpression(assertion.target,store);
 switch(assertion.condition){
  case'visible':return `${indent}await assertVisible(${locator}, true, ${timeout});`;
  case'hidden':return `${indent}await assertVisible(${locator}, false, ${timeout});`;
  case'enabled':return `${indent}await assertEnabled(${locator}, ${timeout});`;
  case'present':return `${indent}await assertPresent(${locator}, ${timeout});`;
  case'count':return `${indent}await assertCount(${locator}, ${assertion.expected}, ${timeout});`;
  case'text':return `${indent}await assertText(${locator}, ${runtimeValue(assertion.expected,workflow)}, ${assertion.match==='exact'}, ${timeout});`;
  case'value':return `${indent}await assertValue(${locator}, ${runtimeValue(assertion.expected,workflow)}, ${assertion.match==='exact'}, ${timeout});`;
 }
}
function stepCode(step:WorkflowStep,store:Store,workflow:WorkflowDocument,base:URL):string {
 const locator='target'in step?targetExpression(step.target,store):undefined;
 switch(step.action){
   case'navigate':return `    await page.goto(${literal(safeNavigationPath(step.path,base))}, {timeout:${step.timeout_ms??30_000}});`;
   case'click':return `    await ${locator}.click({timeout:${step.timeout_ms??30_000}});`;
   case'fill':return `    await ${locator}.fill(${runtimeValue(step.value,workflow)}, {timeout:${step.timeout_ms??30_000}});`;
   case'type':return `    await ${locator}.type(${runtimeValue(step.value,workflow)}, {timeout:${step.timeout_ms??30_000}});`;
   case'press':return `    await ${locator}.press(${literal(step.key)}, {timeout:${step.timeout_ms??30_000}});`;
   case'select':return `    await ${locator}.selectOption(${runtimeValue(step.value,workflow)}, {timeout:${step.timeout_ms??30_000}});`;
  case'scroll':return `    await page.mouse.wheel(0, ${step.direction==='down'?1:-1} * ${step.amount??500});`;
   case'assert':return assertionCode(step,store,workflow,'    ',step.timeout_ms??30_000);
  case'wait':{
   let operation:string;
   if(step.condition==='url')operation=`await page.waitForURL(url => url.href.includes(${literal(safeUrlMatch(step.target as string))}), { timeout: ${step.timeout_ms??30_000} });`;
   else {
    const expression=targetExpression(step.target,store);
    if(step.condition==='visible'||step.condition==='hidden')operation=`await ${expression}.waitFor({ state: ${literal(step.condition)}, timeout: ${step.timeout_ms??30_000} });`;
    else if(step.condition==='enabled')operation=`await assertEnabled(${expression}, ${step.timeout_ms??30_000});`;
    else if(step.condition==='attached'||step.condition==='detached')operation=`await ${expression}.waitFor({ state: ${literal(step.condition)}, timeout: ${step.timeout_ms??30_000} });`;
    else throw Error('Unsupported workflow wait condition');
   }
   return `    await retryWait(${step.max_attempts??1}, async () => { ${operation} });`;
  }
 }
}
function screenRoute(store:Store,ref:string):string|undefined {
  const node=store.getByTypeKey('screen',screenKey(ref)) as any;if(!node||node.origin!=='yaml'||node.conflict_status!=='none'||node.tombstone)throw Error('Workflow screen reference is not current YAML data');
  let attrs:any;try{attrs=JSON.parse(node.attributes_json);}catch{throw Error('Malformed screen YAML metadata');}
  if(attrs.route!==undefined){if(typeof attrs.route!=='string'||!attrs.route.startsWith('/'))throw Error('Unsafe workflow screen route');return attrs.route;}
  const subject=store.applicationSubject() as any;let application=subject?store.get(subject.id) as any:undefined;
  if(application?.origin!=='yaml')application=store.db.prepare("SELECT * FROM nodes WHERE project_id=? AND environment=? AND type='application' AND origin='yaml' AND tombstone=0 ORDER BY id LIMIT 1").get(store.projectId,store.memoryEnvironment) as any;
  if(!application||application.origin!=='yaml')return undefined;
  try{const routes=JSON.parse(application.attributes_json).route_patterns;if(!Array.isArray(routes))return undefined;const route=routes.find((entry:any)=>entry&&screenKey(String(entry.screen??''))===screenKey(ref)&&typeof entry.path==='string');if(!route)return undefined;if(!route.path.startsWith('/'))throw Error('Unsafe workflow application route');return route.path;}catch(error){if(error instanceof Error&&/Unsafe workflow application route/.test(error.message))throw error;return undefined;}
}

export function generateWorkflowSpec(store:Store,workflowId:string,baseUrlValue:string,allowedOrigins:string[]=[]):string {
 const node=store.currentYamlWorkflow(workflowId);if(!node)throw Error('Workflow must be active, conflict-free YAML');
 if(!store.hasWorkflowExportVerification(workflowId))throw Error('Workflow has no verification for its current YAML content hash');
  let workflow:WorkflowDocument;try{workflow=parseStoredWorkflowDocument(JSON.parse(node.attributes_json));}catch{throw Error('Current workflow YAML is invalid');}
 if(workflow.id!==workflowId)throw Error('Workflow identity mismatch');
 if(workflow.requires)throw Error('Role/environment workflow requirements are unsupported by static export');
 const base=baseUrl(baseUrlValue);
 const allowedNavigationOrigins=[base.origin,...allowedOrigins.map(value=>{let url:URL;try{url=new URL(value);}catch{throw Error('Invalid configured navigation allowlist origin');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid configured navigation allowlist origin');return url.origin;})].filter((origin,index,all)=>all.indexOf(origin)===index).sort();
 const initialRoute=workflow.start_screen?screenRoute(store,workflow.start_screen):undefined;
 const lines=[
  `import { test } from 'node:test';`,
  `import assert from 'node:assert/strict';`,
   `import { chromium, firefox, webkit } from 'playwright';`,
 ];
  lines.push('',`const baseURL = ${literal(base.toString())};`,
   `const browserTypes = new Map([['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]);`,
   `const selectedEngine = process.env.UMB_PLAYWRIGHT_ENGINE ?? 'chromium';`,
   `const selectedBrowserType = browserTypes.get(selectedEngine);`,
   `if (!selectedBrowserType) throw new Error('Unsupported UMB_PLAYWRIGHT_ENGINE; use chromium, firefox, or webkit');`,
  `function requiredEnv(name: string): string { const value = process.env[name]; if (value === undefined) throw new Error('Missing required environment variable: ' + name); return value; }`,
  `const allowedNavigationOrigins = new Set(${literal(allowedNavigationOrigins)});`,
  `function isAllowedNavigationUrl(value: string): boolean { try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && allowedNavigationOrigins.has(url.origin); } catch { return false; } }`,
  `async function installNavigationGuard(context: any): Promise<void> { await context.route('**/*', async (route: any) => { const request = route.request(); if (!request.isNavigationRequest()) { await route.continue(); return; } try { if (!isAllowedNavigationUrl(request.url())) { await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Navigation denied' }); return; } const response = await route.fetch({ maxRedirects: 0 }); const status = response.status(); if (status >= 300 && status < 400) { const location = response.headers()['location']; if (!location) { await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Navigation denied' }); return; } let target: string; try { target = new URL(location, request.url()).toString(); } catch { await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Navigation denied' }); return; } if (!isAllowedNavigationUrl(target)) { await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Navigation denied' }); return; } } await route.fulfill({ response }); } catch { await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Navigation denied' }).catch(() => {}); } }); }`,
   `function isTimeoutError(error: unknown): boolean { return error instanceof Error && /timeout|timed out/i.test(error.name + ' ' + error.message); }`,
   `async function retryWait(maxAttempts: number, action: () => Promise<void>): Promise<void> { for (let attempt = 1; attempt <= maxAttempts; attempt++) { try { await action(); return; } catch (error) { if (!isTimeoutError(error) || attempt >= maxAttempts) throw error; } } }`,
  `async function poll(check: () => Promise<boolean>, timeout: number): Promise<void> { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } assert.fail('Workflow condition timed out'); }`,
  `async function assertVisible(locator: any, visible: boolean, timeout: number): Promise<void> { await assertCount(locator, 1, timeout); await locator.waitFor({ state: visible ? 'visible' : 'hidden', timeout }); }`,
  `async function assertCount(locator: any, count: number, timeout: number): Promise<void> { await poll(async () => await locator.count() === count, timeout); }`,
  `async function assertPresent(locator: any, timeout: number): Promise<void> { await poll(async () => await locator.count() > 0, timeout); }`,
  `async function assertEnabled(locator: any, timeout: number): Promise<void> { await assertCount(locator, 1, timeout); await poll(async () => locator.isEnabled(), timeout); }`,
  `async function assertValue(locator: any, expected: string, exact: boolean, timeout: number): Promise<void> { await assertCount(locator, 1, timeout); await poll(async () => { const actual = await locator.inputValue(); return exact ? actual === expected : actual.includes(expected); }, timeout); }`,
   `async function assertText(locator: any, expected: string, exact: boolean, timeout: number): Promise<void> { await assertCount(locator, 1, timeout); await poll(async () => { const actual = await locator.innerText(); return exact ? actual === expected : actual.includes(expected); }, timeout); }`,
  `async function assertUrlIncludes(page: any, expected: string, timeout: number): Promise<void> { await poll(async () => page.url().includes(expected), timeout); }`,
   `test(${literal(`workflow ${workflow.id}: ${workflow.name}`)}, async () => {`,`  const browser = await selectedBrowserType.launch();`,`  try {`,`    // Service-worker-dependent workflows require deliberate reviewed edits; workers are blocked to preserve the origin boundary.`,`    const context = await browser.newContext({ serviceWorkers: 'block' });`,`    await installNavigationGuard(context);`,`    const page = await context.newPage();`,`    await page.goto(${initialRoute?literal(safeNavigationPath(initialRoute,base)):'baseURL'});`);
  if(initialRoute)lines.push(`    assert.equal(new URL(page.url()).pathname, new URL(${literal(safeNavigationPath(initialRoute,base))}).pathname);`);
  for(const check of workflow.preconditions??[])lines.push(assertionCode(check,store,workflow));
  for(const step of workflow.steps)lines.push(stepCode(step,store,workflow,base));
  if(workflow.end_screen){const route=screenRoute(store,workflow.end_screen);if(route)lines.push(`    assert.equal(new URL(page.url()).pathname, new URL(${literal(safeNavigationPath(route,base))}).pathname);`);}
  lines.push(`    await context.close();`,`  } finally {`,`    await browser.close();`,`  }`,`});`,'');
 return lines.join('\n');
}

export async function writeWorkflowSpec(root:string,relativePath:string,contents:string):Promise<string>{
 if(typeof relativePath!=='string'||!relativePath||path.isAbsolute(relativePath)||path.win32.isAbsolute(relativePath)||relativePath.split(/[\\/]/).some(part=>!part||part==='..')||!relativePath.endsWith('.spec.ts'))throw Error('Output must be a project-relative .spec.ts path without traversal');
 await safeProjectPath(root,path.dirname(relativePath),false);
 const output=await safeProjectPath(root,relativePath,true);
 await writeFile(output,contents,{flag:'wx',mode:0o600});
 return output;
}
