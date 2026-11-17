import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SpeechInput } from '@observatory/contracts';

const run = promisify(execFile);
export class SpeechBusyError extends Error {}
export class SpeechAudioError extends Error {}
export interface SpeechTranscriber {
  available(): boolean;
  transcribe(input: SpeechInput, signal?: AbortSignal): Promise<string>;
  close(): void;
}

/** Native CPU inference only. Recordings live in a private temporary directory. */
export function createSpeechTranscriber(executable: string, model: string): SpeechTranscriber {
  let busy = false;
  const shutdown = new AbortController();
  return {
    available() {
      try {
        accessSync(executable, constants.X_OK);
        accessSync(model, constants.R_OK);
        accessSync('/usr/bin/ffmpeg', constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    close() {
      shutdown.abort();
    },
    async transcribe(input, signal) {
      if (busy) throw new SpeechBusyError();
      busy = true;
      let directory: string | undefined;
      try {
        const data = Buffer.from(input.data, 'base64');
        if (data.toString('base64') !== input.data || data.length > 8 * 1024 * 1024)
          throw new SpeechAudioError();
        const combinedSignal = signal
          ? AbortSignal.any([signal, shutdown.signal])
          : shutdown.signal;
        combinedSignal.throwIfAborted();
        directory = await mkdtemp(join(tmpdir(), 'b70-dictation-'));
        const source = join(directory, 'recording');
        const pcmPath = join(directory, 'audio.pcm');
        const wavPath = join(directory, 'audio.wav');
        await writeFile(source, data, { mode: 0o600 });
        await run(
          '/usr/bin/ffmpeg',
          [
            '-nostdin',
            '-v',
            'error',
            '-protocol_whitelist',
            'file,pipe',
            '-i',
            source,
            '-t',
            '121',
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-threads',
            '2',
            '-f',
            's16le',
            pcmPath,
          ],
          { timeout: 20_000, maxBuffer: 1024 * 1024, signal: combinedSignal, killSignal: 'SIGKILL' }
        );
        const pcm = await readFile(pcmPath);
        if (pcm.length === 0 || pcm.length > 120 * 16000 * 2) throw new SpeechAudioError();
        const header = Buffer.alloc(44);
        header.write('RIFF');
        header.writeUInt32LE(36 + pcm.length, 4);
        header.write('WAVEfmt ', 8);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22);
        header.writeUInt32LE(16000, 24);
        header.writeUInt32LE(32000, 28);
        header.writeUInt16LE(2, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(pcm.length, 40);
        await writeFile(wavPath, Buffer.concat([header, pcm]), { mode: 0o600 });
        const { stdout } = await run(
          executable,
          [
            'transcribe',
            wavPath,
            '--model',
            model,
            '--device',
            'cpu',
            '--language',
            input.language,
            '--format',
            'text',
            '--no-warmup',
          ],
          {
            timeout: 90_000,
            maxBuffer: 1024 * 1024,
            signal: combinedSignal,
            killSignal: 'SIGKILL',
            env: { ...process.env, OMP_NUM_THREADS: '4', NO_COLOR: '1' },
          }
        );
        return stdout.trim().slice(0, 16_384);
      } finally {
        try {
          if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
          busy = false;
        }
      }
    },
  };
}
