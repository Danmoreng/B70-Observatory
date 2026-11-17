import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MODEL_IMAGE_TARGET_BYTES } from '@observatory/contracts';
import { prepareInputImage } from '../src/lib/input-images.js';
import { setLocale } from '../src/lib/i18n.js';

function browserFixture(width: number, height: number) {
  const decode = vi.fn(async () => {});
  const createObjectURL = vi.fn(() => 'blob:reference-fixture');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = width;
      naturalHeight = height;
      src = '';
      decode = decode;
    }
  );
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  return { decode, createObjectURL, revokeObjectURL, drawImage };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setLocale('en');
});

describe('unrestricted source reference images', () => {
  it('accepts originals beyond the old byte and pixel caps and keeps shrinking dense encodings until they fit', async () => {
    const fixture = browserFixture(12000, 8000);
    const dimensions: number[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback,
      type
    ) {
      dimensions.push(this.width);
      // Simulate a dense image for which all former quality attempts were too large.
      const size = this.width > 700 ? AGENT_MODEL_IMAGE_TARGET_BYTES + 1 : 100;
      callback(new Blob([new Uint8Array(size)], { type: type ?? 'image/png' }));
    });
    const file = new File(['source'], 'große-referenz.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 2 * 1024 * 1024 * 1024 });
    const prepared = await prepareInputImage(file);
    expect(prepared.label).toBe('große-referenz.png');
    expect(prepared.data.length).toBeLessThan(AGENT_MODEL_IMAGE_TARGET_BYTES);
    expect(dimensions[0]).toBe(1920);
    expect(dimensions.at(-1)).toBeLessThanOrEqual(700);
    expect(fixture.drawImage.mock.calls.length).toBeGreaterThan(1);
    expect(fixture.createObjectURL).toHaveBeenCalledWith(file);
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:reference-fixture');
  });
  it('keeps small images lossless and accepts a missing MIME type when the extension identifies the image', async () => {
    const fixture = browserFixture(100, 100);
    const file = new File(['original bytes'], 'Reference.PNG');
    const prepared = await prepareInputImage(file);
    expect(prepared.mimeType).toBe('image/png');
    expect(atob(prepared.data)).toBe('original bytes');
    expect(fixture.drawImage).not.toHaveBeenCalled();
    expect(fixture.revokeObjectURL).toHaveBeenCalled();
  });
  it('cleans up an unreadable original and reports a decoding error without a made-up size limit', async () => {
    const fixture = browserFixture(1, 1);
    fixture.decode.mockRejectedValue(new Error('Cannot decode'));
    await expect(
      prepareInputImage(new File(['bad'], 'bad.png', { type: 'image/png' }))
    ).rejects.toThrow('could not read');
    expect(fixture.revokeObjectURL).toHaveBeenCalled();
  });
  it('still explains unsupported formats', async () => {
    await expect(
      prepareInputImage(new File(['svg'], 'test.svg', { type: 'image/svg+xml' }))
    ).rejects.toThrow('PNG, JPEG or WebP');
  });
});
