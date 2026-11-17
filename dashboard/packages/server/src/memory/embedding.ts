import { assertMayStartWork } from '../durable/working-hours.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const EMBEDDING_FINGERPRINT =
  'embeddinggemma-2:68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216:768:mean:l2:search-prefix-v1:title160-text2400-v1';
export const MODEL_SHA256 = '68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216';
export interface MemoryEmbedder {
  ready(): boolean;
  visionReady?(): boolean;
  encodeImage?(data: Buffer): Promise<number[]>;
  encode(text: string, query: boolean): Promise<number[]>;
  close(): Promise<void>;
}
/** Trusted private CPU helper. No shell, network, model downloads or agent-supplied paths. */
export class CpuMemoryEmbedder implements MemoryEmbedder {
  private child?: ChildProcessWithoutNullStreams;
  private queue: Promise<unknown> = Promise.resolve();
  private verified = false;
  private idle?: ReturnType<typeof setTimeout>;
  private serial = 0;
  private active?: {
    id: number;
    resolve: (v: number[]) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private boot?: Promise<void>;
  private closed = false;
  private vision?: CpuMemoryEmbedder;
  constructor(
    private readonly binary: string,
    private readonly model: string,
    private readonly visionConfig?: { binary: string; projector: string },
    private readonly projector?: string
  ) {}
  ready(): boolean {
    return existsSync(this.binary) && existsSync(this.model);
  }
  visionReady(): boolean {
    return (
      !!this.visionConfig &&
      existsSync(this.visionConfig.binary) &&
      existsSync(this.visionConfig.projector)
    );
  }
  async encodeImage(data: Buffer): Promise<number[]> {
    if (this.closed || !this.visionReady()) throw new Error('CPU vision embedding is unavailable.');
    this.vision ??= new CpuMemoryEmbedder(
      this.visionConfig!.binary,
      this.model,
      undefined,
      this.visionConfig!.projector
    );
    const directory = await mkdtemp(join(tmpdir(), 'b70-memory-image-'));
    try {
      const path = join(directory, 'input');
      await writeFile(path, data, { mode: 0o600 });
      return await this.vision.run({ imagePath: path });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  encode(text: string, query: boolean): Promise<number[]> {
    return this.run({ text, query });
  }
  private run(payload: Record<string, unknown>): Promise<number[]> {
    const job = this.queue.then(async () => {
      assertMayStartWork();
      if (this.closed || !this.ready())
        throw new Error('CPU embedding runtime or verified model is unavailable.');
      if (this.idle) clearTimeout(this.idle);
      await this.start();
      return await new Promise<number[]>((resolve, reject) => {
        const id = ++this.serial;
        const timer = setTimeout(() => {
          this.stop(new Error('CPU embedding timed out.'));
        }, 30000);
        this.active = { id, resolve, reject, timer };
        this.child!.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
      }).finally(() => {
        this.idle = setTimeout(() => this.stop(new Error('CPU embedding idle.')), 120000);
        this.idle.unref();
      });
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
  private async start(): Promise<void> {
    if (this.child) return await this.boot;
    if (!this.verified) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(this.model)) hash.update(chunk as Buffer);
      if (hash.digest('hex') !== MODEL_SHA256)
        throw new Error('Embedding model checksum mismatch.');
      if (this.projector) {
        const projected = createHash('sha256');
        for await (const chunk of createReadStream(this.projector))
          projected.update(chunk as Buffer);
        if (
          projected.digest('hex') !==
          'd2033b3cd0223cfb2e7a2b50dc80a664c78c816d375f5b017ec3ef80ee0bc766'
        )
          throw new Error('Vision projector checksum mismatch.');
      }
      this.verified = true;
    }
    if (this.closed) throw new Error('Memory service closed.');
    const child = spawn(this.binary, [this.model, ...(this.projector ? [this.projector] : [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    this.child = child;
    child.stdin.on('error', () => this.stop(new Error('Embedding input closed.')));
    child.stderr.on('data', () => {}); // Internal native diagnostics never enter memory.
    this.boot = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('CPU embedding startup timed out.'));
        this.stop(new Error('Startup timed out.'));
      }, 30000);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        if (line.length > 65536) {
          this.stop(new Error('Invalid embedding response.'));
          return;
        }
        try {
          const value = JSON.parse(line) as {
            ready?: boolean;
            id?: number;
            embedding?: number[];
            error?: string;
          };
          if (value.ready) {
            clearTimeout(timer);
            resolve();
            return;
          }
          const active = this.active;
          if (!active || value.id !== active.id) return;
          clearTimeout(active.timer);
          this.active = undefined;
          if (
            value.error ||
            !Array.isArray(value.embedding) ||
            value.embedding.length !== 768 ||
            !value.embedding.every(Number.isFinite)
          )
            active.reject(new Error('CPU embedding failed.'));
          else active.resolve(value.embedding);
        } catch {
          this.stop(new Error('Invalid embedding response.'));
        }
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('CPU embedding could not start.'));
        this.stop(new Error('CPU embedding unavailable.'));
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('CPU embedding exited.'));
        if (this.child === child) this.stop(new Error('CPU embedding exited.'));
      });
    });
    return await this.boot;
  }
  private stop(error: Error): void {
    const child = this.child;
    this.child = undefined;
    this.boot = undefined;
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(error);
      this.active = undefined;
    }
    child?.kill('SIGKILL');
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.vision?.close();
    if (this.idle) clearTimeout(this.idle);
    this.stop(new Error('Memory service closed.'));
    await this.queue;
  }
}
