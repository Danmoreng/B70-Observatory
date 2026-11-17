/**
 * Strict, dependency-free validation of agent-provided image content.
 *
 * The runner is the only authority that persists image binaries. Everything
 * arriving from the sandbox (browser screenshots, image reads) is re-checked
 * here: format magic bytes, real decoded dimensions, pixel bounds and byte
 * budget. Malformed or oversized content is rejected with an honest reason
 * instead of being stored or shown as a successful image.
 *
 * PNG is validated as a real decoder would: every chunk (type, bounds, CRC),
 * the legal bit-depth/color-type combinations, the palette rule and the
 * actual IDAT payload inflated to the exact declared scanline size. A file
 * whose pixels do not decode is rejected, never accepted on header alone.
 */

import { inflateSync } from 'node:zlib';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_WIDTH = 1920;
export const MAX_IMAGE_HEIGHT = 8192;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
/** Bounded before any allocation: matches the runner RPC record bound. */
const MAX_BASE64_CHARS = 8 * 1024 * 1024;

export type AgentImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export type ImageValidation =
  | { ok: true; mimeType: AgentImageMime; width: number; height: number; byteLength: number }
  | { ok: false; reason: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    value = CRC_TABLE[(value ^ data[i]!) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Legal combinations per PNG color type: 0 grayscale, 2 truecolor, 3 indexed,
 * 4 grayscale+alpha, 6 truecolor+alpha. Returns the channel count, or
 * undefined for an illegal combination.
 */
function pngChannels(colorType: number, bitDepth: number): number | undefined {
  switch (colorType) {
    case 0:
      return [1, 2, 4, 8, 16].includes(bitDepth) ? 1 : undefined;
    case 2:
      return [8, 16].includes(bitDepth) ? 3 : undefined;
    case 3:
      return [1, 2, 4, 8].includes(bitDepth) ? 1 : undefined;
    case 4:
      return [8, 16].includes(bitDepth) ? 2 : undefined;
    case 6:
      return [8, 16].includes(bitDepth) ? 4 : undefined;
    default:
      return undefined;
  }
}

function pngDimensions(data: Buffer): { width: number; height: number } | string {
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (data[i] !== PNG_SIGNATURE[i]) return 'PNG signature missing.';
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let channels = 0;
  let sawIhdr = false;
  let sawIend = false;
  let sawIdat = false;
  let sawPlte = false;
  let plteLength = 0;
  const idatParts: Buffer[] = [];
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (offset + 12 + length > data.length) {
      return 'PNG chunk extends beyond the end of the file.';
    }
    const type = data.subarray(offset + 4, offset + 8).toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(type)) return 'PNG chunk type is invalid.';
    const body = data.subarray(offset + 8, offset + 8 + length);
    const storedCrc = data.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([data.subarray(offset + 4, offset + 8), body])) !== storedCrc) {
      return 'PNG chunk CRC is corrupt.';
    }
    if (!sawIhdr && type !== 'IHDR') return 'PNG IHDR must be the first chunk.';
    switch (type) {
      case 'IHDR':
        if (length !== 13) return 'PNG IHDR chunk is malformed.';
        sawIhdr = true;
        width = body.readUInt32BE(0);
        height = body.readUInt32BE(4);
        bitDepth = body[8]!;
        colorType = body[9]!;
        channels = pngChannels(colorType, bitDepth) ?? 0;
        if (channels === 0) {
          return 'PNG has an unsupported bit depth and color type combination.';
        }
        break;
      case 'PLTE':
        if (sawPlte) return 'PNG has multiple PLTE chunks.';
        sawPlte = true;
        plteLength = length;
        break;
      case 'IDAT':
        sawIdat = true;
        idatParts.push(body);
        break;
      case 'IEND':
        if (length !== 0) return 'PNG IEND chunk is malformed.';
        sawIend = true;
        offset += 12 + length;
        break;
      default:
        // Ancillary (lowercase) and tRNS chunks are legal and skipped.
        if (type[0] !== undefined && type[0] >= 'A' && type[0] <= 'Z' && type !== 'tRNS') {
          return `PNG contains the unsupported critical chunk ${type}.`;
        }
        break;
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (sawIend && offset + 8 <= data.length) return 'PNG contains data after IEND.';
  if (!sawIhdr) return 'PNG is missing its IHDR chunk.';
  if (!sawIend) return 'PNG is missing its terminating IEND chunk.';
  if (!sawIdat) return 'PNG is missing its IDAT image data.';
  if (colorType === 3 && (plteLength % 3 !== 0 || plteLength < 3 || plteLength > 768)) {
    return 'PNG palette is invalid.';
  }
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const expected = height * (1 + stride);
  if (expected > 32 * 1024 * 1024) {
    return 'PNG decoded size exceeds the fixed limit.';
  }
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idatParts));
  } catch {
    return 'PNG IDAT stream does not decode.';
  }
  if (inflated.length !== expected) {
    return 'PNG IDAT stream does not match the declared dimensions.';
  }
  return { width, height };
}

function jpegDimensions(data: Buffer): { width: number; height: number } | string {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return 'JPEG signature missing.';
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return 'JPEG stream is not marker-structured.';
    const marker = data[offset + 1];
    if (marker === undefined) return 'JPEG stream is truncated.';
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Stand-alone markers without a length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) {
      return 'JPEG segment is malformed.';
    }
    // Baseline (SOF0) and progressive (SOF2) frames carry the dimensions.
    if ((marker === 0xc0 || marker === 0xc2) && offset + 2 + 7 <= data.length) {
      const height = data.readUInt16BE(offset + 2 + 3);
      const width = data.readUInt16BE(offset + 2 + 5);
      return { width, height };
    }
    if (marker === 0xda) break; // start of scan: dimensions must precede it
    offset += 2 + length;
  }
  return 'JPEG frame dimensions were not found.';
}

function webpDimensions(data: Buffer): { width: number; height: number } | string {
  if (
    data.length < 30 ||
    data.toString('latin1', 0, 4) !== 'RIFF' ||
    data.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    return 'WebP signature missing.';
  }
  const riffSize = data.readUInt32LE(4);
  if (riffSize !== data.length - 8) return 'WebP RIFF size does not match the file.';
  const format = data.toString('latin1', 12, 16);
  const chunkSize = data.readUInt32LE(16);
  if (20 + chunkSize > data.length) return 'WebP chunk extends beyond the file end.';
  if (format === 'VP8 ') {
    // RFC 6386 section 9.1: bit 0 is frame type (0 = key frame), then the real
    // start code 0x9D 0x01 0x2A, then 14-bit width/height each.
    if (chunkSize < 10) return 'WebP VP8 header is malformed.';
    const start = 20;
    const tag = data.readUIntLE(start, 3);
    if ((tag & 1) !== 0) return 'WebP VP8 frame is not a key frame.';
    if (data[start + 3] !== 0x9d || data[start + 4] !== 0x01 || data[start + 5] !== 0x2a) {
      return 'WebP VP8 header is malformed.';
    }
    const width = data.readUInt16LE(start + 6) & 0x3fff;
    const height = data.readUInt16LE(start + 8) & 0x3fff;
    return { width, height };
  }
  if (format === 'VP8L') {
    // Signature byte and the packed 14-bit dimensions start at offset 20.
    if (chunkSize < 5 || data[20] !== 0x2f) return 'WebP VP8L header is malformed.';
    const bits = data.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (format === 'VP8X') {
    // Version, flags, two reserved bytes, then 24-bit width-1 and height-1.
    if (chunkSize < 10) return 'WebP VP8X header is malformed.';
    const width = data.readUIntLE(24, 3) & 0xffffff;
    const height = data.readUIntLE(27, 3) & 0xffffff;
    return { width: width + 1, height: height + 1 };
  }
  return 'WebP format is unsupported.';
}

/**
 * Strictly decodes a base64 payload. The alphabet and padding are enforced,
 * the length is bounded before any allocation, and the canonical round trip
 * is checked so a string that does not re-encode identically is rejected.
 */
export function decodeStrictBase64(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined;
  if (value.length > MAX_BASE64_CHARS) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0) return undefined;
  if (decoded.toString('base64') !== value) return undefined;
  return decoded;
}

/** Validates one agent-provided image against the fixed byte/pixel policy. */
export function validateAgentImage(mimeType: string, data: Buffer): ImageValidation {
  const byteLength = data.length;
  if (byteLength === 0) return { ok: false, reason: 'Image payload is empty.' };
  if (byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `Image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MiB limit.` };
  }
  let dimensions: { width: number; height: number } | string;
  let mime: AgentImageMime | undefined;
  if (mimeType === 'image/png') {
    dimensions = pngDimensions(data);
    mime = 'image/png';
  } else if (mimeType === 'image/jpeg') {
    dimensions = jpegDimensions(data);
    mime = 'image/jpeg';
  } else if (mimeType === 'image/webp') {
    dimensions = webpDimensions(data);
    mime = 'image/webp';
  } else {
    return { ok: false, reason: `Image format ${mimeType} is not supported.` };
  }
  if (typeof dimensions === 'string') return { ok: false, reason: dimensions };
  if (dimensions.width < 1 || dimensions.height < 1) {
    return { ok: false, reason: 'Image dimensions are not positive.' };
  }
  if (dimensions.width > MAX_IMAGE_WIDTH || dimensions.height > MAX_IMAGE_HEIGHT) {
    return {
      ok: false,
      reason: `Image dimensions exceed the ${MAX_IMAGE_WIDTH}×${MAX_IMAGE_HEIGHT} limit.`,
    };
  }
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    return { ok: false, reason: 'Image pixel count exceeds the fixed limit.' };
  }
  return {
    ok: true,
    mimeType: mime,
    width: dimensions.width,
    height: dimensions.height,
    byteLength,
  };
}
