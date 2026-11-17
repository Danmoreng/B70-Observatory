import { setLocale } from '../src/lib/i18n.js';
import { flushPromises, mount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import ComfyDesk from '../src/studio/ComfyDesk.vue';
import { draft, currentImage, followQueue } from '../src/studio/desk.js';

it('uses the integrated API for the large prompt editor, a manual job, gallery and original download', async () => {
  location.hash = '#/studio';
  Object.assign(draft, {
    prompt: '',
    sizeId: 'landscape-quick',
    seed: '-1',
    count: 1,
    mode: 'generate',
    referenceIds: [],
    sampler: 'euler',
    scheduler: 'simple',
    noiseStart: 1.1,
    noiseEnd: 0.9,
  });
  const image = {
    id: 'b'.repeat(20),
    title: 'Alpine lake',
    category: 'New images',
    comparisonKey: 'lake',
    created: 1,
    width: 1536,
    height: 1024,
    bytes: 100,
    prompt: 'A lake',
    seed: 1,
    steps: 6,
    cfg: 1,
    sampler: 'euler',
    scheduler: 'simple',
    model: 'H3',
    quantization: 'INT8',
    favorite: false,
    pinned: false,
    rating: 0,
    keywords: [],
    generationTime: 80,
    jobId: null,
    hasWorkflow: false,
    hasPreview: false,
    mode: 'generate',
    references: [],
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/studio/api/config')
      return Response.json({
        sizes: [
          {
            id: 'landscape-quick',
            label: 'Landscape quick',
            ratio: '3:2',
            width: 1536,
            height: 1024,
          },
          {
            id: 'portrait-quick',
            label: 'Portrait quick',
            ratio: '2:3',
            width: 1024,
            height: 1536,
          },
        ],
        acceptingJobs: true,
        sampling: {
          samplers: ['euler', 'lcm', 'heun'],
          schedulers: ['simple', 'beta', 'sgm_uniform'],
        },
        freeGiB: 80,
        promptExpansion: { available: true, maxReferences: 4, model: 'Qwen 27B' },
      });
    if (url === '/api/studio/api/jobs')
      return Response.json(
        init?.method === 'POST'
          ? { ids: ['a'.repeat(32)] }
          : { jobs: [], engine: { online: true, busy: false }, acceptingJobs: true }
      );
    if (url === '/api/studio/api/images') return Response.json({ images: [image, olderImage] });
    if (url === '/api/studio/api/references') return Response.json({ references: [] });
    throw new Error('Unexpected API route: ' + url);
  });
  const olderImage = {
    ...image,
    id: 'c'.repeat(20),
    title: 'Earlier portrait',
    prompt: 'An earlier studio portrait with dramatic light',
    seed: 0,
    width: 1024,
    height: 1536,
    sampler: 'lcm',
    scheduler: 'sgm_uniform',
    noiseStart: 1.25,
    noiseEnd: 0.75,
  };
  vi.stubGlobal('fetch', fetcher);
  const view = mount(ComfyDesk);
  try {
    await flushPromises();
    expect(view.text()).not.toContain('ab 22:30 Uhr gesperrt');
    expect(view.get('textarea#prompt').classes()).toContain('desk-prompt');
    expect(view.get('.desk-prompt-toolbar label').text()).toBe('Prompt');
    await view.get('textarea#prompt').setValue('A dramatic alpine landscape photograph');
    expect(view.get('[aria-label="Noise start"]').attributes('disabled')).toBeDefined();
    await view.get('[aria-label="Sampler"]').setValue('lcm');
    await view.get('[aria-label="Scheduler"]').setValue('beta');
    expect(view.get('[aria-label="Noise start"]').attributes('disabled')).toBeUndefined();
    await view.get('[aria-label="Noise start"]').setValue('');
    await view.get('#generation-form').trigger('submit');
    await flushPromises();
    expect(
      fetcher.mock.calls.some(
        ([url, init]) => url === '/api/studio/api/jobs' && init?.method === 'POST'
      )
    ).toBe(false);
    await view.get('[aria-label="Noise start"]').setValue('1.27');
    await view.get('[aria-label="Noise end"]').setValue('0.81');
    await view.get('#generation-form').trigger('submit');
    await flushPromises();
    expect(
      fetcher.mock.calls.some(
        ([url, init]) =>
          url === '/api/studio/api/jobs' &&
          init?.method === 'POST' &&
          JSON.parse(String(init.body)).prompt === 'A dramatic alpine landscape photograph'
      )
    ).toBe(true);
    const submitted = fetcher.mock.calls.find(
      ([url, init]) => url === '/api/studio/api/jobs' && init?.method === 'POST'
    )!;
    expect(JSON.parse(String(submitted[1]!.body))).toMatchObject({
      sampler: 'lcm',
      scheduler: 'beta',
      noiseStart: 1.27,
      noiseEnd: 0.81,
    });
    location.hash = '#/gallery';
    window.dispatchEvent(new Event('hashchange'));
    await flushPromises();
    expect(view.findAll('.desk-image-card')).toHaveLength(2);
    expect(view.get('a[download]').attributes('href')).toBe(
      '/api/studio/media/' + image.id + '/original?download=1'
    );
    expect(view.findAll('[aria-label="Delete Alpine lake permanently"]')).toHaveLength(1);
    // Reuse an older, differently sized image with no manual job ID. Polling
    // must keep the selected preview instead of silently showing the newest.
    await view
      .findAll('.desk-image-card')[1]!
      .findAll('button')
      .find((b) => b.text() === 'Reuse')!
      .trigger('click');
    await flushPromises();
    expect(location.hash).toBe('#/studio');
    expect((view.get('#prompt').element as HTMLTextAreaElement).value).toBe(olderImage.prompt);
    expect((view.get('[aria-label="Seed"]').element as HTMLInputElement).value).toBe('0');
    expect((view.get('[aria-label="Image width"]').element as HTMLSelectElement).value).toBe(
      '1024'
    );
    expect((view.get('[aria-label="Image height"]').element as HTMLSelectElement).value).toBe(
      '1536'
    );
    expect((view.get('[aria-label="Aspect ratio"]').element as HTMLSelectElement).value).toBe(
      '2:3'
    );
    expect(draft.count).toBe(1);
    expect(draft).toMatchObject({
      sampler: 'lcm',
      scheduler: 'sgm_uniform',
      noiseStart: 1.25,
      noiseEnd: 0.75,
    });
    expect((view.get('[aria-label="Sampler"]').element as HTMLSelectElement).value).toBe('lcm');
    expect((view.get('[aria-label="Scheduler"]').element as HTMLSelectElement).value).toBe(
      'sgm_uniform'
    );
    expect(followQueue.value).toBe(false);
    expect(currentImage.value?.id).toBe(olderImage.id);
    expect(view.get('.desk-preview img').attributes('src')).toContain(olderImage.id);
    setLocale('de');
    await flushPromises();
    expect(view.get('.desk-section-title').text()).toContain('Parameter');
    expect(view.get('[aria-label="Bildbreite"]').element).toBeTruthy();
    expect(view.get('[aria-label="Rauschen Start"]').element).toBeTruthy();
    expect(
      view
        .findAll('.desk-result [data-image-action]')
        .map((button) => button.attributes('data-image-action'))
    ).toEqual(['reuse', 'edit', 'download']);
    expect(view.get('[data-image-action="reuse"]').attributes('aria-label')).toBe(
      'Prompt und Einstellungen übernehmen'
    );
    const modes = view.get('[aria-label="Bildmodus"]').findAll('button');
    await modes[1]!.trigger('click');
    expect(draft.mode).toBe('edit');
    expect(view.get('.desk-generate').text()).toBe('Bearbeitung generieren');
    await modes[0]!.trigger('click');
    expect(draft.mode).toBe('generate');
    setLocale('en');
    await flushPromises();
    await view.get('[aria-label="Seed"]').setValue('1234567890');
    await view.get('[aria-label="Batch size"]').setValue('3');
    expect(draft.seed).toBe('1234567890');
    expect(draft.count).toBe(3);
    await view.get('[aria-label="View image"]').trigger('click');
    await flushPromises();
    await view
      .findAll('.desk-viewer button')
      .find((b) => b.attributes('data-image-action') === 'reuse')!
      .trigger('click');
    await flushPromises();
    expect((view.get('[aria-label="Seed"]').element as HTMLInputElement).value).toBe('0');
    expect(view.get('.desk-viewer').attributes('open')).toBeUndefined();
    await view.get('[aria-label="Seed"]').setValue('1234567890');
    await view.get('#generation-form').trigger('submit');
    await flushPromises();
    expect(
      fetcher.mock.calls.some(
        ([url, init]) =>
          url === '/api/studio/api/jobs' &&
          init?.method === 'POST' &&
          JSON.parse(String(init.body)).seed === 1234567890
      )
    ).toBe(true);
    expect(JSON.parse(localStorage.getItem('diffusion-desk-h3-draft')!).seed).toBe('1234567890');
    expect(JSON.parse(localStorage.getItem('diffusion-desk-h3-draft')!)).toMatchObject({
      sampler: 'lcm',
      scheduler: 'sgm_uniform',
      noiseStart: 1.25,
      noiseEnd: 0.75,
    });
    await view.get('.desk-section-title button').trigger('click');
    expect(draft).toMatchObject({
      sampler: 'euler',
      scheduler: 'simple',
      noiseStart: 1.1,
      noiseEnd: 0.9,
    });
    expect(view.get('[aria-label="Noise start"]').attributes('disabled')).toBeDefined();
  } finally {
    setLocale('en');
    view.unmount();
    vi.unstubAllGlobals();
    location.hash = '#/overview';
  }
});
