import { randomBytes } from 'node:crypto';

/**
 * Shared event journal for the authenticated `/api/events` stream (M5C).
 *
 * One journal per process replaces the previous per-source bookkeeping:
 * every semantic health/telemetry/system/history frame receives a single
 * globally ordered, strictly increasing id from this component.
 *
 * Wire ids have the form `<generation>-<sequence>`:
 * - `<generation>` is a random 8-hex-char process token. A server restart
 *   creates a fresh generation, so a `Last-Event-ID` from a previous process
 *   can never be mistaken for an id of the current buffer (it is resynced
 *   instead of replaying unrelated new events);
 * - `<sequence>` starts at 1 and grows by exactly one per published frame,
 *   independently of the event type. "Global order" means: for any two
 *   frames `a`, `b` in the journal, seq(a) < seq(b) iff `a` was published
 *   before `b`.
 *
 * The journal keeps a fixed-size ring buffer (default 512 entries). Replay
 * is therefore bounded both in count and in payload size (frame payloads are
 * contract-validated, JSON without newlines). Entries older than the window
 * are evicted; clients whose last id fell out of the window must re-sync.
 */

/** Data frame types retained in the shared replay journal. */
export type JournalEventType = 'health' | 'telemetry' | 'system' | 'history';

/** Named frame types written on the wire (including connection-local control). */
export type WireEventType = JournalEventType | 'stream';

/** One buffered (and replayable) stream frame. */
export interface JournalEntry {
  /** Stable wire id: `<generation>-<seq>`. */
  id: string;
  /** Per-process sequence number, strictly increasing from 1. */
  seq: number;
  type: JournalEventType;
  /** Exact content of the SSE `data:` line (single line, no newlines). */
  data: string;
}

export interface EventJournalOptions {
  /**
   * Replay window in entries. Fixed for the lifetime of the process.
   * Clamped to 8…4096 so a misconfigured environment cannot allocate an
   * unbounded buffer.
   */
  capacity?: number;
  /** Deterministic process generation (tests); random by default. */
  generation?: string;
}

/**
 * Result of validating a reconnect's `Last-Event-ID` against this journal:
 * - `replay`: the id is known, in the current generation and inside the
 *   buffer window – frames with a higher seq are replayed exactly once, in
 *   global order;
 * - `resync`: the id is missing, malformed, too large, from a previous
 *   process, newer than the buffer, or older than the buffer window – the
 *   client receives fresh current snapshots instead (documented, explicit;
 *   never a silent data gap).
 */
export type ReplayDecision =
  | { mode: 'replay'; /** last seq the client has; replay starts at seq+1 */ from: number }
  | { mode: 'resync' };

/**
 * Ids arrive as raw header text; accept only the exact, bounded shape and
 * treat anything else (including astronomically long digit runs) as invalid
 * instead of parsing it.
 */
const LAST_EVENT_ID_PATTERN = /^([0-9a-f]{8})-(\d{1,12})$/;

/** Encode a buffered entry as one complete SSE frame. */
export function encodeSseFrame(entry: { id?: string; type: WireEventType; data: string }): string {
  const id = entry.id === undefined ? '' : `id: ${entry.id}\n`;
  return `${id}event: ${entry.type}\ndata: ${entry.data}\n\n`;
}

/**
 * Bounded, single-writer journal with live fan-out and replay.
 *
 * Race freedom: `entriesAfter()` and `subscribe()` are synchronous. A
 * connection handler takes the replay snapshot first, registers its live
 * listener and queues live frames until the snapshot has been written. An
 * event published during setup is therefore either in the replay snapshot or
 * in that short per-connection queue – never both and never lost.
 */
export class EventJournal {
  /** Process generation; changes on every restart, never reused. */
  readonly generation: string;
  private readonly capacity: number;
  private readonly ring: Array<JournalEntry | undefined>;
  /** Ring index of the oldest buffered entry. */
  private head = 0;
  private entries = 0;
  private nextSeq = 1;
  private readonly live = new Set<(entry: JournalEntry) => void>();

  constructor(options: EventJournalOptions = {}) {
    const capacity = options.capacity ?? 512;
    if (!Number.isInteger(capacity) || capacity < 8 || capacity > 4096) {
      throw new Error(`event journal capacity must be an integer between 8 and 4096 (${capacity})`);
    }
    this.capacity = capacity;
    this.generation = options.generation ?? randomBytes(4).toString('hex');
    if (options.generation !== undefined && !/^[0-9a-f]{8}$/.test(options.generation)) {
      throw new Error('event journal generation must be 8 hex characters');
    }
    this.ring = new Array<JournalEntry | undefined>(this.capacity);
  }

  /** Highest published sequence (0 while nothing was published). */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** Current journal checkpoint for a connection-local re-synchronisation. */
  get lastId(): string | undefined {
    return this.lastSeq === 0 ? undefined : `${this.generation}-${this.lastSeq}`;
  }

  /** Sequence of the oldest buffered entry (only meaningful when non-empty). */
  get oldestSeq(): number {
    return this.lastSeq - this.entries + 1;
  }

  /** Number of entries currently in the replay window. */
  get size(): number {
    return this.entries;
  }

  /**
   * Assign the next id, buffer the frame and fan it out to live listeners.
   * `data` is stored and sent verbatim as the SSE `data:` line; callers
   * publish contract-validated JSON. Never throws for normal payloads.
   */
  publish(type: JournalEventType, data: string): JournalEntry {
    if (data.includes('\n') || data.includes('\r')) {
      throw new Error('event data must not contain line breaks (SSE data lines are single-line)');
    }
    const entry: JournalEntry = {
      id: `${this.generation}-${this.nextSeq}`,
      seq: this.nextSeq,
      type,
      data,
    };
    if (this.entries === this.capacity) {
      // Evict the oldest entry; the window slides.
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.entries += 1;
    }
    this.ring[(this.head + this.entries - 1) % this.capacity] = entry;
    this.nextSeq += 1;
    for (const listener of [...this.live]) {
      try {
        listener(entry);
      } catch {
        /* A failing sink (e.g. a destroyed socket) must not break the journal. */
      }
    }
    return entry;
  }

  /**
   * All buffered entries with `seq > from`, in global publication order.
   * `from = 0` means "the client received nothing" (first connection) and
   * replays the whole window. Returns `null` when continuity cannot be
   * guaranteed (the boundary fell out of the bounded window) – the caller
   * must then force a re-synchronisation.
   */
  entriesAfter(from: number): JournalEntry[] | null {
    if (!Number.isSafeInteger(from) || from < 0) return null;
    if (this.entries === 0) return from === 0 ? [] : null;
    if (from === 0) {
      const result: JournalEntry[] = [];
      for (let i = 0; i < this.entries; i += 1) {
        const entry = this.ring[(this.head + i) % this.capacity];
        if (entry !== undefined) result.push(entry);
      }
      return result;
    }
    if (from < this.oldestSeq || from > this.lastSeq) return null;
    const result: JournalEntry[] = [];
    for (let i = 0; i < this.entries; i += 1) {
      const entry = this.ring[(this.head + i) % this.capacity];
      if (entry !== undefined && entry.seq > from) result.push(entry);
    }
    return result;
  }

  /**
   * Distinct data-source types published after a sequence (for the
   * connection-local replay notice).
   */
  typesAfter(from: number): JournalEventType[] {
    const entries = this.entriesAfter(from);
    if (entries === null) return [];
    return [...new Set(entries.map((entry) => entry.type))];
  }

  /**
   * Validate a reconnect's `Last-Event-ID` header against this journal.
   * Never throws; every rejected form degrades to an explicit `resync`.
   */
  resolveReconnect(header: string | string[] | undefined): ReplayDecision {
    const raw = Array.isArray(header) ? header[0] : header;
    if (raw === undefined || raw.trim() === '') return { mode: 'resync' };
    const match = LAST_EVENT_ID_PATTERN.exec(raw.trim());
    if (match === null) return { mode: 'resync' };
    // A previous process generation is unmatchable by design (restart).
    if (match[1] !== this.generation) return { mode: 'resync' };
    const seq = Number(match[2]);
    if (!Number.isSafeInteger(seq) || seq < 1) return { mode: 'resync' };
    if (this.entries === 0) return { mode: 'resync' };
    // Future id: the client claims an event this process never published.
    if (seq > this.lastSeq) return { mode: 'resync' };
    // Too old: the id fell out of the bounded replay window.
    if (seq < this.oldestSeq) return { mode: 'resync' };
    return { mode: 'replay', from: seq };
  }

  /**
   * Register a live listener (one per connected stream). No immediate
   * callback: initial/replayed state is delivered explicitly through
   * `entriesAfter()`, which is what keeps reconnect race-free.
   */
  subscribe(listener: (entry: JournalEntry) => void): () => void {
    this.live.add(listener);
    return () => {
      this.live.delete(listener);
    };
  }

  /** Detach all listeners (server shutdown). */
  close(): void {
    this.live.clear();
  }
}
