import { describe, expect, it, vi } from 'vitest';
import {
  collectAgentRunTrace,
  fetchHealth,
  HealthFetchError,
  mergeAgentRunResult,
  steerAgentRun,
} from '../src/lib/api';
import { AgentRunSnapshotSchema, SERVICE_NAME } from '@observatory/contracts';

const validHealth = {
  service: 'local-ai-b70-observatory',
  status: 'ok',
  version: '0.1.0',
  startedAt: '2025-01-01T10:00:00.000Z',
  timestamp: '2025-01-01T10:00:05.000Z',
  uptimeSeconds: 5,
  checks: [{ name: 'server', status: 'ok' }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Additional coverage on top of the App-level tests: timeout handling and
 * error-code mapping through an injected fetch implementation.
 */
describe('fetchHealth (additional paths)', () => {
  it('aborts after the configured timeout and reports a network error', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl: typeof fetch = async (_input, init) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });

      const pending = fetchHealth({ fetchImpl, timeoutMs: 250 });
      // Attach a no-op handler first so the rejection is not "unhandled"
      // during the timer flush; the assertions below still observe it.
      void pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).rejects.toThrow(/timed out after/);
      await expect(pending).rejects.toMatchObject({ code: 'network' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies errors via the typed HealthFetchError codes', async () => {
    const network = new HealthFetchError('netzwerk', 'network');
    const http = new HealthFetchError('http 503', 'http', 503);
    const invalid = new HealthFetchError('invalid', 'invalid_payload');

    expect(network).toBeInstanceOf(Error);
    expect(network.name).toBe('HealthFetchError');
    expect(http.status).toBe(503);
    expect(invalid.code).toBe('invalid_payload');
  });

  it('propagates the validated payload type to the caller', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(validHealth);
    const payload = await fetchHealth({ fetchImpl });
    expect(payload.service).toBe('local-ai-b70-observatory');
    expect(payload.checks[0]?.name).toBe('server');
  });

  it('preserves a structured merge-conflict code for the agent UI', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        { error: { code: 'merge_conflict', message: 'Result conflicts with target.' } },
        409
      );
    await expect(
      mergeAgentRunResult(
        {
          runId: '11111111-1111-4111-8111-111111111111',
          resultRevision: 'a'.repeat(40),
          expectedTaskVersion: 3,
        },
        fetchImpl
      )
    ).rejects.toMatchObject({ status: 409, apiCode: 'merge_conflict' });
  });

  it('posts the separated merge request to its own endpoint and parses the result', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse({
        runId: '11111111-1111-4111-8111-111111111111',
        resultRevision: 'a'.repeat(40),
        files: ['src/value.ts'],
        diff: 'diff',
        diffTruncated: false,
        checkStatus: 'passed',
        checks: [],
        acceptedAt: '2026-09-13T18:00:00.000Z',
        acceptedRevision: 'a'.repeat(40),
        mergedAt: '2026-09-13T18:05:00.000Z',
        mergedRevision: 'd'.repeat(40),
      });
    };
    const result = await mergeAgentRunResult(
      {
        runId: '11111111-1111-4111-8111-111111111111',
        resultRevision: 'a'.repeat(40),
        expectedTaskVersion: 3,
      },
      fetchImpl
    );
    expect(calls).toEqual(['/api/agent/runs/11111111-1111-4111-8111-111111111111/merge']);
    expect(result.mergedAt).toBe('2026-09-13T18:05:00.000Z');
    expect(result.mergedRevision).toBe('d'.repeat(40));
  });
});

describe('rolling M6.3 agent upgrade', () => {
  it('uses the legacy steer route only when the old server lacks the run route', async () => {
    const calls: string[] = [];
    const snapshot = AgentRunSnapshotSchema.parse({
      service: SERVICE_NAME,
      enabled: true,
      status: 'running',
      sequence: 4,
      runId: '22222222-2222-4222-8222-222222222222',
      pendingSteering: 0,
      timeline: [],
    });
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return jsonResponse({ error: { code: 'not_found', message: 'Unknown route.' } }, 404);
      }
      return jsonResponse(snapshot);
    };
    await expect(
      steerAgentRun(
        {
          runId: snapshot.runId!,
          expectedRunVersion: 2,
          expectedTaskVersion: 2,
          message: 'Keep going.',
          idempotencyKey: '33333333-3333-4333-8333-333333333333',
        },
        fetchImpl
      )
    ).resolves.toEqual(snapshot);
    expect(calls).toEqual([
      '/api/agent/runs/22222222-2222-4222-8222-222222222222/steer',
      '/api/agent/steer',
    ]);
  });
});

describe('collectAgentRunTrace (shared cursor pagination)', () => {
  const RUN_ID = '22222222-2222-4222-8222-222222222222';
  const ITEM_ID = '11111111-1111-4111-8111-111111111111';
  const traceItem = (sequence: number) => ({
    id: sequence + 1,
    runId: RUN_ID,
    sequence,
    recordedAt: '2026-09-13T10:00:00.000Z',
    event: {
      operation: 'append_text',
      runId: RUN_ID,
      sequence,
      itemId: ITEM_ID,
      text: `chunk ${sequence}`,
    },
  });

  function traceFetch(pages: Record<string, unknown>) {
    const urls: string[] = [];
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        const after = new URL(url, 'http://localhost').searchParams.get('afterSequence');
        const body = pages[after ?? ''];
        // An unknown cursor must fail validation instead of looping forever.
        return jsonResponse(body === undefined ? { unexpected: true } : body);
      });
    return { urls, spy };
  }

  it('walks a complete trace page by page with a strictly advancing cursor', async () => {
    const { urls, spy } = traceFetch({
      '-1': {
        runId: RUN_ID,
        items: [traceItem(0), traceItem(1)],
        hasMore: true,
        nextAfterSequence: 1,
      },
      '1': {
        runId: RUN_ID,
        items: [traceItem(2), traceItem(3)],
        hasMore: true,
        nextAfterSequence: 3,
      },
      '3': { runId: RUN_ID, items: [traceItem(4)], hasMore: false },
    });
    try {
      const events = await collectAgentRunTrace(RUN_ID);
      expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
      expect(urls).toEqual([
        `/api/agent/runs/${RUN_ID}/trace?afterSequence=-1&limit=250`,
        `/api/agent/runs/${RUN_ID}/trace?afterSequence=1&limit=250`,
        `/api/agent/runs/${RUN_ID}/trace?afterSequence=3&limit=250`,
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('starts incrementally after the given sequence', async () => {
    const { urls, spy } = traceFetch({
      '5': { runId: RUN_ID, items: [traceItem(6)], hasMore: false },
    });
    try {
      const events = await collectAgentRunTrace(RUN_ID, { afterSequence: 5 });
      expect(events.map((event) => event.sequence)).toEqual([6]);
      expect(urls[0]).toBe(`/api/agent/runs/${RUN_ID}/trace?afterSequence=5&limit=250`);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops instead of looping when the cursor does not advance', async () => {
    const page = { runId: RUN_ID, items: [traceItem(5)], hasMore: true, nextAfterSequence: 5 };
    const { urls, spy } = traceFetch({ '5': page });
    try {
      const events = await collectAgentRunTrace(RUN_ID, { afterSequence: 5 });
      expect(events).toHaveLength(1);
      expect(urls).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('throws on a stalled cursor for complete collections', async () => {
    // hasMore without a next cursor is a stall: a complete collection must
    // reject it instead of delivering a truncated trace.
    const page = { runId: RUN_ID, items: [traceItem(0)], hasMore: true };
    const { spy } = traceFetch({ '-1': page });
    try {
      await expect(collectAgentRunTrace(RUN_ID, { failOnStalledCursor: true })).rejects.toThrow(
        'Trace cursor did not advance.'
      );
    } finally {
      spy.mockRestore();
    }
  });
});
