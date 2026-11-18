import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { SystemSnapshotSchema } from '@observatory/contracts';
import WorkspaceHome from '../src/components/WorkspaceHome.vue';

enableAutoUnmount(afterEach);
afterEach(() => vi.unstubAllGlobals());

it('shows measured host and engine uptime, real zero load, and a bounded overview without tasks or projects', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      hostUptimeSeconds: 7260,
      text: { state: 'inactive' },
      image: { state: 'active', uptimeSeconds: 180 },
    })
  );
  vi.stubGlobal('fetch', fetch);
  const system = SystemSnapshotSchema.parse({
    service: 'local-ai-b70-observatory',
    sourceStatus: 'ok',
    timestamp: new Date().toISOString(),
    cpu: { coreCount: 8, utilizationPercent: 0 },
    gpu: { available: false, reason: 'Offline' },
  });
  const page = mount(WorkspaceHome, { props: { system, current: true } });
  await flushPromises();
  expect(page.find('.host-uptime').text()).toContain('2 h 01 min');
  expect(page.get('[data-state="active"]').text()).toContain('ComfyUI');
  expect(page.get('[data-state="active"]').text()).toContain('3 min');
  expect(page.get('[data-state="inactive"]').text()).toContain('Stopped');
  expect(page.find('a[href="#/hardware"]').exists()).toBe(true);
  expect(page.findAll('.resource').map((item) => item.get('strong').text())).toEqual([
    '–',
    '–',
    '0 %',
    '–',
  ]);
  expect(fetch.mock.calls.map((call) => call[0])).toEqual(['/api/engine/runtimes']);
  expect(page.find('.workspace-task-row, .shared-project-card').exists()).toBe(false);
});

it('marks failed engine reads as unknown and labels an older system sample', async () => {
  vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }));
  const system = SystemSnapshotSchema.parse({
    service: 'local-ai-b70-observatory',
    sourceStatus: 'ok',
    timestamp: new Date().toISOString(),
    gpu: { available: false, reason: 'Offline' },
  });
  const page = mount(WorkspaceHome, { props: { system, current: false } });
  await flushPromises();
  expect(page.findAll('[data-state="unknown"]')).toHaveLength(2);
  expect(page.get('.sample-status').text()).toContain('Last reading');
  expect(page.get('.host-uptime strong').text()).toBe('–');
});
