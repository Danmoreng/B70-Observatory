import { TextRecipeSchema, type TextRecipe } from '@observatory/contracts';
import { z } from 'zod';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const EngineMode = z.enum(['text', 'hybrid', 'studio']);
export type EngineMode = z.infer<typeof EngineMode>;
export const EnginePolicy = z.object({
  mode: EngineMode,
  imageTools: z.boolean(),
  agentsAllowed: z.boolean(),
  models: z.array(TextRecipeSchema).optional(),
  model: z.string().min(1).max(256).optional(),
});
export type EnginePolicy = z.infer<typeof EnginePolicy>;
export function policy(mode: EngineMode): EnginePolicy {
  return { mode, imageTools: mode === 'hybrid', agentsAllowed: mode !== 'studio' };
}
/** Runner owns the durable policy: admission and tool installation change atomically. */
export class RunnerEngineMode {
  private mode: EngineMode = 'text';
  model?: TextRecipe;
  pending?: { next: TextRecipe; wasActive: boolean };
  constructor(
    private readonly file: string,
    private readonly imageEnabled: boolean,
    defaultRecipe?: TextRecipe
  ) {
    this.model = defaultRecipe;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      this.mode = EngineMode.parse(saved.mode);
      if (defaultRecipe && saved.model) this.model = TextRecipeSchema.parse(saved.model);
      if (defaultRecipe && saved.pending) {
        this.pending = z
          .object({ next: TextRecipeSchema, wasActive: z.boolean() })
          .parse(saved.pending);
        if (this.model === this.pending.next) throw new Error('Invalid pending model switch.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!imageEnabled && this.mode !== 'text')
      throw new Error('Saved engine mode requires image integration.');
  }
  status() {
    return this.model
      ? { ...policy(this.mode), model: this.model, models: TextRecipeSchema.options }
      : policy(this.mode);
  }
  set(mode: EngineMode, occupied: boolean) {
    if (occupied) throw new Error('Pause or finish all agent runs before changing engine mode.');
    if (mode === this.mode) return this.status();
    if (!this.imageEnabled && mode !== 'text') throw new Error('Image integration is disabled.');
    this.save(mode, this.model);
    return this.status();
  }
  selectModel(model: TextRecipe) {
    this.save(this.mode, model);
  }
  beginSwitch(next: TextRecipe, wasActive: boolean) {
    this.save(this.mode, this.model, { next, wasActive });
  }
  private save(
    mode: EngineMode,
    model?: TextRecipe,
    pending?: { next: TextRecipe; wasActive: boolean }
  ) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify({ mode, model, pending }) + '\n', {
      mode: 0o600,
    });
    renameSync(this.file + '.tmp', this.file);
    this.pending = pending;
    this.mode = mode;
    this.model = model;
  }
  assertAgents() {
    if (this.mode === 'studio') throw new Error('Agent tasks are disabled in Bildstudio mode.');
  }
}
