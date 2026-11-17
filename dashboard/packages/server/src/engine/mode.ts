import { z } from 'zod';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const EngineMode = z.enum(['text', 'hybrid', 'studio']);
export type EngineMode = z.infer<typeof EngineMode>;
export const EnginePolicy = z.object({
  mode: EngineMode,
  imageTools: z.boolean(),
  agentsAllowed: z.boolean(),
  model: z.string().min(1).max(256).optional(),
});
export type EnginePolicy = z.infer<typeof EnginePolicy>;
export function policy(mode: EngineMode): EnginePolicy {
  return { mode, imageTools: mode === 'hybrid', agentsAllowed: mode !== 'studio' };
}
/** Runner owns the durable policy: admission and tool installation change atomically. */
export class RunnerEngineMode {
  private mode: EngineMode = 'text';
  constructor(
    private readonly file: string,
    private readonly imageEnabled: boolean
  ) {
    try {
      this.mode = EngineMode.parse(JSON.parse(readFileSync(file, 'utf8')).mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!imageEnabled && this.mode !== 'text')
      throw new Error('Saved engine mode requires image integration.');
  }
  status() {
    return policy(this.mode);
  }
  set(mode: EngineMode, occupied: boolean) {
    if (occupied) throw new Error('Pause or finish all agent runs before changing engine mode.');
    if (mode === this.mode) return this.status();
    if (!this.imageEnabled && mode !== 'text') throw new Error('Image integration is disabled.');
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify({ mode }) + '\n', { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
    this.mode = mode;
    return this.status();
  }
  assertAgents() {
    if (this.mode === 'studio') throw new Error('Agent tasks are disabled in Bildstudio mode.');
  }
}
