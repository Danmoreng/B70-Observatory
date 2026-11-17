import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  decodeStrictBase64,
  validateAgentImage,
} from '../src/image-validation.js';

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
 * Builds a real decodable PNG: correct chunks with valid CRCs and an IDAT
 * stream that inflates to exactly the declared scanline size.
 */
function png(
  width: number,
  height: number,
  overrides: Partial<{ bitDepth: number; colorType: number; corruptIdat: boolean }> = {}
): Buffer {
  const chunks: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const push = (type: string, data: Buffer): void => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    chunks.push(length, body, crc);
  };
  const bitDepth = overrides.bitDepth ?? 8;
  const colorType = overrides.colorType ?? 6;
  const channels = colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 1;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  push('IHDR', ihdr);
  if (colorType === 3) {
    push('PLTE', Buffer.alloc(3));
  }
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const raw = Buffer.alloc(height * (1 + stride));
  push('IDAT', overrides.corruptIdat === true ? Buffer.from([0x78, 0x9c, 0x03]) : deflateSync(raw));
  push('IEND', Buffer.alloc(0));
  return Buffer.concat(chunks);
}

function jpeg(width: number, height: number): Buffer {
  const header = Buffer.alloc(2 + 2 + 2 + 7);
  header[0] = 0xff;
  header[1] = 0xd8;
  header[2] = 0xff;
  header[3] = 0xc0;
  header.writeUInt16BE(2 + 7, 4);
  header[6] = 8;
  header.writeUInt16BE(height, 7);
  header.writeUInt16BE(width, 9);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([header, eoi]);
}

function webpVp8L(width: number, height: number): Buffer {
  const riff = Buffer.alloc(30);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(22, 4);
  riff.write('WEBP', 8, 'latin1');
  riff.write('VP8L', 12, 'latin1');
  riff.writeUInt32LE(1 + 4, 16);
  riff[20] = 0x2f;
  const bits = ((height - 1) << 14) | (width - 1);
  riff.writeUInt32LE(bits, 21);
  riff.writeUInt32LE(0, 25);
  return riff;
}

function webpVp8X(width: number, height: number): Buffer {
  const riff = Buffer.alloc(30);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(22, 4);
  riff.write('WEBP', 8, 'latin1');
  riff.write('VP8X', 12, 'latin1');
  riff.writeUInt32LE(10, 16);
  riff.writeUInt32LE(0, 20);
  riff[24] = 0;
  riff.writeUIntLE(width - 1, 24, 3);
  riff.writeUIntLE(height - 1, 27, 3);
  return riff;
}

function webpVp8(width: number, height: number): Buffer {
  const riff = Buffer.alloc(40);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(32, 4);
  riff.write('WEBP', 8, 'latin1');
  riff.write('VP8 ', 12, 'latin1');
  riff.writeUInt32LE(20, 16);
  // RFC 6386: frame type bit 0 is clear for a key frame.
  riff.writeUIntLE(0, 20, 3);
  riff[23] = 0x9d;
  riff[24] = 0x01;
  riff[25] = 0x2a;
  riff.writeUInt16LE(width & 0x3fff, 26);
  riff.writeUInt16LE(height & 0x3fff, 28);
  return riff;
}

describe('agent image validation', () => {
  it('accepts a real VP8 WebP whose unrelated bit 10 is clear', () => {
    const image = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
    expect(validateAgentImage('image/webp', image)).toMatchObject({
      ok: true,
      width: 1,
      height: 1,
    });
  });
  it('accepts valid PNG/JPEG/WebP and reports the real dimensions', () => {
    expect(validateAgentImage('image/png', png(820, 1180))).toEqual({
      ok: true,
      mimeType: 'image/png',
      width: 820,
      height: 1180,
      byteLength: png(820, 1180).length,
    });
    // Grayscale, palette and grayscale+alpha combinations are legal PNGs.
    expect(validateAgentImage('image/png', png(100, 100, { colorType: 0 }))).toMatchObject({
      ok: true,
      width: 100,
      height: 100,
    });
    expect(validateAgentImage('image/png', png(100, 100, { colorType: 4 }))).toMatchObject({
      ok: true,
    });
    expect(
      validateAgentImage('image/png', png(10, 10, { colorType: 3, bitDepth: 4 }))
    ).toMatchObject({
      ok: true,
    });
    expect(
      validateAgentImage('image/png', png(50, 50, { bitDepth: 16, colorType: 2 }))
    ).toMatchObject({
      ok: true,
    });
    expect(validateAgentImage('image/jpeg', jpeg(640, 480))).toMatchObject({
      ok: true,
      width: 640,
      height: 480,
    });
    expect(validateAgentImage('image/webp', webpVp8L(300, 200))).toMatchObject({
      ok: true,
      width: 300,
      height: 200,
    });
    expect(validateAgentImage('image/webp', webpVp8(640, 360))).toMatchObject({
      ok: true,
      width: 640,
      height: 360,
    });
    expect(validateAgentImage('image/webp', webpVp8X(1920, 1080))).toMatchObject({
      ok: true,
      width: 1920,
      height: 1080,
    });
  });

  it('rejects foreign formats, broken structure and out-of-policy images', () => {
    expect(validateAgentImage('image/svg+xml', Buffer.from('<svg/>')).ok).toBe(false);
    expect(validateAgentImage('image/html', Buffer.from('<html/></html>')).ok).toBe(false);
    expect(validateAgentImage('image/png', Buffer.from('definitely not a png')).ok).toBe(false);
    const truncated = png(10, 10).subarray(0, 12);
    expect(validateAgentImage('image/png', truncated).ok).toBe(false);
    // Illegal bit depth / color type combinations (16-bit grayscale and
    // 16-bit truecolor are legal and accepted above).
    expect(validateAgentImage('image/png', png(10, 10, { bitDepth: 16, colorType: 3 })).ok).toBe(
      false
    );
    expect(validateAgentImage('image/png', png(10, 10, { bitDepth: 4, colorType: 2 })).ok).toBe(
      false
    );
    // A header without decodable IDAT must never be accepted as valid.
    expect(validateAgentImage('image/png', png(10, 10, { corruptIdat: true })).ok).toBe(false);
    const corruptCrc = png(10, 10);
    corruptCrc[corruptCrc.length - 1] = corruptCrc[corruptCrc.length - 1]! ^ 0xff;
    expect(validateAgentImage('image/png', corruptCrc).ok).toBe(false);
    expect(validateAgentImage('image/png', png(4000, 100))).toMatchObject({ ok: false });
    expect(validateAgentImage('image/png', png(10, 9000))).toMatchObject({ ok: false });
    const oversized = Buffer.concat([
      png(10, 10),
      Buffer.alloc(MAX_IMAGE_BYTES + 1 - png(10, 10).length),
    ]);
    expect(oversized.length).toBeGreaterThan(MAX_IMAGE_BYTES);
    expect(validateAgentImage('image/png', oversized)).toMatchObject({ ok: false });
    // WebP structure: wrong start code, broken RIFF size, non-key VP8 frame.
    const badStartCode = webpVp8(640, 360);
    badStartCode[23] = 0x30;
    expect(validateAgentImage('image/webp', badStartCode).ok).toBe(false);
    const badRiff = webpVp8L(300, 200);
    badRiff.writeUInt32LE(99, 4);
    expect(validateAgentImage('image/webp', badRiff).ok).toBe(false);
    const notKeyFrame = webpVp8(640, 360);
    notKeyFrame.writeUIntLE(1, 20, 3);
    expect(validateAgentImage('image/webp', notKeyFrame).ok).toBe(false);
  });

  it('strictly decodes base64 payloads', () => {
    const valid = png(1, 1).toString('base64');
    expect(decodeStrictBase64(valid)?.equals(png(1, 1))).toBe(true);
    expect(decodeStrictBase64('')).toBeUndefined();
    expect(decodeStrictBase64('a')).toBeUndefined();
    expect(decodeStrictBase64('abc')).toBeUndefined();
    expect(decodeStrictBase64('ab cd==')).toBeUndefined();
    expect(decodeStrictBase64('ab$c')).toBeUndefined();
    expect(decodeStrictBase64('abcd=')).toBeUndefined();
    // Mis-placed padding fails the canonical round trip.
    expect(decodeStrictBase64('a===')).toBeUndefined();
    expect(decodeStrictBase64('====')).toBeUndefined();
    // Bounded before decoding.
    expect(decodeStrictBase64('A'.repeat(8 * 1024 * 1024 + 4))).toBeUndefined();
  });
});
