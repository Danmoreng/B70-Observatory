/** One admission boundary for every gateway model call, including compaction.
 * An image request closes text admission synchronously. Existing streams drain;
 * after each image cohort, every already waiting text call gets one turn.
 * A committed, bounded batch keeps the image engine until its images finish.
 * A lease belongs to a model request, never to an agent run.
 */
export interface GpuSwitch {
  image(): Promise<void>;
  text(): Promise<void>;
  assertOwnership?(): Promise<void>;
}
/** A preflight refusal that has not touched the running text engine. */
export class TextEngineUnchanged extends Error {}
export type GpuPhase =
  'text' | 'draining' | 'loading-image' | 'image' | 'loading-text' | 'failed' | 'closed';
interface TextWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort: () => void;
}
interface ImageWaiter {
  batch?: string;
  target: 'image' | 'text';
  restoreOnly: boolean;
  action: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
}

export class GpuScheduler {
  private phase: GpuPhase = 'text';
  private activeText = 0;
  private studio = false;
  setStudio(studio: boolean) {
    this.studio = studio;
    this.phase = studio ? 'image' : 'text';
  }
  private texts: TextWaiter[] = [];
  private images: ImageWaiter[] = [];
  private switching = false;
  private maintenance = false;
  private failure?: Error;
  private pending?: Promise<void>;
  constructor(private readonly engines: GpuSwitch) {}
  status() {
    return {
      phase: this.phase,
      activeText: this.activeText,
      waitingText: this.texts.length,
      waitingImages: this.images.length,
    };
  }
  get busy() {
    return (
      this.switching ||
      this.maintenance ||
      this.activeText > 0 ||
      this.images.length > 0 ||
      this.texts.length > 0
    );
  }
  async changeMode(studio: boolean, before: () => Promise<unknown> = async () => {}) {
    return this.manual(async () => {
      await before();
      this.phase = studio ? 'loading-image' : 'loading-text';
      try {
        await this.engines[studio ? 'image' : 'text']();
        this.setStudio(studio);
      } catch (error) {
        this.phase = 'failed';
        throw error;
      }
    });
  }
  async manual<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy || this.failure || this.phase === 'closed')
      throw new Error('GPU orchestration is busy or unavailable.');
    this.maintenance = true;
    try {
      return await action();
    } finally {
      this.maintenance = false;
      if (!this.images.length) this.admitText();
      this.pump();
    }
  }
  acquireText(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('GPU wait cancelled.'));
    if (this.failure || this.phase === 'closed')
      return Promise.reject(this.failure ?? new Error('GPU orchestration closed.'));
    if (this.studio) {
      return new Promise((resolve, reject) => {
        let release!: () => void;
        const done = new Promise<void>((r) => {
          release = r;
        });
        void this.enqueue(
          'text',
          async () => {
            const lease = this.lease();
            const finish = () => {
              signal?.removeEventListener('abort', finish);
              lease();
              release();
            };
            signal?.addEventListener('abort', finish, { once: true });
            resolve(finish);
            if (signal?.aborted) finish();
            await done;
          },
          signal
        ).catch(reject);
      });
    }
    if (!this.switching && !this.maintenance && !this.images.length)
      return Promise.resolve(this.lease());
    if (this.texts.length >= 64) return Promise.reject(new Error('GPU text queue is full.'));
    return new Promise((resolve, reject) => {
      const waiter: TextWaiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          this.texts = this.texts.filter((w) => w !== waiter);
          reject(new Error('GPU wait cancelled.'));
        },
      };
      this.texts.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
  }
  runImage<T>(
    action: () => Promise<T>,
    signal?: AbortSignal,
    restoreOnly = false,
    batch?: string
  ): Promise<T> {
    return this.enqueue('image', action, signal, restoreOnly, batch);
  }
  private enqueue<T>(
    target: 'image' | 'text',
    action: () => Promise<T>,
    signal?: AbortSignal,
    restoreOnly = false,
    batch?: string
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error('Image request cancelled.'));
    if (this.failure || this.phase === 'closed')
      return Promise.reject(this.failure ?? new Error('GPU orchestration closed.'));
    if (this.images.length >= 16) return Promise.reject(new Error('GPU image queue is full.'));
    return new Promise<T>((resolve, reject) => {
      const waiter: ImageWaiter = {
        batch,
        target,
        restoreOnly,
        action,
        resolve: (value) => resolve(value as T),
        reject,
        signal,
        abort: () => {
          this.images = this.images.filter((w) => w !== waiter);
          reject(new Error('Image request cancelled.'));
          if (!this.switching && !this.maintenance && !this.images.length) {
            this.phase = this.studio ? 'image' : 'text';
            this.admitText();
          }
        },
      };
      this.images.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      if (!this.switching) this.phase = 'draining';
      this.pump();
    });
  }
  private lease() {
    this.activeText++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeText--;
      this.pump();
    };
  }
  private admitText() {
    for (const waiter of this.texts.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      if (waiter.signal?.aborted) waiter.reject(new Error('GPU wait cancelled.'));
      else waiter.resolve(this.lease());
    }
  }
  private pump() {
    if (
      this.switching ||
      this.maintenance ||
      this.activeText ||
      this.failure ||
      this.phase === 'closed'
    )
      return;
    const image = this.images.shift();
    if (!image) return;
    image.signal?.removeEventListener('abort', image.abort);
    this.switching = true;
    this.pending = (async () => {
      let value: unknown,
        actionError: unknown,
        failed = false,
        unchanged = false;
      try {
        if (!image.restoreOnly) {
          this.phase = image.target === 'image' ? 'loading-image' : 'loading-text';
          await this.engines[image.target]();
        }
        if (this.failure) throw this.failure;
        this.phase = image.target;
        if (image.signal?.aborted) throw new Error('Image request cancelled.');
        value = await image.action();
      } catch (error) {
        failed = true;
        actionError = error;
        unchanged = error instanceof TextEngineUnchanged;
      }
      const outcomes = [{ waiter: image, value, failed, error: actionError }];
      let batchImageReady = !image.restoreOnly;
      // The batch was committed and queued before its first image starts. Only
      // these siblings bypass the intervening text round; unrelated work keeps
      // the usual fairness boundary. Each image still renders serially.
      while (image.batch && image.target === 'image' && this.phase === 'image' && !this.failure) {
        const index = this.images.findIndex(
          (waiter) => waiter.target === 'image' && waiter.batch === image.batch
        );
        if (index < 0) break;
        const sibling = this.images.splice(index, 1)[0]!;
        sibling.signal?.removeEventListener('abort', sibling.abort);
        try {
          if (!sibling.restoreOnly && !batchImageReady) {
            this.phase = 'loading-image';
            await this.engines.image();
            this.phase = 'image';
            batchImageReady = true;
          }
          if (sibling.signal?.aborted) throw new Error('Image request cancelled.');
          const result = await sibling.action();
          outcomes.push({ waiter: sibling, value: result, failed: false, error: undefined });
        } catch (error) {
          outcomes.push({ waiter: sibling, value: undefined, failed: true, error });
        }
      }
      if (this.failure) {
        this.phase = 'closed';
        this.switching = false;
        outcomes.forEach((outcome) => outcome.waiter.reject(this.failure));
        return;
      }
      try {
        if (!unchanged && (!this.studio || image.target === 'text')) {
          this.phase = this.studio ? 'loading-image' : 'loading-text';
          await this.engines[this.studio ? 'image' : 'text']();
        }
      } catch {
        this.failure = new Error('Text engine restoration failed. Saved image jobs are retained.');
        this.phase = 'failed';
        outcomes.forEach((outcome) => outcome.waiter.reject(this.failure));
        for (const waiter of this.texts.splice(0)) {
          waiter.signal?.removeEventListener('abort', waiter.abort);
          waiter.reject(this.failure);
        }
        for (const waiter of this.images.splice(0)) {
          waiter.signal?.removeEventListener('abort', waiter.abort);
          waiter.reject(this.failure);
        }
        return;
      } finally {
        this.switching = false;
      }
      this.phase = this.studio ? 'image' : 'text';
      // Reserve these text turns before resolving the image tool. They cannot be
      // overtaken by another queued image or by a fast agent's next request.
      this.admitText();
      for (const outcome of outcomes) {
        if (outcome.failed) outcome.waiter.reject(outcome.error);
        else outcome.waiter.resolve(outcome.value);
      }
      if (this.images.length) this.phase = 'draining';
      this.pump();
    })();
  }
  pause() {
    const error = new Error('GPU orchestration closed.');
    this.failure = error;
    this.phase = 'closed';
    for (const w of this.texts.splice(0)) {
      w.signal?.removeEventListener('abort', w.abort);
      w.reject(error);
    }
    for (const w of this.images.splice(0)) {
      w.signal?.removeEventListener('abort', w.abort);
      w.reject(error);
    }
  }
  async close() {
    this.pause();
    await this.pending;
  }
}
