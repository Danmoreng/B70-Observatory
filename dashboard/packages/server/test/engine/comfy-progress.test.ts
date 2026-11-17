import { afterEach, expect, it, vi } from 'vitest';
import { comfyFixture } from './image-fixture.js';
afterEach(() => vi.unstubAllGlobals());
it('receives sampling steps for the owned prompt, ignores other prompts, and closes its progress socket', async () => {
  const fake = comfyFixture();
  fake.state.finished = false;
  const updates: unknown[][] = [];
  const closed = vi.fn();
  class ProgressSocket extends EventTarget {
    constructor() {
      super();
      setTimeout(() => {
        for (const data of [
          { prompt_id: 'other', value: 5, max: 6 },
          { prompt_id: 'prompt-1', value: 3, max: 6 },
        ])
          this.dispatchEvent(
            new MessageEvent('message', { data: JSON.stringify({ type: 'progress', data }) })
          );
        fake.state.finished = true;
      }, 20);
    }
    close() {
      closed();
    }
  }
  vi.stubGlobal('WebSocket', ProgressSocket);
  await fake.engine.render(
    {
      id: 'a'.repeat(32),
      input: { key: 'b'.repeat(64), prompt: 'A lake', sizeId: 'landscape-quick', seed: 1 },
      seed: 1,
      submitted: false,
      submittedAs: () => {},
      progress: (...args) => updates.push(args),
    },
    new AbortController().signal
  );
  expect(updates).toContainEqual(['Generating image', 3, 6]);
  expect(updates).not.toContainEqual(['Generating image', 5, 6]);
  expect(closed).toHaveBeenCalledOnce();
});
