import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ImageJobs } from '../../src/engine/image-jobs.js';
import { GpuScheduler } from '../../src/engine/gpu-scheduler.js';
import { comfyFixture, PREVIEW } from './image-fixture.js';

afterEach(() => vi.useRealTimers());
function time() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T11:00:00+01:00'));
}
const input = {
  key: 'a'.repeat(64),
  prompt: 'A red boat on a misty lake',
  sizeId: 'landscape-quick',
  seed: 5,
};

it('atomically persists a replay-safe image batch, serially renders it with one swap and retains a deletion tombstone', async () => {
  time();
  const root = await mkdtemp(join(tmpdir(), 'b70-image-batch-')),
    fake = comfyFixture(),
    events: string[] = [];
  const gpu = new GpuScheduler({
    image: async () => {
      events.push('image');
    },
    text: async () => {
      events.push('text');
    },
  });
  const jobs = new ImageJobs(root, gpu, fake.engine);
  const batch = { id: 'f'.repeat(64), images: [input, { ...input, key: 'b'.repeat(64), seed: 6 }] };
  const release = await gpu.acquireText();
  try {
    const [a, b] = await Promise.all([jobs.submitBatch(batch), jobs.submitBatch(batch)]);
    expect(a.map((job) => job.id)).toEqual(b.map((job) => job.id));
    expect(jobs.metrics()).toHaveLength(2);
    const nextText = gpu.acquireText();
    release();
    await vi.waitFor(() =>
      expect(a.map((job) => jobs.get(job.id).status)).toEqual(['completed', 'completed'])
    );
    (await nextText)();
    expect(fake.state.submissions).toBe(2);
    expect(events).toEqual(['image', 'text']);
    expect((await jobs.submitBatch(batch)).map((job) => job.id)).toEqual(a.map((job) => job.id));
    await expect(
      jobs.submitBatch({
        ...batch,
        images: [input, { ...batch.images[1], prompt: 'Changed prompt' }],
      })
    ).rejects.toThrow('different parameters');
    await jobs.purge([a[0]!.id]);
    expect(jobs.batch(batch.id).fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(jobs.submitBatch(batch)).rejects.toThrow('cancelled');
    expect(fake.state.submissions).toBe(2);
  } finally {
    release();
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses an invalid, conflicting or cancelled batch without partially inserting images', async () => {
  time();
  const root = await mkdtemp(join(tmpdir(), 'b70-image-batch-')),
    fake = comfyFixture();
  const jobs = new ImageJobs(
    root,
    new GpuScheduler({ image: async () => {}, text: async () => {} }),
    fake.engine
  );
  try {
    const batch = { id: 'f'.repeat(64), images: [input, { ...input, key: 'b'.repeat(64) }] };
    await expect(jobs.submitBatch({ ...batch, images: [input, input] })).rejects.toThrow();
    await expect(
      jobs.submitBatch({ ...batch, images: [input, { ...batch.images[1], workflow: {} }] })
    ).rejects.toThrow();
    jobs.cancelBatch(batch);
    await expect(jobs.submitBatch(batch)).rejects.toThrow('cancelled');
    expect(jobs.metrics()).toEqual([]);
    expect(() => jobs.batch(batch.id)).toThrow('not found');
    expect(fake.state.submissions).toBe(0);
  } finally {
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('restarts a persisted batch without duplicating its first render and only restores text after the batch', async () => {
  time();
  const root = await mkdtemp(join(tmpdir(), 'b70-image-batch-')),
    fake = comfyFixture(),
    events: string[] = [];
  fake.state.finished = false;
  const engines = {
    image: async () => {
      events.push('image');
    },
    text: async () => {
      events.push('text');
    },
  };
  const batch = { id: 'e'.repeat(64), images: [input, { ...input, key: 'c'.repeat(64) }] };
  const first = new ImageJobs(root, new GpuScheduler(engines), fake.engine);
  const saved = await first.submitBatch(batch);
  await vi.waitFor(() => expect(fake.state.submissions).toBe(1));
  await first.close();
  const second = new ImageJobs(root, new GpuScheduler(engines), fake.engine);
  try {
    fake.state.finished = true;
    second.start();
    await vi.waitFor(() =>
      expect(saved.map((job) => second.get(job.id).status)).toEqual(['completed', 'completed'])
    );
    expect(fake.state.submissions).toBe(2);
    expect(fake.state.interrupted).toBe(0);
    expect(events).toEqual(['image', 'image', 'text']);
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('recovers every saved batch artifact after restoration failure without rendering again', async () => {
  time();
  const root = await mkdtemp(join(tmpdir(), 'b70-image-batch-')),
    fake = comfyFixture();
  const first = new ImageJobs(
    root,
    new GpuScheduler({
      image: async () => {},
      text: async () => {
        throw Error('text failed');
      },
    }),
    fake.engine
  );
  const batch = { id: 'd'.repeat(64), images: [input, { ...input, key: 'd'.repeat(64) }] };
  const saved = await first.submitBatch(batch);
  await vi.waitFor(() =>
    expect(saved.map((job) => first.get(job.id).status)).toEqual(['failed', 'failed'])
  );
  for (const job of saved) expect(await first.artifact(job.id, true)).toEqual(PREVIEW);
  await first.close();
  const image = vi.fn(async () => {}),
    text = vi.fn(async () => {});
  const second = new ImageJobs(root, new GpuScheduler({ image, text }), fake.engine);
  try {
    second.start();
    await vi.waitFor(() =>
      expect(saved.map((job) => second.get(job.id).status)).toEqual(['completed', 'completed'])
    );
    expect(fake.state.submissions).toBe(2);
    expect(image).not.toHaveBeenCalled();
    expect(text).toHaveBeenCalledOnce();
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('persists one job for concurrent/repeated calls, preserves the fixed INT8 recipe, and completes after text restoration', async () => {
  time();
  const root = await mkdtemp(join(tmpdir(), 'b70-images-')),
    fake = comfyFixture();
  const text = vi.fn(async () => {}),
    gpu = new GpuScheduler({ image: async () => {}, text }),
    jobs = new ImageJobs(root, gpu, fake.engine);
  const release = await gpu.acquireText();
  try {
    const [a, b] = await Promise.all([jobs.submit(input), jobs.submit(input)]);
    expect(a.id).toBe(b.id);
    expect(fake.state.submissions).toBe(0);
    release();
    await vi.waitFor(() => expect(jobs.get(a.id).status).toBe('completed'));
    expect(fake.state.submissions).toBe(1);
    expect(text).toHaveBeenCalledOnce();
    expect(fake.state.graph['1']!.inputs.unet_name).toContain('int8_convrot');
    expect(fake.state.graph['7']!.inputs.steps).toBe(6);
    expect(await jobs.artifact(a.id, true)).toEqual(PREVIEW);
    expect((await jobs.submit(input)).id).toBe(a.id);
    expect(fake.state.submissions).toBe(1);
    await expect(jobs.submit({ ...input, prompt: 'different' })).rejects.toThrow(
      'different parameters'
    );
    await expect(jobs.submit({ ...input, workflow: {} })).rejects.toThrow();
  } finally {
    release();
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('reattaches after a process restart without submitting or interrupting a second image', async () => {
  time();
  const root = await mkdtemp(join(tmpdir(), 'b70-images-')),
    fake = comfyFixture();
  fake.state.finished = false;
  const engines = { image: async () => {}, text: async () => {} };
  const first = new ImageJobs(root, new GpuScheduler(engines), fake.engine);
  const job = await first.submit(input);
  await vi.waitFor(() => expect(fake.state.submissions).toBe(1));
  await first.close();
  expect(fake.state.interrupted).toBe(0);
  const second = new ImageJobs(root, new GpuScheduler(engines), fake.engine);
  try {
    fake.state.finished = true;
    second.start();
    await vi.waitFor(() => expect(second.get(job.id).status).toBe('completed'));
    expect(fake.state.submissions).toBe(1);
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('cancels only its queued image, then admits the waiting agent without an engine swap', async () => {
  time();
  const root = await mkdtemp(join(tmpdir(), 'b70-images-')),
    fake = comfyFixture(),
    image = vi.fn(async () => {});
  const gpu = new GpuScheduler({ image, text: async () => {} }),
    jobs = new ImageJobs(root, gpu, fake.engine);
  const release = await gpu.acquireText();
  try {
    const job = await jobs.submit(input),
      pending = gpu.acquireText();
    jobs.cancel(job.id);
    await vi.waitFor(() => expect(jobs.get(job.id).status).toBe('cancelled'));
    (await pending)();
    expect(image).not.toHaveBeenCalled();
  } finally {
    release();
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves the artifact if restoring vLLM fails and recovers it without another render', async () => {
  time();
  const root = await mkdtemp(join(tmpdir(), 'b70-images-')),
    fake = comfyFixture();
  const first = new ImageJobs(
    root,
    new GpuScheduler({
      image: async () => {},
      text: async () => {
        throw new Error('engine failed');
      },
    }),
    fake.engine
  );
  const job = await first.submit(input);
  await vi.waitFor(() => expect(first.get(job.id).status).toBe('failed'));
  expect(await first.artifact(job.id, true)).toEqual(PREVIEW);
  await first.close();
  const second = new ImageJobs(
    root,
    new GpuScheduler({ image: async () => {}, text: async () => {} }),
    fake.engine
  );
  try {
    second.start();
    await vi.waitFor(() => expect(second.get(job.id).status).toBe('completed'));
    expect(fake.state.submissions).toBe(1);
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('interrupts its own running image and restores both waiting text turns after cancellation', async () => {
  time();
  const root = await mkdtemp(join(tmpdir(), 'b70-images-')),
    fake = comfyFixture();
  fake.state.finished = false;
  const text = vi.fn(async () => {}),
    gpu = new GpuScheduler({ image: async () => {}, text }),
    jobs = new ImageJobs(root, gpu, fake.engine);
  try {
    const job = await jobs.submit(input);
    await vi.waitFor(() => expect(fake.state.submissions).toBe(1));
    const a = gpu.acquireText(),
      b = gpu.acquireText();
    jobs.cancel(job.id);
    await vi.waitFor(() => expect(jobs.get(job.id).status).toBe('cancelled'));
    (await a)();
    (await b)();
    expect(fake.state.interrupted).toBe(1);
    expect(text).toHaveBeenCalledOnce();
  } finally {
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('persists cancellation before a delayed submission can create an orphan image', async () => {
  time();
  const root = await mkdtemp(join(tmpdir(), 'b70-images-')),
    fake = comfyFixture();
  const jobs = new ImageJobs(
    root,
    new GpuScheduler({ image: async () => {}, text: async () => {} }),
    fake.engine
  );
  try {
    const id = createHash('sha256').update(input.key).digest('hex').slice(0, 32);
    jobs.cancel(id, input.key);
    await expect(jobs.submit(input)).rejects.toThrow('cancelled');
    expect(fake.state.submissions).toBe(0);
    expect(() => jobs.cancel(id, 'b'.repeat(64))).toThrow('Invalid');
  } finally {
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('purges private artifacts and prompt metadata when deleting a gallery image and prevents replay regeneration', async () => {
  time();
  const root = await mkdtemp(join(tmpdir(), 'b70-images-purge-')),
    fake = comfyFixture();
  const gpu = new GpuScheduler({ image: async () => {}, text: async () => {} }),
    jobs = new ImageJobs(root, gpu, fake.engine);
  try {
    const release = await gpu.acquireText();
    const job = await jobs.submit(input);
    expect(() => jobs.assertDeletable([job.id])).toThrow('Wait for image');
    release();
    await vi.waitFor(() => expect(jobs.get(job.id).status).toBe('completed'));
    await jobs.purge([job.id]);
    expect(() => jobs.get(job.id)).toThrow('not found');
    await expect(jobs.artifact(job.id, false)).rejects.toThrow('not found');
    await expect(jobs.submit(input)).rejects.toThrow('cancelled');
    await jobs.purge([job.id]);
    expect(fake.state.submissions).toBe(1);
  } finally {
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rechecks Hybrid admission after asynchronous disk checks so a concurrent mode change cannot submit an image', async () => {
  time();
  const root = await mkdtemp(join(tmpdir(), 'b70-image-mode-race-')),
    fake = comfyFixture();
  let allowed = true;
  const gpu = new GpuScheduler({ image: async () => {}, text: async () => {} }),
    jobs = new ImageJobs(root, gpu, fake.engine, () => allowed);
  try {
    const pending = jobs.submit(input);
    allowed = false;
    await expect(pending).rejects.toThrow('Hybrid mode');
    expect(fake.state.submissions).toBe(0);
  } finally {
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});
