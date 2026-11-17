/** In-process invalidation after successful writes. Observers cannot fail a write. */
export class ChangeSignal {
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observability must not affect the data path. */
      }
    }
  }
}
