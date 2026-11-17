import { request } from 'node:http';
import { GpuSectionSchema, type GpuSection } from '@observatory/contracts';

const MAX_RESPONSE_BYTES = 16 * 1024;

/** Read one fixed snapshot from the local privileged helper's Unix socket. */
export function readGpuHelperSnapshot(
  socketPath: string,
  signal: AbortSignal
): Promise<GpuSection> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/snapshot', method: 'GET', signal }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GPU-Helfer antwortet mit Status ${response.statusCode ?? 0}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('GPU-Helfer-Antwort ist zu groß'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(GpuSectionSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        } catch {
          reject(new Error('GPU-Helfer-Antwort verletzt den Datenvertrag'));
        }
      });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
