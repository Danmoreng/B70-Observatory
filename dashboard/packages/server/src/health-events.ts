import type { HealthPayload } from '@observatory/contracts';

export type HealthListener = (payload: HealthPayload) => void;

/**
 * One shared local health watcher for every connected browser.
 *
 * The watcher may inspect local state periodically, but it publishes only when
 * the semantic status/check list changes. Timestamps and uptime deliberately do
 * not create events. With no listeners the timer is stopped entirely.
 */
export class HealthEventHub {
  private readonly listeners = new Set<HealthListener>();
  private lastPayload: HealthPayload | undefined;
  private lastKey: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  /**
   * M5C: sink toward the shared event journal. Semantically changed health
   * states are published there under a globally ordered event id; the
   * journal owns buffering, replay and the live fan-out to browser streams.
   */
  private readonly sink: HealthListener;

  constructor(
    private readonly snapshot: () => HealthPayload,
    private readonly intervalMs = 5000,
    sink?: HealthListener
  ) {
    this.sink = sink ?? (() => undefined);
  }

  /** The last captured health payload (current state to re-announce). */
  get current(): HealthPayload | undefined {
    return this.lastPayload;
  }

  subscribe(listener: HealthListener): () => void {
    this.capture(this.listeners.size > 0);
    this.listeners.add(listener);
    if (this.lastPayload !== undefined) listener(this.lastPayload);
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.checkNow(), this.intervalMs);
      this.timer.unref();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopTimer();
    };
  }

  /** Public for deterministic tests and future event-driven collector triggers. */
  checkNow(): void {
    this.capture(true);
  }

  close(): void {
    this.listeners.clear();
    this.stopTimer();
  }

  private capture(publish: boolean): void {
    const candidate = this.snapshot();
    const key = JSON.stringify({ status: candidate.status, checks: candidate.checks });
    const changed = key !== this.lastKey;
    this.lastKey = key;
    this.lastPayload = candidate;
    if (publish && changed) {
      this.sink(candidate);
      for (const listener of this.listeners) listener(candidate);
    }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function encodeHealthEvent(payload: HealthPayload): string {
  return `event: health\ndata: ${JSON.stringify(payload)}\n\n`;
}
