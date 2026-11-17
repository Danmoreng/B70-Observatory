import { deflateSync } from 'node:zlib';
import { ComfyImages } from '../../src/engine/comfy-images.js';

export const PREVIEW = Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
  'base64'
);
export function png(width: number, height: number) {
  const parts = [Buffer.from('89504e470d0a1a0a', 'hex')];
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    parts.push(size, body, checksum);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  chunk('IHDR', header);
  chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height)));
  chunk('IEND', Buffer.alloc(0));
  return Buffer.concat(parts);
}
export function comfyFixture() {
  const state = {
    submissions: 0,
    interrupted: 0,
    finished: true,
    id: '',
    graph: {} as Record<string, { inputs: Record<string, unknown> }>,
  };
  const fakeFetch: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    let value: unknown = {};
    const row = [0, 'prompt-1', state.graph];
    if (target.pathname === '/queue')
      value = {
        queue_running: state.submissions && !state.finished ? [row] : [],
        queue_pending: [],
      };
    if (target.pathname === '/prompt') {
      state.submissions++;
      state.graph = JSON.parse(String(init?.body)).prompt;
      state.id = String(state.graph['9']!.inputs.filename_prefix)
        .split('/')[1]!
        .replace('-native', '');
      value = { prompt_id: 'prompt-1' };
    }
    if (target.pathname.startsWith('/history'))
      value =
        state.finished && state.submissions
          ? {
              'prompt-1': {
                prompt: row,
                status: { status_str: 'success' },
                outputs: {
                  '9': {
                    images: [
                      {
                        type: 'output',
                        subfolder: 'DiffusionDesk',
                        filename: state.id + '-native_00001_.png',
                      },
                    ],
                  },
                  '12': {
                    images: [
                      {
                        type: 'output',
                        subfolder: 'DiffusionDesk',
                        filename: state.id + '-1536_00001_.png',
                      },
                    ],
                  },
                },
              },
            }
          : {};
    if (target.pathname === '/view')
      return new Response(target.searchParams.has('preview') ? PREVIEW : png(1536, 1024));
    if (target.pathname === '/interrupt') {
      state.interrupted++;
      state.finished = true;
    }
    return Response.json(value);
  };
  return { state, engine: new ComfyImages('http://127.0.0.1:1', fakeFetch) };
}
