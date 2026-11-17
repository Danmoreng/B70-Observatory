import { AGENT_MODEL_IMAGE_TARGET_BYTES, type AgentInputImage } from '@observatory/contracts';
import { t } from './i18n.js';

/** Original files have no configured byte/pixel cap. Only the model projection
 * is reduced to fit the existing vision/RPC transport; it never rejects a file
 * merely because its original or first encoded representation is too large.
 */
export async function prepareInputImage(file: File): Promise<AgentInputImage> {
  const mimeType = sourceMime(file);
  if (mimeType === undefined) throw new Error(t('agent.images.unsupported'));
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    const pixels = image.naturalWidth * image.naturalHeight;
    if (pixels === 0) throw new Error(t('agent.images.invalid'));
    const scale = Math.min(
      1,
      1920 / image.naturalWidth,
      8192 / image.naturalHeight,
      Math.sqrt(16_777_216 / pixels)
    );
    if (scale === 1 && file.size <= AGENT_MODEL_IMAGE_TARGET_BYTES) {
      return await encode(file, mimeType, file.name);
    }

    const canvas = document.createElement('canvas');
    let width = Math.max(1, Math.floor(image.naturalWidth * scale));
    let height = Math.max(1, Math.floor(image.naturalHeight * scale));
    // Re-render from the original at each size rather than accumulating losses.
    // Every failed quality pass shrinks the dimensions, down to a single pixel;
    // no fixed source-size limit or "still exceeds 1 MiB" rejection is needed.
    while (true) {
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error(t('agent.images.invalid'));
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      for (const [format, quality] of [
        ['image/png', undefined],
        ['image/jpeg', 0.9],
        ['image/jpeg', 0.75],
        ['image/jpeg', 0.55],
      ] as const) {
        const blob = await canvasBlob(canvas, format, quality);
        if (blob.size <= AGENT_MODEL_IMAGE_TARGET_BYTES) {
          return await encode(blob, format, file.name);
        }
      }
      if (width === 1 && height === 1) throw new Error(t('agent.images.invalid'));
      width = Math.max(1, Math.floor(width * 0.75));
      height = Math.max(1, Math.floor(height * 0.75));
    }
  } catch {
    throw new Error(t('agent.images.invalid'));
  } finally {
    image.src = '';
    URL.revokeObjectURL(url);
  }
}

function sourceMime(file: File): AgentInputImage['mimeType'] | undefined {
  if (file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp')
    return file.type;
  if (file.type !== '') return undefined;
  const extension = file.name.toLowerCase().split('.').at(-1);
  return extension === 'png'
    ? 'image/png'
    : extension === 'webp'
      ? 'image/webp'
      : ['jpg', 'jpeg'].includes(extension ?? '')
        ? 'image/jpeg'
        : undefined;
}

function canvasBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error(t('agent.images.invalid'))) : resolve(blob)),
      mimeType,
      quality
    );
  });
}

async function encode(
  blob: Blob,
  mimeType: AgentInputImage['mimeType'],
  name: string
): Promise<AgentInputImage> {
  const dataUrl = await readDataUrl(blob);
  return {
    mimeType,
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    label: name.trim().slice(0, 128) || 'Referenz',
  };
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error(t('agent.images.invalid')));
    reader.onerror = () => reject(new Error(t('agent.images.invalid')));
    reader.readAsDataURL(blob);
  });
}
