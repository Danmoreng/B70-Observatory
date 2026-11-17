import type { SystemSnapshot, VllmTelemetryPayload } from '@observatory/contracts';
import { telemetrySemanticKey } from './collector.js';
import { systemSemanticKey } from './system-collector.js';

export type TelemetryListener = (payload: VllmTelemetryPayload) => void;
export type SystemListener = (payload: SystemSnapshot) => void;

/**
 * Fan-out of one snapshot stream to the connected browser SSE streams.
 *
 * The hubs have **no timer of their own**: the collectors are the only
 * producers (server-side collection of local sources is the documented
 * exception to the "no polling" rule). The hub merely guarantees that a
 * snapshot is forwarded once per *semantic* change: a snapshot whose
 * quantized key matches the previously published one is dropped, so clients
 * never receive timestamp-only or otherwise identical frames.
 */
class SnapshotHub<T> {
  private readonly listeners = new Set<(payload: T) => void>();
  private latest: T | undefined;
  private lastKey: string | undefined;
  /**
   * M5C: the shared event journal. Semantic changes are published there
   * under a globally ordered event id; per-connection fan-out, replay and
   * re-synchronisation are handled by the journal and the SSE route.
   */
  private sink: ((payload: T) => void) | undefined;

  constructor(private readonly keyOf: (payload: T) => string) {}

  /** Wire the hub to the shared journal (set once, before publishing). */
  setSink(sink: (payload: T) => void): void {
    this.sink = sink;
  }

  /**
   * Publish a snapshot.
   * @returns `true` if the snapshot was forwarded (semantic change).
   */
  publish(payload: T): boolean {
    const key = this.keyOf(payload);
    const changed = this.latest === undefined || key !== this.lastKey;
    this.latest = payload;
    this.lastKey = key;
    if (!changed) return false;
    this.sink?.(payload);
    for (const listener of this.listeners) listener(payload);
    return true;
  }

  /**
   * Subscribe a listener; it immediately receives the last published
   * snapshot (initial state on (re)connect). Returns an unsubscribe.
   */
  subscribe(listener: (payload: T) => void): () => void {
    this.listeners.add(listener);
    if (this.latest !== undefined) listener(this.latest);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get latestSnapshot(): T | undefined {
    return this.latest;
  }

  /** Detach all listeners (called on server shutdown). */
  close(): void {
    this.listeners.clear();
  }
}

/** M4A hub: vLLM telemetry snapshots (`event: telemetry`). */
export class TelemetryHub {
  private readonly hub = new SnapshotHub<VllmTelemetryPayload>(telemetrySemanticKey);

  setSink(sink: (payload: VllmTelemetryPayload) => void): void {
    this.hub.setSink(sink);
  }

  publish(payload: VllmTelemetryPayload): boolean {
    return this.hub.publish(payload);
  }

  subscribe(listener: TelemetryListener): () => void {
    return this.hub.subscribe(listener);
  }

  get latestSnapshot(): VllmTelemetryPayload | undefined {
    return this.hub.latestSnapshot;
  }

  close(): void {
    this.hub.close();
  }
}

/** M4B hub: system & GPU snapshots (`event: system`). */
export class SystemHub {
  private readonly hub = new SnapshotHub<SystemSnapshot>(systemSemanticKey);

  setSink(sink: (payload: SystemSnapshot) => void): void {
    this.hub.setSink(sink);
  }

  publish(payload: SystemSnapshot): boolean {
    return this.hub.publish(payload);
  }

  subscribe(listener: SystemListener): () => void {
    return this.hub.subscribe(listener);
  }

  get latestSnapshot(): SystemSnapshot | undefined {
    return this.hub.latestSnapshot;
  }

  close(): void {
    this.hub.close();
  }
}
