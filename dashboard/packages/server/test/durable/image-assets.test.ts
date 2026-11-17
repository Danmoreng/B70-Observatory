import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createImageAssets } from '../../src/durable/image-assets.js';
import { validateAgentImage } from '@observatory/runner';

it.each([
  [3552, 2368, 1200, 800, 1920, 1280],
  [2368, 3552, 800, 1200, 1280, 1920],
  [512, 512, 512, 512, 512, 512],
])(
  'creates readable and web-ready images from %i×%i without upscaling or changing the original',
  async (width, height, pw, ph, ww, wh) => {
    const original = await sharp({ create: { width, height, channels: 3, background: '#b43863' } })
      .png()
      .toBuffer();
    const before = Buffer.from(original);
    const assets = await createImageAssets(original);
    expect(original.equals(before)).toBe(true);
    expect(validateAgentImage('image/webp', assets.preview.data)).toMatchObject({
      ok: true,
      width: pw,
      height: ph,
    });
    expect(await sharp(assets.web.data).metadata()).toMatchObject({
      format: 'webp',
      width: ww,
      height: wh,
    });
    expect(assets.web.bytes).toBeLessThan(original.length);
    expect(assets.preview.bytes).toBeLessThan(2 * 1024 * 1024);
  }
);

it('rejects malformed images before writing any derivatives', async () => {
  await expect(createImageAssets(Buffer.from('not an image'))).rejects.toThrow();
});
