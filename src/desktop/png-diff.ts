import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_SUPPORTED_PNG_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = MAX_SUPPORTED_PNG_BYTES;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 2_097_152;
const MAX_DECODED_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_PNG_CHUNKS = 4096;

export interface PngDimensions { width: number; height: number }
export interface PngDiffMetrics {
  before: PngDimensions;
  after: PngDimensions;
  width: number;
  height: number;
  pixelCount: number;
  dimensionMismatch: boolean;
  changedPixels: number;
  changedPercent: number;
  threshold: number;
}
export interface PngDiffResult { diff: Buffer; metrics: PngDiffMetrics }

interface DecodedPng extends PngDimensions { rgba: Buffer }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value++) {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePng(input: Buffer | Uint8Array): DecodedPng {
  if (input.byteLength > MAX_INPUT_BYTES) throw Error('PNG input exceeds 8 MiB.');
  const png = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw Error('Invalid PNG signature.');

  let offset = 8, width = 0, height = 0, channels = 0, colorType = -1;
  let sawHeader = false, sawPalette = false, sawData = false, dataEnded = false, sawEnd = false;
  const compressed: Buffer[] = [];
  let compressedBytes = 0;
  let chunkCount = 0;

  while (offset < png.length) {
    if (chunkCount >= MAX_PNG_CHUNKS) throw Error(`PNG chunk count exceeds ${MAX_PNG_CHUNKS}.`);
    chunkCount++;
    if (png.length - offset < 12) throw Error('Truncated PNG chunk.');
    const length = png.readUInt32BE(offset);
    const typeStart = offset + 4, dataStart = offset + 8;
    if (length > png.length - dataStart - 4) throw Error('Invalid PNG chunk length.');
    const crcOffset = dataStart + length, nextOffset = crcOffset + 4;
    const type = png.toString('ascii', typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2]!.toUpperCase()) throw Error('Invalid PNG chunk type.');
    if (crc32(png.subarray(typeStart, crcOffset)) !== png.readUInt32BE(crcOffset)) throw Error(`Invalid PNG ${type} CRC.`);
    if (!sawHeader && type !== 'IHDR') throw Error('PNG IHDR must be the first chunk.');
    if (sawData && type !== 'IDAT') dataEnded = true;

    if (type === 'IHDR') {
      if (sawHeader || length !== 13) throw Error('Invalid PNG IHDR.');
      width = png.readUInt32BE(dataStart); height = png.readUInt32BE(dataStart + 4);
      const bitDepth = png[dataStart + 8], compression = png[dataStart + 10], filterMethod = png[dataStart + 11], interlace = png[dataStart + 12];
      colorType = png[dataStart + 9]!;
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) throw Error('PNG dimensions exceed the 8192-pixel limit.');
      if (width * height > MAX_PIXELS) throw Error('PNG pixel count exceeds the limit.');
      if (bitDepth !== 8) throw Error('Unsupported PNG bit depth; only 8-bit samples are supported.');
      if (colorType !== 2 && colorType !== 6) throw Error('Unsupported PNG color type; only RGB and RGBA are supported.');
      if (compression !== 0 || filterMethod !== 0) throw Error('Unsupported PNG compression or filter method.');
      if (interlace !== 0) throw Error('Interlaced PNG is unsupported.');
      channels = colorType === 2 ? 3 : 4;
      sawHeader = true;
    } else if (type === 'PLTE') {
      if (sawPalette || sawData || !length || length > 768 || length % 3 !== 0) throw Error('Invalid PNG PLTE chunk.');
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (dataEnded) throw Error('PNG IDAT chunks must be consecutive.');
      sawData = true; compressedBytes += length;
      if (compressedBytes > MAX_INPUT_BYTES) throw Error('Compressed PNG data exceeds 8 MiB.');
      compressed.push(png.subarray(dataStart, crcOffset));
    } else if (type === 'IEND') {
      if (!sawData || length !== 0) throw Error('Invalid PNG IEND chunk.');
      sawEnd = true; offset = nextOffset;
      if (offset !== png.length) throw Error('Trailing bytes after PNG IEND.');
      break;
    } else {
      if (type === 'tRNS') throw Error('PNG tRNS transparency is unsupported.');
      if ((type.charCodeAt(0) & 0x20) === 0) throw Error(`Unsupported critical PNG chunk ${type}.`);
    }
    offset = nextOffset;
  }
  if (!sawHeader || !sawData || !sawEnd) throw Error('Incomplete PNG image.');

  const rowBytes = width * channels;
  const decodedLength = (rowBytes + 1) * height;
  const rgbaLength = width * height * 4;
  if (decodedLength > MAX_DECODED_BYTES || rgbaLength > MAX_DECODED_BYTES) throw Error('Decoded PNG exceeds 8 MiB.');
  let filtered: Buffer;
  try {
    filtered = inflateSync(Buffer.concat(compressed, compressedBytes), { maxOutputLength: decodedLength + 1 });
  } catch {
    throw Error('Invalid or oversized PNG image data.');
  }
  if (filtered.length !== decodedLength) throw Error('PNG decompressed length mismatch.');

  const rgba = Buffer.allocUnsafe(rgbaLength), previous = Buffer.alloc(rowBytes);
  let inputOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = filtered[inputOffset++]!;
    if (filter > 4) throw Error('Unsupported PNG row filter.');
    const row = filtered.subarray(inputOffset, inputOffset + rowBytes); inputOffset += rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= channels ? row[i - channels]! : 0;
      const up = previous[i]!;
      const upperLeft = i >= channels ? previous[i - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      row[i] = (row[i]! + predictor) & 0xff;
    }
    if (colorType === 6) row.copy(rgba, y * rowBytes);
    else {
      let dst = y * width * 4;
      for (let x = 0; x < width; x++) {
        const src = x * 3;
        rgba[dst++] = row[src]!; rgba[dst++] = row[src + 1]!; rgba[dst++] = row[src + 2]!; rgba[dst++] = 255;
      }
    }
    row.copy(previous);
  }
  return { width, height, rgba };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const result = Buffer.allocUnsafe(data.length + 12);
  result.writeUInt32BE(data.length, 0); result.write(type, 4, 4, 'ascii'); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
}

function encodeRgba(width: number, height: number, rgba: Buffer, maxBytes: number): Buffer {
  const rowBytes = width * 4, raw = Buffer.allocUnsafe((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1); raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const bytes = Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
  if (bytes.length > maxBytes) throw Error(`Generated PNG diff exceeds ${maxBytes} bytes.`);
  return bytes;
}

/** Pixel metrics describe change only. They do not establish whether a UI looks better. */
export function comparePngs(
  beforeBytes: Buffer | Uint8Array,
  afterBytes: Buffer | Uint8Array,
  options: { threshold?: number; maxDiffBytes?: number } = {},
): PngDiffResult {
  const threshold = options.threshold ?? 0, maxDiffBytes = options.maxDiffBytes ?? MAX_DIFF_BYTES;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw Error('threshold must be an integer from 0 to 255.');
  if (!Number.isInteger(maxDiffBytes) || maxDiffBytes < 1 || maxDiffBytes > MAX_DIFF_BYTES) throw Error('maxDiffBytes must be between 1 and 8388608.');
  const before = decodePng(beforeBytes), after = decodePng(afterBytes);
  const width = Math.max(before.width, after.width), height = Math.max(before.height, after.height), pixelCount = width * height;
  if (pixelCount > MAX_PIXELS || pixelCount * 4 > MAX_DECODED_BYTES) throw Error('Comparison canvas exceeds PNG limits.');
  const diff = Buffer.alloc(pixelCount * 4);
  let changedPixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inBefore = x < before.width && y < before.height, inAfter = x < after.width && y < after.height;
    const bi = inBefore ? (y * before.width + x) * 4 : -1, ai = inAfter ? (y * after.width + x) * 4 : -1;
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const b = inBefore ? before.rgba[bi + channel]! : channel === 3 ? 255 : 0;
      const a = inAfter ? after.rgba[ai + channel]! : channel === 3 ? 255 : 0;
      if (Math.abs(a - b) > threshold) changed = true;
    }
    if (changed) { changedPixels++; const i = (y * width + x) * 4; diff[i] = 255; diff[i + 3] = 255; }
  }
  return {
    metrics: {
      before: { width: before.width, height: before.height }, after: { width: after.width, height: after.height },
      width, height, pixelCount, dimensionMismatch: before.width !== after.width || before.height !== after.height,
      changedPixels, changedPercent: changedPixels / pixelCount * 100, threshold,
    },
    diff: encodeRgba(width, height, diff, maxDiffBytes),
  };
}

/** Validate the supported bounded PNG subset and return its dimensions. */
export function inspectPng(input: Buffer | Uint8Array): PngDimensions {
  const { width, height } = decodePng(input);
  return { width, height };
}
