import type { AgentLiveChanges } from '@observatory/contracts';

const CACHE_TTL_MS = 3_000;

/** On-demand only: bounded memory, one helper process globally, shared per-run promises. */
export class LiveChangesCache {
  private readonly values = new Map<string, { attemptedAt: number; value: AgentLiveChanges }>();
  private readonly pending = new Map<string, Promise<AgentLiveChanges>>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(
    taskId: string,
    runId: string,
    capture: () => Promise<AgentLiveChanges>,
    phase = '',
    force = false
  ): Promise<AgentLiveChanges> {
    const key = `${taskId}:${runId}:${phase}`;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const cached = this.values.get(key);
    if (!force && cached && this.now() - cached.attemptedAt < CACHE_TTL_MS) return cached.value;
    const unavailable = (message: string): AgentLiveChanges =>
      cached
        ? { ...cached.value, stale: true, message }
        : {
            taskId,
            runId,
            capturedAt: new Date(this.now()).toISOString(),
            status: 'unavailable',
            stale: true,
            truncated: false,
            files: [],
            diff: '',
            message,
          };
    if (this.pending.size > 0) return unavailable('Another workspace preview is being captured.');
    const operation = Promise.resolve()
      .then(capture)
      .catch(() =>
        unavailable(
          'Workspace preview is temporarily unavailable. The last captured state is shown.'
        )
      )
      .then((value) => {
        this.values.delete(key);
        this.values.set(key, { attemptedAt: this.now(), value });
        while (this.values.size > 32) this.values.delete(this.values.keys().next().value!);
        return value;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, operation);
    return operation;
  }
}
