import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  isRetryableAssistantError,
  type AssistantMessage,
  type StreamOptions,
  type Model,
} from '@earendil-works/pi-ai';

export const ENGINE_RECOVERY_MS = 15 * 60_000;
// Pi persists the retry checkpoint and repeats only the failed generation,
// retaining completed tool results, queued steering and conversation identity.
export const ENGINE_RETRY_POLICY = {
  enabled: true,
  maxRetries: 30,
  baseDelayMs: 30_000,
  maxAgentDelayMs: 30_000,
};

/** Bound fast failures and slow requests by the same outage window per conversation.
 * Retries themselves belong to Pi, so all attempts/errors remain visible and durable.
 */
export function createEngineRecovery(model: Model<string>) {
  const errorMessage = (text: string): AssistantMessage => ({
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason: 'error',
    errorMessage: text,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const failures = new Map<string, { until: number; error: AssistantMessage }>();
  return function recover<T extends StreamOptions>(
    start: (options: T) => AssistantMessageEventStream,
    options: T
  ): AssistantMessageEventStream {
    const key = options.sessionId ?? 'default';
    const failure = failures.get(key);
    const remaining = failure ? failure.until - Date.now() : undefined;
    const output = createAssistantMessageEventStream();
    const exhausted = (error: AssistantMessage): AssistantMessage => ({
      ...error,
      content: [],
      timestamp: Date.now(),
      stopReason: 'error',
      // Deliberately not a transient-provider error: Pi must now stop retrying.
      errorMessage:
        'Engine recovery window exhausted after 15 minutes. Saved conversation retained.',
    });
    if (remaining !== undefined && remaining <= 0) {
      output.push({ type: 'error', reason: 'error', error: exhausted(failure!.error) });
      return output;
    }
    const deadline = new AbortController();
    const timer =
      remaining === undefined ? undefined : setTimeout(() => deadline.abort(), remaining);
    timer?.unref();
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    const recordFailure = (error: AssistantMessage) => {
      if (isRetryableAssistantError(error)) {
        if (!failures.has(key))
          failures.set(key, { until: Date.now() + ENGINE_RECOVERY_MS, error });
      } else failures.delete(key);
    };
    void (async () => {
      let finished = false;
      try {
        for await (const event of start({ ...options, signal })) {
          // A real generated delta proves recovery. Headers/start alone do not:
          // a healthy answer must not be cut off when the old outage budget ends.
          if (
            (event.type === 'text_delta' ||
              event.type === 'thinking_delta' ||
              event.type === 'toolcall_delta') &&
            event.delta.length > 0
          ) {
            failures.delete(key);
            clearTimeout(timer);
          }
          if (event.type === 'done' || event.type === 'error') finished = true;
          if (event.type === 'done') failures.delete(key);
          if (event.type === 'error') {
            if (deadline.signal.aborted && !options.signal?.aborted) {
              output.push({ type: 'error', reason: 'error', error: exhausted(event.error) });
              return;
            }
            recordFailure(event.error);
          }
          output.push(event);
        }
        if (!finished) throw new Error('Stream ended before a terminal response event');
      } catch (cause) {
        const error = errorMessage(cause instanceof Error ? cause.message : 'Model stream failed');
        if (options.signal?.aborted) {
          output.push({
            type: 'error',
            reason: 'aborted',
            error: { ...error, stopReason: 'aborted' },
          });
        } else if (deadline.signal.aborted) {
          output.push({ type: 'error', reason: 'error', error: exhausted(error) });
        } else {
          recordFailure(error);
          output.push({ type: 'error', reason: 'error', error });
        }
      } finally {
        clearTimeout(timer);
        output.end();
      }
    })();
    return output;
  };
}
