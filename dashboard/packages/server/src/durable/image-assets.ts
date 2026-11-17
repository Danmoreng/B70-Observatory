import sharp from 'sharp';
import { validateAgentImage } from '@observatory/runner';

/** CPU-only derivatives: keep the original while bounding model input and web payloads. */
export async function createImageAssets(original: Buffer) {
  const convert = async (edge: number, quality: number) => {
    const { data, info } = await sharp(original, { limitInputPixels: 32 * 1024 * 1024 })
      .rotate()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, bytes: data.length };
  };
  const preview = await convert(1200, 78);
  const validation = validateAgentImage('image/webp', preview.data);
  if (!validation.ok) throw new Error('Image preview invalid: ' + validation.reason);
  const web = await convert(1920, 82);
  return { preview, web };
}
