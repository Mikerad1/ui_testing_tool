import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { comparePngs } from '../src/desktop/png-diff.js';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const content = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  content.copy(result, 4);
  result.writeUInt32BE(crc32(content), 8 + data.length);
  return result;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function png(width: number, height: number, colorType: 2 | 6, values: number[], filters = Array(height).fill(0)): Buffer {
  const channels = colorType === 2 ? 3 : 4, rows: Buffer[] = [];
  let previous = Buffer.alloc(width * channels);
  for (let y = 0; y < height; y++) {
    const raw = Buffer.from(values.slice(y * width * channels, (y + 1) * width * channels));
    const filter = filters[y]!;
    const encoded = Buffer.alloc(raw.length + 1); encoded[0] = filter;
    for (let i = 0; i < raw.length; i++) {
      const left = i >= channels ? raw[i - channels]! : 0, up = previous[i]!;
      const upperLeft = i >= channels ? previous[i - channels]! : 0;
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : 0;
      encoded[i + 1] = (raw[i]! - predictor + 256) & 0xff;
    }
    rows.push(encoded); previous = raw;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = colorType;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

function rawPng(width: number, height: number, colorType: number, bitDepth: number, interlace: number, scanlines: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = bitDepth; header[9] = colorType; header[12] = interlace;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

test('identical RGB and RGBA PNGs produce zero changed pixels and a PNG diff', () => {
  for (const image of [png(2, 1, 2, [10, 20, 30, 40, 50, 60]), png(1, 1, 6, [10, 20, 30, 40])]) {
    const result = comparePngs(image, image);
    assert.equal(result.metrics.changedPixels, 0);
    assert.equal(result.metrics.changedPercent, 0);
    assert.equal(result.metrics.dimensionMismatch, false);
    assert.deepEqual(result.diff.subarray(0, 8), signature);
  }
});

test('counts pixels whose maximum absolute channel delta exceeds the threshold', () => {
  const before = png(2, 1, 6, [0, 0, 0, 255, 0, 0, 0, 255]);
  const after = png(2, 1, 6, [3, 0, 0, 255, 5, 0, 0, 255]);
  const result = comparePngs(before, after, { threshold: 3 });
  assert.equal(result.metrics.changedPixels, 1);
  assert.equal(result.metrics.changedPercent, 50);
  assert.equal(result.metrics.threshold, 3);
  assert.throws(() => comparePngs(before, after, { threshold: 1.5 }), /threshold/);
  assert.equal(comparePngs(before, after, { threshold: 5 }).metrics.changedPixels, 0);
});

test('dimension mismatch compares on the max canvas with missing pixels treated as opaque black', () => {
  const before = png(1, 1, 2, [0, 0, 0]);
  const after = png(2, 1, 2, [0, 0, 0, 1, 0, 0]);
  const result = comparePngs(before, after);
  assert.deepEqual(result.metrics.before, { width: 1, height: 1 });
  assert.deepEqual(result.metrics.after, { width: 2, height: 1 });
  assert.equal(result.metrics.dimensionMismatch, true);
  assert.equal(result.metrics.changedPixels, 1);
  assert.equal(result.metrics.pixelCount, 2);
});

test('decodes PNG filters 0 through 4', () => {
  const pixels = Array.from({ length: 5 * 2 * 3 }, (_, index) => (index * 37) % 256);
  const filtered = png(2, 5, 2, pixels, [0, 1, 2, 3, 4]);
  assert.equal(comparePngs(filtered, filtered).metrics.changedPixels, 0);
});

test('rejects invalid signatures, chunk CRCs, trailing bytes, and oversized input', () => {
  const valid = png(1, 1, 2, [1, 2, 3]);
  const badCrc = Buffer.from(valid); badCrc[badCrc.length - 5] ^= 1;
  assert.throws(() => comparePngs(badCrc, valid), /CRC/);
  assert.throws(() => comparePngs(Buffer.alloc(8), valid), /signature/);
  assert.throws(() => comparePngs(Buffer.concat([valid, Buffer.from([0])]), valid), /Trailing/);
  assert.throws(() => comparePngs(Buffer.alloc(8 * 1024 * 1024 + 1), valid), /8 MiB/);
  assert.throws(() => comparePngs(valid, valid, { maxDiffBytes: 1 }), /diff exceeds/);
});

test('rejects PNGs with more than 4096 chunks', () => {
  const valid = png(1, 1, 2, [1, 2, 3]);
  // The base PNG has three chunks; add 4094 valid ancillary chunks for a total of 4097.
  const overLimit = Buffer.concat([
    valid.subarray(0, 33),
    ...Array.from({ length: 4094 }, () => chunk('tEXt', Buffer.alloc(0))),
    valid.subarray(33),
  ]);
  assert.throws(() => comparePngs(overLimit, valid), /PNG chunk count exceeds 4096/);
});

test('rejects malformed scanlines and unsupported PNG encodings', () => {
  const tooShort = rawPng(1, 1, 2, 8, 0, Buffer.from([0, 1, 2]));
  const badFilter = rawPng(1, 1, 2, 8, 0, Buffer.from([5, 1, 2, 3]));
  assert.throws(() => comparePngs(tooShort, tooShort), /length mismatch/);
  assert.throws(() => comparePngs(badFilter, badFilter), /row filter/);
  for (const image of [
    rawPng(1, 1, 2, 16, 0, Buffer.from([0])),
    rawPng(1, 1, 0, 8, 0, Buffer.from([0])),
    rawPng(1, 1, 2, 8, 1, Buffer.from([0])),
  ]) assert.throws(() => comparePngs(image, image), /Unsupported|Interlaced/);
});

test('rejects dimensions and comparison canvases over bounds', () => {
  const tooWide = rawPng(8193, 1, 2, 8, 0, Buffer.from([0]));
  assert.throws(() => comparePngs(tooWide, tooWide), /dimensions/);
  const nearLimit = rawPng(4096, 2049, 2, 8, 0, Buffer.from([0]));
  assert.throws(() => comparePngs(nearLimit, nearLimit), /pixel count/);
});
