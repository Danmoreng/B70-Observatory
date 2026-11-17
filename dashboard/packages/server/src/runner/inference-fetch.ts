import { randomUUID } from 'node:crypto';
import type { InferenceRequestTelemetry } from '@observatory/contracts';
import { createInferenceTelemetryObserver, readEngineWait } from './inference-telemetry.js';
import { resolveRequestId } from '../gateway/headers.js';

/** Observe the response as its consumer reads it; no clone/tee or extra buffering. */
export function createInferenceFetch(
  onTelemetry: (sample: InferenceRequestTelemetry) => void,
  fetchRequest: typeof fetch = globalThis.fetch
): typeof fetch {
  return async (input, init) => {
    let requestId: string = randomUUID();
    const startedAt = new Date().toISOString();
    const start = performance.now();
    let reported = false;
    let engineWaitMs: number | undefined;
    const report = (
      completed: boolean,
      observed?: ReturnType<ReturnType<typeof createInferenceTelemetryObserver>['finish']>
    ) => {
      if (reported) return;
      reported = true;
      try {
        onTelemetry({
          requestId,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, performance.now() - start),
          ...(engineWaitMs === undefined ? {} : { engineWaitMs }),
          outcome: completed ? 'completed' : 'failed',
          usage: completed ? (observed?.usage ?? null) : null,
          prefill: completed ? (observed?.prefill ?? null) : null,
          decode: completed ? (observed?.decode ?? null) : null,
        });
      } catch {
        // An observational failure must not alter the model response.
      }
    };
    try {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      headers.set('x-request-id', requestId);
      headers.set('x-observatory-origin', 'pi');
      const response = await fetchRequest(input, { ...init, headers });
      engineWaitMs = readEngineWait(response.headers.get('x-observatory-engine-wait-ms'));
      const gatewayId = resolveRequestId(response.headers.get('x-request-id') ?? undefined);
      if (gatewayId.supplied) requestId = gatewayId.id;
      if (!response.body) {
        report(false);
        return response;
      }
      const observer = createInferenceTelemetryObserver(response.headers.get('content-type') ?? '');
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (part.done) {
              const observed = observer.finish();
              report(response.ok && observed.complete, observed);
              controller.close();
            } else {
              observer.push(Buffer.from(part.value));
              controller.enqueue(part.value);
            }
          } catch (error) {
            report(false);
            controller.error(error);
          }
        },
        async cancel(reason) {
          // OpenAI's SSE iterator may stop at [DONE] without reading EOF.
          const observed = observer.finish();
          report(response.ok && observed.complete, observed);
          await reader.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      report(false);
      throw error;
    }
  };
}
