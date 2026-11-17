import { afterEach, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  isRetryableAssistantError,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import { createEngineRecovery, ENGINE_RECOVERY_MS } from '../../src/durable/model-recovery.js';

const model = fauxProvider().getModel();
const error = (text = 'Connection refused') =>
  fauxAssistantMessage('', { stopReason: 'error', errorMessage: text });
const event = (message = error()) => {
  const stream = createAssistantMessageEventStream();
  if (message.stopReason === 'error')
    stream.push({ type: 'error', reason: 'error', error: message });
  else stream.push({ type: 'done', reason: 'stop', message });
  return stream;
};
afterEach(() => vi.useRealTimers());

it('allows recovery after ten minutes, then gives a new outage its own budget', async () => {
  vi.useFakeTimers();
  const recover = createEngineRecovery(model);
  await recover(() => event(), { sessionId: 'one' }).result();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  const completed = await recover(() => event(fauxAssistantMessage('Back online')), {
    sessionId: 'one',
  }).result();
  expect(completed.stopReason).toBe('stop');
  await recover(() => event(), { sessionId: 'one' }).result();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  const attempt = vi.fn(() => event(fauxAssistantMessage('Recovered again')));
  expect((await recover(attempt, { sessionId: 'one' }).result()).stopReason).toBe('stop');
  expect(attempt).toHaveBeenCalledOnce();
});

it('bounds rapid failures to fifteen minutes without sending another request', async () => {
  vi.useFakeTimers();
  const recover = createEngineRecovery(model);
  await recover(() => event(), { sessionId: 'one' }).result();
  await vi.advanceTimersByTimeAsync(ENGINE_RECOVERY_MS);
  const attempt = vi.fn(() => event());
  const answer = await recover(attempt, { sessionId: 'one' }).result();
  expect(attempt).not.toHaveBeenCalled();
  expect(answer.errorMessage).toContain('15 minutes');
  expect(isRetryableAssistantError(answer)).toBe(false);
  // Another conversation never inherits this exhausted budget.
  await recover(attempt, { sessionId: 'two' }).result();
  expect(attempt).toHaveBeenCalledOnce();
});

it('also bounds a slow stream within the recovery window', async () => {
  vi.useFakeTimers();
  const recover = createEngineRecovery(model);
  await recover(() => event(), { sessionId: 'one' }).result();
  await vi.advanceTimersByTimeAsync(ENGINE_RECOVERY_MS - 1000);
  let aborted = false;
  const pending = recover(
    (options: StreamOptions) => {
      const stream = createAssistantMessageEventStream();
      options.signal!.addEventListener('abort', () => {
        aborted = true;
        stream.push({
          type: 'error',
          reason: 'aborted',
          error: { ...error(), stopReason: 'aborted' },
        });
      });
      return stream;
    },
    { sessionId: 'one' }
  ).result();
  await vi.advanceTimersByTimeAsync(1000);
  const answer = await pending;
  expect(aborted).toBe(true);
  expect(answer.stopReason).toBe('error');
  expect(isRetryableAssistantError(answer)).toBe(false);
});

it('keeps operator cancellation terminal during recovery', async () => {
  const recover = createEngineRecovery(model);
  await recover(() => event(), { sessionId: 'one' }).result();
  const controller = new AbortController();
  const pending = recover(
    (options: StreamOptions) => {
      const stream = createAssistantMessageEventStream();
      options.signal!.addEventListener('abort', () =>
        stream.push({
          type: 'error',
          reason: 'aborted',
          error: { ...error(), stopReason: 'aborted' },
        })
      );
      return stream;
    },
    { sessionId: 'one', signal: controller.signal }
  ).result();
  controller.abort();
  expect((await pending).stopReason).toBe('aborted');
});

it('fails deterministic errors immediately and converts thrown transport errors', async () => {
  const recover = createEngineRecovery(model);
  const answer = await recover(() => event(error('400 Invalid request')), {}).result();
  expect(isRetryableAssistantError(answer)).toBe(false);
  const thrown = await recover(() => {
    throw new Error('Connection refused');
  }, {}).result();
  expect(isRetryableAssistantError(thrown)).toBe(true);
});

it('lets a recovered answer continue beyond the old outage deadline when real tokens resume', async () => {
  vi.useFakeTimers();
  const recover = createEngineRecovery(model);
  await recover(() => event(), { sessionId: 'one' }).result();
  await vi.advanceTimersByTimeAsync(ENGINE_RECOVERY_MS - 1000);
  const source = createAssistantMessageEventStream();
  let signal: AbortSignal | undefined;
  const pending = recover(
    (options: StreamOptions) => {
      signal = options.signal;
      return source;
    },
    { sessionId: 'one' }
  ).result();
  const partial = fauxAssistantMessage('Working again');
  source.push({ type: 'start', partial });
  source.push({ type: 'thinking_delta', contentIndex: 0, delta: 'Working again', partial });
  await vi.advanceTimersByTimeAsync(2000);
  expect(signal?.aborted).toBe(false);
  source.push({ type: 'done', reason: 'stop', message: partial });
  expect((await pending).stopReason).toBe('stop');
});
