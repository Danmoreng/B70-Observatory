import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppOptions } from '../../src/app.js';
import { encodeSseFrame, EventJournal, type JournalEntry } from '../../src/events/journal.js';
import { loadServerConfig } from '../../src/config.js';
import { MetricRepository } from '../../src/db/index.js';
import { VllmCollector } from '../../src/telemetry/collector.js';
import { newTempDb } from '../helpers.js';
import {
  prometheusFixture,
  startMockPrometheus,
  type MockPrometheus,
  type TelemetryFixtureValues,
} from '../telemetry/fixtures.js';

// ---------------------------------------------------------------------------
// EventJournal (unit)
// ---------------------------------------------------------------------------

describe('EventJournal (M5C wire ids, replay window, reconnect decisions)', () => {
  it('assigns strictly increasing, generation-prefixed ids in publication order', () => {
    const journal = new EventJournal({ generation: 'aaaa1111', capacity: 16 });
    const first = journal.publish('health', '{}');
    const second = journal.publish('telemetry', '{}');
    const third = journal.publish('system', '{}');
    expect(first.id).toBe('aaaa1111-1');
    expect(second.id).toBe('aaaa1111-2');
    expect(third.id).toBe('aaaa1111-3');
    expect(journal.lastSeq).toBe(3);
    expect(journal.size).toBe(3);
  });

  it('generates a unique 8-hex generation per process instance', () => {
    const a = new EventJournal();
    const b = new EventJournal();
    expect(a.generation).toMatch(/^[0-9a-f]{8}$/);
    expect(b.generation).toMatch(/^[0-9a-f]{8}$/);
    expect(a.generation).not.toBe(b.generation);
  });

  it('rejects out-of-range capacities so a misconfiguration cannot allocate unbounded memory', () => {
    expect(() => new EventJournal({ capacity: 7 })).toThrow(/between 8 and 4096/);
    expect(() => new EventJournal({ capacity: 4097 })).toThrow(/between 8 and 4096/);
    expect(() => new EventJournal({ capacity: 1.5 })).toThrow(/between 8 and 4096/);
  });

  it('slides the bounded window and evicts the oldest entries first', () => {
    const journal = new EventJournal({ generation: 'bbbb2222', capacity: 8 });
    for (let i = 1; i <= 10; i++) journal.publish('history', `{"n":${i}}`);
    expect(journal.size).toBe(8);
    expect(journal.oldestSeq).toBe(3);
    const window = journal.entriesAfter(0);
    expect(window?.map((entry) => entry.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('replays exactly the frames after the given sequence, in global order', () => {
    const journal = new EventJournal({ generation: 'cccc3333', capacity: 16 });
    journal.publish('health', 'h1');
    journal.publish('telemetry', 't1');
    journal.publish('system', 's1');
    journal.publish('telemetry', 't2');
    const replay = journal.entriesAfter(2);
    expect(replay?.map((entry) => [entry.seq, entry.type, entry.data])).toEqual([
      [3, 'system', 's1'],
      [4, 'telemetry', 't2'],
    ]);
    expect(journal.entriesAfter(4)).toEqual([]);
    expect(journal.typesAfter(2)).toEqual(['system', 'telemetry']);
  });

  it('treats an empty journal and an up-to-date client as full/empty replay', () => {
    const empty = new EventJournal({ generation: 'dddd4444', capacity: 8 });
    expect(empty.entriesAfter(0)).toEqual([]);
    expect(empty.entriesAfter(1)).toBeNull();

    const journal = new EventJournal({ generation: 'eeee5555', capacity: 8 });
    journal.publish('health', 'h1');
    expect(journal.entriesAfter(1)).toEqual([]);
    expect(journal.entriesAfter(2)).toBeNull();
  });

  it('reports missing continuity (null) when the boundary fell out of the window', () => {
    const journal = new EventJournal({ generation: 'ffff6666', capacity: 8 });
    for (let i = 1; i <= 10; i++) journal.publish('history', `x${i}`);
    expect(journal.entriesAfter(1)).toBeNull(); // seq 1 was evicted (oldest is 3)
    expect(journal.entriesAfter(2)).toBeNull();
    expect(journal.entriesAfter(3)?.[0]?.seq).toBe(4);
  });

  describe('resolveReconnect', () => {
    const build = () => {
      const journal = new EventJournal({ generation: '1234abcd', capacity: 8 });
      journal.publish('health', 'h1');
      journal.publish('telemetry', 't1');
      journal.publish('system', 's1');
      journal.publish('telemetry', 't2');
      return journal;
    };

    it('resyncs on missing header (first connection)', () => {
      expect(build().resolveReconnect(undefined)).toEqual({ mode: 'resync' });
      expect(build().resolveReconnect('')).toEqual({ mode: 'resync' });
      expect(build().resolveReconnect('   ')).toEqual({ mode: 'resync' });
    });

    it('resyncs on malformed ids (never throws, never replays)', () => {
      for (const garbage of [
        'no-dash',
        'xyz',
        '1234abcd-',
        '1234abcd-0',
        '1234abcd-0000000000000',
        '1234abcd-999999999999',
        '1234ABCD-1',
        '1234abc-123',
        '1234abcd-1x',
      ]) {
        expect(build().resolveReconnect(garbage)).toEqual({ mode: 'resync' });
      }
    });

    it('resyncs when the id comes from a previous process generation (restart)', () => {
      expect(build().resolveReconnect('deadbeef-4')).toEqual({ mode: 'resync' });
      expect(build().resolveReconnect('1234abcd-4') === undefined).toBe(false);
    });

    it('resyncs for future ids (the client claims an unknown event)', () => {
      expect(build().resolveReconnect('1234abcd-5')).toEqual({ mode: 'resync' });
      expect(build().resolveReconnect('1234abcd-1000000')).toEqual({ mode: 'resync' });
    });

    it('resyncs for ids that fell out of the bounded window', () => {
      const journal = new EventJournal({ generation: '1234abcd', capacity: 8 });
      for (let i = 1; i <= 10; i++) journal.publish('history', `x${i}`);
      expect(journal.resolveReconnect('1234abcd-1')).toEqual({ mode: 'resync' });
      expect(journal.resolveReconnect('1234abcd-2')).toEqual({ mode: 'resync' });
      expect(journal.resolveReconnect('1234abcd-3')).toEqual({ mode: 'replay', from: 3 });
    });

    it('replays from the last id the client received (seq+1)', () => {
      const journal = build();
      expect(journal.resolveReconnect('1234abcd-1')).toEqual({ mode: 'replay', from: 1 });
      expect(journal.resolveReconnect('1234abcd-3')).toEqual({ mode: 'replay', from: 3 });
      // An up-to-date client (last published id) replays nothing.
      expect(journal.resolveReconnect('1234abcd-4')).toEqual({ mode: 'replay', from: 4 });
      expect(journal.entriesAfter(4)).toEqual([]);
    });

    it('accepts a duplicated header value (defensive: first entry wins)', () => {
      expect(build().resolveReconnect(['1234abcd-2', 'deadbeef-2'])).toEqual({
        mode: 'replay',
        from: 2,
      });
    });
  });

  it('encodes frames with id, event and a single-line data payload', () => {
    const entry: JournalEntry = { id: 'abcd1234-7', seq: 7, type: 'telemetry', data: '{"a":1}' };
    expect(encodeSseFrame(entry)).toBe('id: abcd1234-7\nevent: telemetry\ndata: {"a":1}\n\n');
  });

  it('encodes a connection-local control frame without advancing the journal cursor', () => {
    const journal = new EventJournal({ generation: 'abcd1234', capacity: 8 });
    expect(journal.lastId).toBeUndefined();
    journal.publish('health', '{}');
    expect(journal.lastId).toBe('abcd1234-1');
    expect(encodeSseFrame({ type: 'stream', data: '{"kind":"replay","types":[]}' })).toBe(
      'event: stream\ndata: {"kind":"replay","types":[]}\n\n'
    );
    expect(journal.lastId).toBe('abcd1234-1');
  });

  it('refuses multi-line payloads (SSE data lines are single-line)', () => {
    const journal = new EventJournal({ generation: 'aaaa1111' });
    expect(() => journal.publish('health', 'a\nb')).toThrow(/line break/i);
    expect(() => journal.publish('health', 'a\r\nb')).toThrow(/line break/i);
  });

  it('delivers a frame during connection setup exactly once (replay or live, never both)', () => {
    const journal = new EventJournal({ generation: '99999999', capacity: 8 });
    journal.publish('health', 'h1');
    // Synchronous snapshot first (as the route does), then the live hook,
    // then a publish that lands in between on a real (multi-threaded)
    // runtime; on the single-threaded runtime the ordering is atomic.
    const snapshot = journal.entriesAfter(0);
    const seen: string[] = [];
    const unsubscribe = journal.subscribe((entry) => seen.push(entry.data));
    journal.publish('telemetry', 't2');
    unsubscribe();
    journal.publish('system', 's3'); // after unsubscribe: not delivered
    expect(snapshot?.map((entry) => entry.data)).toEqual(['h1']);
    expect(seen).toEqual(['t2']);
  });
});

// ---------------------------------------------------------------------------
// /api/events reconnection semantics (real loopback HTTP)
// ---------------------------------------------------------------------------

const RECONNECT_FIXTURE: TelemetryFixtureValues = {
  running: 2,
  waiting: 0,
  kv: 0.25,
  promptTokens: 1000,
  generationTokens: 100,
  prefixQueries: 500,
  prefixHits: 300,
  mtpDraft: 100,
  mtpAccepted: 80,
  successStop: 1,
};

interface WireFrame {
  id?: string;
  event?: string;
  data?: string;
}

function parseFrames(raw: string): WireFrame[] {
  const frames: WireFrame[] = [];
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue;
    const frame: WireFrame = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) frame.id = line.slice(4);
      else if (line.startsWith('event: ')) frame.event = line.slice(7);
      else if (line.startsWith('data: ')) frame.data = line.slice(6);
    }
    if (frame.event !== undefined) frames.push(frame);
  }
  return frames;
}

async function readStream(
  port: number,
  until: (raw: string) => boolean,
  headers: Record<string, string> = {},
  timeoutMs = 4000
): Promise<string> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream', ...headers },
    });
    if (response.status !== 200) throw new Error(`SSE status ${response.status}`);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE body missing');
    const decoder = new TextDecoder();
    let received = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
      if (until(received)) break;
    }
    return received;
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('/api/events reconnection contract (M5C, real sockets)', () => {
  let temp: ReturnType<typeof newTempDb>;
  let mock: MockPrometheus;
  let collector: VllmCollector;
  let port: number;
  let close: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    temp = newTempDb();
    mock = await startMockPrometheus(prometheusFixture(RECONNECT_FIXTURE));
    collector = new VllmCollector({
      metricsUrl: mock.url,
      gpu: { available: false, reason: 'Integrationstest: GPU ausgeblendet' },
      intervalMs: 50,
      timeoutMs: 2000,
      persist: (samples) => new MetricRepository(temp.db).insertMany(samples),
      log: () => undefined,
    });
    const webDir = mkdtempSync(join(tmpdir(), 'observatory-m5c-'));
    writeFileSync(join(webDir, 'index.html'), '<html></html>');
    const options: AppOptions = {
      version: 'm5c-reconnect',
      // Small window so the eviction/resync case is reachable in the test.
      config: loadServerConfig({
        OBSERVATORY_HOST: '127.0.0.1',
        OBSERVATORY_EVENT_BUFFER_SIZE: '8',
      }),
      loggerLevel: 'silent',
      database: temp.db,
      telemetry: { collector },
      webRoot: webDir,
    };
    const app = buildApp(options);
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as AddressInfo).port;
    close = () => app.close();
    collector.start();
    // Let the first collection (and its journal frames) settle.
    await sleep(300);
  });

  afterAll(async () => {
    collector.stop();
    await close();
    await mock.close();
    temp.close();
    rmSync(temp.dir, { recursive: true, force: true });
  });

  const lastFrameId = (raw: string): string | undefined =>
    parseFrames(raw)
      .filter((frame) => frame.id !== undefined)
      .at(-1)?.id;

  it('first connection (no Last-Event-ID): resync notice first, then current snapshots', async () => {
    const raw = await readStream(port, (body) => body.includes('event: telemetry'));
    const frames = parseFrames(raw);
    expect(frames[0]?.event).toBe('stream');
    expect(JSON.parse(frames[0]?.data ?? '{}')).toEqual({ kind: 'resync' });
    // Every frame carries a valid wire id of this process' generation.
    for (const frame of frames) {
      expect(frame.id).toMatch(/^[0-9a-f]{8}-\d+$/);
    }
    expect(frames.some((frame) => frame.event === 'health')).toBe(true);
    expect(frames.some((frame) => frame.event === 'telemetry')).toBe(true);
  });

  it('keeps reconnect control and resync snapshots private to the connecting client', async () => {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return;

    const decoder = new TextDecoder();
    let initial = '';
    while (!initial.includes('event: telemetry')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      initial += decoder.decode(chunk.value, { stream: true });
    }

    // A second first-time client receives its own resync burst.
    const newcomer = await readStream(port, (body) => body.includes('event: telemetry'));
    expect(parseFrames(newcomer)[0]?.event).toBe('stream');

    // The already-current client must not receive the newcomer's control
    // notice or duplicate snapshots. A semantic collector event would be
    // legitimate, but no fixture value changes during this short window.
    const nextRead = reader.read().catch(() => undefined);
    const unexpected = await Promise.race([nextRead, sleep(200).then(() => undefined)]);
    controller.abort();
    expect(unexpected).toBeUndefined();
  });

  it('reconnect with Last-Event-ID inside the window: replay notice + exactly the missed frames', async () => {
    // First connection: learn the last id the client holds.
    const first = await readStream(port, (body) => body.includes('event: telemetry'));
    const lastSeen = lastFrameId(first);
    expect(lastSeen).toBeDefined();

    // A new telemetry change is published while the client is disconnected.
    mock.setBody(prometheusFixture({ ...RECONNECT_FIXTURE, kv: 0.72, running: 9 }));
    await sleep(200); // collector interval is 50 ms

    const second = await readStream(
      port,
      (body) => body.includes('event: stream') && body.includes('event: telemetry'),
      { 'last-event-id': lastSeen ?? '' }
    );
    const frames = parseFrames(second);
    expect(frames[0]?.event).toBe('stream');
    expect(frames[0]?.id).toBeUndefined();
    const notice = JSON.parse(frames[0]?.data ?? '{}');
    expect(notice.kind).toBe('replay');
    expect(notice.types).toEqual(expect.arrayContaining(['telemetry']));

    const replayed = frames.filter((frame) => frame.event === 'telemetry');
    expect(replayed).toHaveLength(1);
    const replayedId = replayed[0]?.id;
    // No duplicate of the client's last id, no gap: the replayed id
    // continues the sequence of the id the client holds.
    expect(replayedId).not.toBe(lastSeen);
    expect(Number(replayedId?.split('-')[1])).toBeGreaterThan(Number(lastSeen?.split('-')[1]));
    expect(
      frames
        .filter((frame) => frame.event !== 'stream')
        .every((frame, index, all) =>
          index === 0
            ? true
            : Number(frame.id?.split('-')[1]) > Number(all[index - 1]?.id?.split('-')[1])
        )
    ).toBe(true);
    expect(second.split(replayedId ?? '\u0000').length - 1).toBe(1); // appears exactly once
  });

  it('reconnect with a foreign-generation id (server restarted): explicit resync with fresh snapshots', async () => {
    const raw = await readStream(port, (body) => body.includes('event: telemetry'), {
      'last-event-id': 'deadbeef-999999',
    });
    const frames = parseFrames(raw);
    expect(frames[0]?.event).toBe('stream');
    expect(JSON.parse(frames[0]?.data ?? '{}')).toEqual({ kind: 'resync' });
    const dataFrames = frames.filter((frame) => frame.event !== 'stream');
    expect(dataFrames.some((frame) => frame.event === 'health')).toBe(true);
    expect(dataFrames.some((frame) => frame.event === 'telemetry')).toBe(true);
  });

  it('reconnect with a malformed id: resync instead of a partial or wrong replay', async () => {
    for (const bad of ['not-an-id', 'zzzzzzzz-1', '12345678-0']) {
      const raw = await readStream(port, (body) => body.includes('event: stream'), {
        'last-event-id': bad,
      });
      const first = parseFrames(raw)[0];
      expect(first?.event).toBe('stream');
      expect(JSON.parse(first?.data ?? '{}')).toEqual({ kind: 'resync' });
    }
  });

  it('reconnect with an evicted id (window full): resync, never a silent gap', async () => {
    // Connect once and remember an early id…
    const first = await readStream(port, (body) => body.includes('event: telemetry'));
    const early = parseFrames(first).find((frame) => frame.event === 'telemetry')?.id;
    expect(early).toBeDefined();

    // …then publish far more frames than the 8-entry window can hold.
    for (let i = 1; i <= 14; i++) {
      mock.setBody(prometheusFixture({ ...RECONNECT_FIXTURE, kv: 0.1 + i * 0.01, running: i }));
      await sleep(70); // > collector interval: one publish per change
    }
    await sleep(150);

    const raw = await readStream(port, (body) => body.includes('event: stream'), {
      'last-event-id': early ?? '',
    });
    const notice = JSON.parse(parseFrames(raw)[0]?.data ?? '{}');
    expect(notice.kind).toBe('resync');
  });
});
