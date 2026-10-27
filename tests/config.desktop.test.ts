import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/config.js';

test('desktop config is optional and disabled by default', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-config-'));
  const file = path.join(root, 'umb.config.yaml');
  try {
    await writeFile(file, 'version: 1\nproject: {id: demo, name: Demo, base_url: http://127.0.0.1:3000}\n');
    assert.equal((await loadConfig(file)).config.desktop, undefined);
    assert.equal((await loadConfig(file)).config.provider,'browser');

    await writeFile(file, 'version: 1\nproject: {id: demo, name: Demo, base_url: http://127.0.0.1:3000}\ndesktop: {}\n');
    const desktop = (await loadConfig(file)).config.desktop!;
    assert.equal(desktop.enabled, false);
    assert.equal(desktop.framework, 'tauri');
    assert.equal(desktop.automation.provider, 'tauri-driver');
    assert.equal(desktop.window.screenshot_mode, 'window');
    assert.equal(desktop.window.title, undefined);
    assert.equal(desktop.visual.return_mcp_images, true);
    assert.equal(desktop.visual.retain_artifacts_max_age_days, undefined);
    assert.equal(desktop.visual.capture_on_failure, false);
    assert.equal(desktop.visual.mask_selectors, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop mode is explicit and enforces attached/managed ownership configuration',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'umb-provider-config-')),file=path.join(root,'umb.config.yaml');
  const prefix='version: 1\nproject: {id: demo, name: Demo, base_url: http://127.0.0.1:3000}\nprovider: desktop\n';
  const attached=`${prefix}desktop:\n  mode: attached\n  automation:\n    endpoint: http://127.0.0.1:4444\n    session_id: operator-session\n`;
  const managed=`${prefix}desktop:\n  mode: managed\n`;
  try{
    await writeFile(file,attached);
    assert.equal((await loadConfig(file)).config.desktop?.mode,'attached');
    await writeFile(file,managed);
    assert.equal((await loadConfig(file)).config.desktop?.mode,'managed');
    await writeFile(file,`${prefix}desktop:\n  mode: managed\n  enabled: true\n  automation:\n    driver_path: /opt/tauri-driver\n    binary_path: target/demo\n`);
    assert.equal((await loadConfig(file)).config.desktop?.enabled,true);
    await writeFile(file,'version: 1\nproject: {id: demo, name: Demo, base_url: http://127.0.0.1:3000}\n');
    assert.equal((await loadConfig(file)).config.provider,'browser');
    for(const config of [
      `${prefix}desktop: {}\n`,
      `${prefix}desktop: {mode: invalid}\n`,
      `${prefix}desktop:\n  mode: attached\n  automation: {endpoint: http://127.0.0.1:4444}\n`,
      `${prefix}desktop:\n  mode: attached\n  automation: {session_id: operator-session}\n`,
      `${prefix}desktop:\n  mode: attached\n  enabled: true\n  automation: {endpoint: http://127.0.0.1:4444, session_id: operator-session}\n`,
      `${prefix}desktop:\n  mode: attached\n  automation: {endpoint: http://127.0.0.1:4444, session_id: operator-session, binary_path: target/demo}\n`,
      `${prefix}desktop:\n  mode: attached\n  build_command: {command: cargo}\n  automation: {endpoint: http://127.0.0.1:4444, session_id: operator-session}\n`,
      `${prefix}desktop:\n  mode: managed\n  automation: {endpoint: http://127.0.0.1:4444, session_id: operator-session}\n`,
      `${prefix}desktop: {mode: managed, enabled: true}\n`,
      `${prefix}desktop:\n  mode: managed\n  enabled: true\n  automation: {driver_path: /opt/tauri-driver}\n`,
      `${prefix}desktop:\n  mode: managed\n  enabled: true\n  automation: {binary_path: target/demo}\n`,
      `version: 1\nproject: {id: demo, name: Demo, base_url: http://127.0.0.1:3000}\ndesktop: {mode: managed}\n`,
      `version: 1\nproject: {id: demo, name: Demo, base_url: http://127.0.0.1:3000}\ndesktop: {enabled: true}\n`,
    ]){await writeFile(file,config);await assert.rejects(loadConfig(file));}
    await writeFile(file,`${prefix}desktop:\n  mode: attached\n  automation:\n    endpoint: http://localhost:4444\n    session_id: session\n`);
    await assert.rejects(loadConfig(file),/loopback origin/);
    for(const config of [
      `${prefix}desktop:\n  mode: attached\n  automation:\n    endpoint: http://127.0.0.1:4444/redirect\n    session_id: session\n`,
    ]){await writeFile(file,config);await assert.rejects(loadConfig(file));}
  }finally{await rm(root,{recursive:true,force:true});}
});

test('desktop config validates command arrays and rejects unsupported options', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-config-'));
  const file = path.join(root, 'umb.config.yaml');
  const prefix = 'version: 1\nproject: {id: demo, name: Demo, base_url: http://127.0.0.1:3000}\n';
  try {
    await writeFile(file, `${prefix}provider: desktop\ndesktop:\n  mode: managed\n  enabled: true\n  automation:\n    driver_path: /opt/tauri-driver\n    binary_path: src-tauri/target/debug/demo\n  build_command:\n    command: cargo\n    args: [tauri, build, --debug]\n`);
    const configured = (await loadConfig(file)).config.desktop!;
    assert.equal(configured.enabled, true);
    assert.deepEqual(configured.build_command?.args, ['tauri', 'build', '--debug']);
    assert.equal(configured.automation.binary_path, 'src-tauri/target/debug/demo');

    for (const invalid of [
      `${prefix}desktop: {enabled: "true"}\n`,
      `${prefix}desktop: {unknown: true}\n`,
      `${prefix}desktop: {automation: {provider: playwright}}\n`,
      `${prefix}desktop: {automation: {driver_path: tauri-driver}}\n`,
      `${prefix}desktop: {window: {screenshot_mode: desktop}}\n`,
      `${prefix}desktop: {build_command: {command: cargo, args: "tauri build"}}\n`,
      `${prefix}desktop: {visual: {retain_artifacts_max_age_days: 0}}\n`,
      `${prefix}desktop: {visual: {retain_artifacts_max_age_days: 3651}}\n`,
      `${prefix}desktop: {visual: {retain_artifacts_max_age_days: 1.5}}\n`,
      `${prefix}desktop: {visual: {capture_on_failure: "true"}}\n`,
      `${prefix}desktop: {visual: {mask_selectors: []}}\n`,
      `${prefix}desktop: {visual: {mask_selectors: ["#x", ""]}}\n`,
      `${prefix}desktop: {visual: {mask_selectors: ["#x".repeat(501)]}}\n`,
      `${prefix}desktop: {visual: {mask_selectors: [${Array.from({length: 21},()=>"'#x'").join(',')}]}}\n`,
      `${prefix}desktop: {visual: {mask_selectors: ["input:focus"]}}\n`,
      `${prefix}desktop: {visual: {mask_selectors: ["input:checked"]}}\n`,
      `${prefix}desktop: {visual: {mask_selectors: [".a + .b"]}}\n`,
      `${prefix}desktop: {visual: {mask_selectors: [".card:has(.x)"]}}\n`,
    ]) {
      await writeFile(file, invalid);
      await assert.rejects(loadConfig(file));
    }
    await writeFile(file, `${prefix}desktop: {visual: {mask_selectors: [".secret", "#account", "button", "*", "[data-private]", 'input[type="password"]']}}\n`);
    assert.deepEqual((await loadConfig(file)).config.desktop?.visual.mask_selectors, ['.secret', '#account', 'button', '*', '[data-private]', 'input[type="password"]']);
    await writeFile(file, `${prefix}desktop: {visual: {mask_selectors: ["input:focus"]}}\n`);
    await assert.rejects(loadConfig(file), /DOM-stable compound selector/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
