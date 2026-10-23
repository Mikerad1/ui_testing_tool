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

test('desktop config validates command arrays and rejects unsupported options', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umb-desktop-config-'));
  const file = path.join(root, 'umb.config.yaml');
  const prefix = 'version: 1\nproject: {id: demo, name: Demo, base_url: http://127.0.0.1:3000}\n';
  try {
    await writeFile(file, `${prefix}desktop:\n  enabled: true\n  automation:\n    binary_path: src-tauri/target/debug/demo\n  build_command:\n    command: cargo\n    args: [tauri, build, --debug]\n`);
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
