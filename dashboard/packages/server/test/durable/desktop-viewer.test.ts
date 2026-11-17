import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { DurableAgentManager } from '../../src/durable/manager.js';
import { sandboxToolCall } from '../../src/durable/tools.js';
vi.mock('../../src/durable/tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/durable/tools.js')>()),
  sandboxToolCall: vi.fn(),
}));
const call = vi.mocked(sandboxToolCall);
const png = readFileSync(
  new URL('../../../runner/test/fixtures/desktop/blank.png', import.meta.url)
);
function fixture(desktop = true) {
  return new DurableAgentManager({
    runId: randomUUID(),
    requestId: randomUUID(),
    provider: 'fixture',
    model: 'fixture',
    thinkingLevel: 'off',
    models: createModels(),
    storagePath: '/tmp/unused-desktop-viewer.sqlite',
    instructions: '',
    env: {} as ExecutionEnv,
    browser: false,
    desktop,
    closeEnvironment: async () => {},
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
describe('bounded per-run desktop observation', () => {
  it('coalesces simultaneous viewers and caches for two seconds', async () => {
    vi.useFakeTimers();
    call.mockResolvedValue({
      output: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }],
      isError: undefined,
    });
    const manager = fixture();
    try {
      const [first, second] = await Promise.all([
        manager.getDesktopFrame(),
        manager.getDesktopFrame(),
      ]);
      expect(first?.data).toEqual(png);
      expect(second).toEqual(first);
      expect(call).toHaveBeenCalledTimes(1);
      expect(await manager.getDesktopFrame()).toEqual(first);
      expect(call).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      await manager.getDesktopFrame();
      expect(call).toHaveBeenCalledTimes(2);
    } finally {
      await manager.close();
    }
  });
  it('does not capture when disabled or closed and drops malformed frames', async () => {
    const disabled = fixture(false);
    expect(await disabled.getDesktopFrame()).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
    await disabled.close();
    const manager = fixture();
    call.mockResolvedValue({
      output: [
        { type: 'image', mimeType: 'image/png', data: Buffer.from('invalid').toString('base64') },
      ],
      isError: undefined,
    });
    expect(await manager.getDesktopFrame()).toBeUndefined();
    await manager.close();
    expect(await manager.getDesktopFrame()).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(1);
  });
});
