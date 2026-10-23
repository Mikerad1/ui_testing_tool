import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageBundleToolCallResult, imageToolCallResult, MAX_MCP_IMAGE_BYTES, MAX_MCP_IMAGE_BUNDLE_BYTES } from '../src/mcp/image-content.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

test('MCP screenshot result contains a real PNG image block and concise metadata', () => {
  const result = imageToolCallResult({ ok: true, data: { kind: 'window', artifact_path: '.umb/artifacts/window.png' } }, png);
  assert.deepEqual(result.content.map(item => item.type), ['text', 'image']);
  const image = result.content[1];
  assert.equal(image?.type, 'image');
  if (image?.type !== 'image') return;
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(image.data, 'base64'), png);
  assert.equal((result.structuredContent.data as any).kind, 'window');
  assert.equal((result.structuredContent.image_delivery as any).status, 'included_in_mcp_result');
});

test('MCP screenshot fallback is explicit when disabled, oversized, or malformed', () => {
  const disabled = imageToolCallResult({ ok: true, data: { artifact_path: 'window.png' } }, png, { enabled: false });
  assert.equal((disabled.structuredContent.image_delivery as any).code, 'VISION_UNAVAILABLE');
  assert.deepEqual(disabled.content.map(item => item.type), ['text']);

  const large = imageToolCallResult({ ok: true }, Buffer.concat([png, Buffer.alloc(MAX_MCP_IMAGE_BYTES)]));
  assert.equal((large.structuredContent.image_delivery as any).code, 'image_payload_too_large');

  const malformed = imageToolCallResult({ ok: true }, Buffer.from('not an image'));
  assert.equal((malformed.structuredContent.image_delivery as any).code, 'invalid_png');
});

test('comparison image bundle includes all three images at the aggregate limit', () => {
  assert.equal(MAX_MCP_IMAGE_BUNDLE_BYTES, 6 * 1024 * 1024);
  const first = Buffer.from(png), second = Buffer.from(png), third = Buffer.alloc(MAX_MCP_IMAGE_BUNDLE_BYTES - first.length - second.length, 0);
  png.copy(third);
  const result = imageBundleToolCallResult({ ok: true, data: { comparison_id: 'cmp-1' } }, [{ name: 'baseline', bytes: first }, { name: 'after', bytes: second }, { name: 'diff', bytes: third }]);
  assert.equal(result.structuredContent.image_delivery.status, 'included_in_mcp_result');
  assert.equal(result.content.filter(item => item.type === 'image').length, 3);
});

test('comparison image bundle is artifact-only when disabled or aggregate bytes exceed 6 MiB', () => {
  const withinThird = Buffer.alloc(MAX_MCP_IMAGE_BUNDLE_BYTES - png.length * 2); png.copy(withinThird);
  const withinLimit = [{ name: 'baseline', bytes: png }, { name: 'after', bytes: png }, { name: 'diff', bytes: withinThird }];
  const disabled = imageBundleToolCallResult({ ok: true }, withinLimit, { enabled: false });
  assert.equal(disabled.structuredContent.image_delivery.status, 'artifact_only');
  assert.deepEqual(disabled.content.map(item => item.type), ['text']);

  const oversizedThird = Buffer.alloc(MAX_MCP_IMAGE_BUNDLE_BYTES - png.length * 2 + 1); png.copy(oversizedThird);
  const oversized = [{ name: 'baseline', bytes: png }, { name: 'after', bytes: png }, { name: 'diff', bytes: oversizedThird }];
  const fallback = imageBundleToolCallResult({ ok: true }, oversized);
  assert.equal(fallback.structuredContent.image_delivery.code, 'image_bundle_too_large');
  assert.deepEqual(fallback.content.map(item => item.type), ['text']);
});

test('comparison image bundle never returns a partial image set', () => {
  const invalid = imageBundleToolCallResult({ ok: true }, [{ name: 'baseline', bytes: png }, { name: 'after', bytes: Buffer.from('not png') }, { name: 'diff', bytes: png }]);
  assert.equal(invalid.structuredContent.image_delivery.status, 'artifact_only');
  assert.deepEqual(invalid.content.map(item => item.type), ['text']);
  assert.notEqual(invalid.structuredContent.image_delivery.status, 'included_in_mcp_result');
});
