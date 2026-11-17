import { expect, it, vi } from 'vitest';
import { GpuScheduler, TextEngineUnchanged } from '../../src/engine/gpu-scheduler.js';

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

it('renders a committed image cohort serially with one swap, then admits every waiting text turn', async () => {
  const events: string[] = [],
    first = gate(),
    second = gate(),
    restore = gate();
  const gpu = new GpuScheduler({
    image: async () => {
      events.push('image');
    },
    text: async () => {
      events.push('text');
      await restore.promise;
    },
  });
  const a = gpu.runImage(
    async () => {
      events.push('a');
      await first.promise;
      return 'a';
    },
    undefined,
    false,
    'cohort'
  );
  const unrelated = gpu.runImage(async () => {
    events.push('other');
  });
  const b = gpu.runImage(
    async () => {
      events.push('b');
      await second.promise;
      return 'b';
    },
    undefined,
    false,
    'cohort'
  );
  const nextA = gpu.acquireText(),
    nextB = gpu.acquireText();
  first.resolve();
  await tick();
  expect(events).toEqual(['image', 'a', 'b']);
  expect(gpu.status().activeText).toBe(0);
  second.resolve();
  await tick();
  expect(events).toEqual(['image', 'a', 'b', 'text']);
  restore.resolve();
  expect(await Promise.all([a, b])).toEqual(['a', 'b']);
  const releases = await Promise.all([nextA, nextB]);
  expect(gpu.status().activeText).toBe(2);
  expect(events).not.toContain('other');
  releases.forEach((release) => release());
  await unrelated;
  expect(events).toEqual(['image', 'a', 'b', 'text', 'image', 'other', 'text']);
  await gpu.close();
});

it('retains independent batch successes after an image failure and removes cancelled siblings', async () => {
  const events: string[] = [],
    first = gate(),
    cancel = new AbortController();
  const gpu = new GpuScheduler({
    image: async () => {
      events.push('image');
    },
    text: async () => {
      events.push('text');
    },
  });
  const a = gpu.runImage(
    async () => {
      await first.promise;
      throw Error('bad image');
    },
    undefined,
    false,
    'cohort'
  );
  const b = gpu.runImage(
    async () => {
      events.push('b');
      return 'saved';
    },
    undefined,
    false,
    'cohort'
  );
  const c = gpu.runImage(
    async () => {
      events.push('c');
    },
    cancel.signal,
    false,
    'cohort'
  );
  const cancelled = expect(c).rejects.toThrow('cancelled');
  const failure = expect(a).rejects.toThrow('bad image');
  cancel.abort();
  first.resolve();
  await cancelled;
  await failure;
  expect(await b).toBe('saved');
  expect(events).toEqual(['image', 'b', 'text']);
  await gpu.close();
});

it('loads the image engine when a restored artifact is followed by an unfinished batch sibling', async () => {
  const events: string[] = [];
  const gpu = new GpuScheduler({
    image: async () => {
      events.push('image');
    },
    text: async () => {
      events.push('text');
    },
  });
  const a = gpu.runImage(
    async () => {
      events.push('saved');
    },
    undefined,
    true,
    'cohort'
  );
  const b = gpu.runImage(
    async () => {
      events.push('render');
    },
    undefined,
    false,
    'cohort'
  );
  await Promise.all([a, b]);
  expect(events).toEqual(['saved', 'image', 'render', 'text']);
  await gpu.close();
});

it('drains every active agent turn, blocks new turns, and restores text before returning an image', async () => {
  const events: string[] = [],
    render = gate<string>(),
    restore = gate();
  const gpu = new GpuScheduler({
    image: async () => {
      events.push('load-image');
    },
    text: async () => {
      events.push('load-text');
      await restore.promise;
    },
  });
  const a = await gpu.acquireText(),
    b = await gpu.acquireText();
  const image = gpu.runImage(async () => {
    events.push('render');
    return render.promise;
  });
  let resumed = 0;
  const nextA = gpu.acquireText().then((release) => {
    resumed++;
    return release;
  });
  const nextB = gpu.acquireText().then((release) => {
    resumed++;
    return release;
  });
  a();
  await tick();
  expect(events).toEqual([]);
  expect(resumed).toBe(0);
  b();
  await tick();
  expect(events).toEqual(['load-image', 'render']);
  expect(resumed).toBe(0);
  render.resolve('picture');
  await tick();
  expect(events.at(-1)).toBe('load-text');
  expect(resumed).toBe(0);
  restore.resolve();
  expect(await image).toBe('picture');
  const releases = await Promise.all([nextA, nextB]);
  expect(resumed).toBe(2);
  releases.forEach((release) => release());
  await gpu.close();
});

it('gives waiting text turns a chance between two image requests without text overlap during sampling', async () => {
  const events: string[] = [],
    first = gate();
  const gpu = new GpuScheduler({
    image: async () => {
      events.push('image');
    },
    text: async () => {
      events.push('text');
    },
  });
  const a = gpu.runImage(async () => first.promise);
  const b = gpu.runImage(async () => {
    events.push('second-render');
  });
  const pending = gpu.acquireText();
  first.resolve();
  await a;
  const release = await pending;
  await tick();
  expect(events).toEqual(['image', 'text']);
  release();
  await b;
  expect(events).toEqual(['image', 'text', 'image', 'second-render', 'text']);
  await gpu.close();
});

it('restores text after a render failure and rejects new work if restoration fails', async () => {
  const restore = vi.fn(async () => {});
  const gpu = new GpuScheduler({ image: async () => {}, text: restore });
  await expect(
    gpu.runImage(async () => {
      throw new Error('bad render');
    })
  ).rejects.toThrow('bad render');
  expect(restore).toHaveBeenCalledOnce();
  (await gpu.acquireText())();
  await gpu.close();
  const broken = new GpuScheduler({
    image: async () => {},
    text: async () => {
      throw new Error('bad engine');
    },
  });
  const image = broken.runImage(async () => {});
  const text = broken.acquireText();
  await expect(image).rejects.toThrow('restoration failed');
  await expect(text).rejects.toThrow('restoration failed');
  await expect(broken.acquireText()).rejects.toThrow('restoration failed');
  await broken.close();
});

it('cancelled waiting text/image requests are removed without stopping active agent turns', async () => {
  const engines = { image: vi.fn(async () => {}), text: vi.fn(async () => {}) },
    gpu = new GpuScheduler(engines);
  const release = await gpu.acquireText(),
    abort = new AbortController(),
    textAbort = new AbortController();
  const image = gpu.runImage(async () => {}, abort.signal),
    text = gpu.acquireText(textAbort.signal);
  textAbort.abort();
  await expect(text).rejects.toThrow('cancelled');
  abort.abort();
  await expect(image).rejects.toThrow('cancelled');
  expect(gpu.status().activeText).toBe(1);
  expect(engines.image).not.toHaveBeenCalled();
  release();
  await gpu.close();
});

it('blocks manual service operations while an agent is using the GPU', async () => {
  const gpu = new GpuScheduler({ image: async () => {}, text: async () => {} }),
    action = vi.fn(async () => {});
  const release = await gpu.acquireText();
  await expect(gpu.manual(action)).rejects.toThrow('busy');
  expect(action).not.toHaveBeenCalled();
  release();
  await gpu.manual(action);
  expect(action).toHaveBeenCalledOnce();
  await gpu.close();
});

it('does not restart either engine when image preflight refuses the switch before touching text', async () => {
  const restore = vi.fn(async () => {}),
    gpu = new GpuScheduler({
      image: async () => {
        throw new TextEngineUnchanged('untracked request');
      },
      text: restore,
    });
  await expect(gpu.runImage(async () => {})).rejects.toThrow('untracked request');
  expect(restore).not.toHaveBeenCalled();
  (await gpu.acquireText())();
  await gpu.close();
});

it('keeps the image engine resident in studio and swaps to Qwen only for the enhancement lease', async () => {
  const events: string[] = [];
  const gpu = new GpuScheduler({
    image: async () => {
      events.push('image');
    },
    text: async () => {
      events.push('text');
    },
  });
  gpu.setStudio(true);
  await gpu.runImage(async () => {
    events.push('render');
  });
  expect(events).toEqual(['image', 'render']);
  const release = await gpu.acquireText();
  expect(events.at(-1)).toBe('text');
  let sampled = false;
  const image = gpu.runImage(async () => {
    sampled = true;
  });
  await tick();
  expect(sampled).toBe(false);
  release();
  await image;
  expect(sampled).toBe(true);
  expect(events.at(-1)).toBe('image');
  expect(gpu.status().phase).toBe('image');
  await gpu.close();
});

it('does not admit text early when a queued image is cancelled during a manual engine transition', async () => {
  const gate = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  })();
  const gpu = new GpuScheduler({ image: async () => {}, text: async () => {} });
  const maintenance = gpu.manual(async () => gate.promise);
  const controller = new AbortController();
  const image = gpu.runImage(async () => {}, controller.signal);
  let admitted = false;
  const text = gpu.acquireText().then((release) => {
    admitted = true;
    return release;
  });
  controller.abort();
  await expect(image).rejects.toThrow('cancelled');
  expect(admitted).toBe(false);
  gate.resolve();
  await maintenance;
  (await text)();
  await gpu.close();
});
