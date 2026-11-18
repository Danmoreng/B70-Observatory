import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { SystemSnapshotSchema } from '@observatory/contracts';
import WorkspaceHome from '../src/components/WorkspaceHome.vue';

enableAutoUnmount(afterEach);
afterEach(() => vi.unstubAllGlobals());

it('shows measured uptime and direct recent-work links without loading the cockpit', async () => {
  const taskId = 'd58075de-6b30-44a6-9528-55167e259af1';
  const projectId = '38eecc0e-fbb3-4750-a32a-ebfd7e0bf301';
  const updatedAt = '2026-11-18T20:37:00.000Z';
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) =>
    Response.json(
      url === '/api/agent/recent-work'
        ? {
            tasks: [
              {
                id: taskId,
                title: 'Update tests',
                projectName: 'Engine',
                updatedAt,
                runStatus: 'completed',
              },
            ],
            projects: [{ id: projectId, name: 'Engine', updatedAt }],
          }
        : {
            hostUptimeSeconds: 7260,
            text: { state: 'inactive' },
            image: { state: 'active', uptimeSeconds: 180 },
          }
    )
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
  expect(page.get('a[href="#/agent/' + taskId + '"]').text()).toContain('Update tests');
  expect(page.get('a[href="#/projects/' + projectId + '"]').text()).toContain('Engine');
  expect(fetch.mock.calls.map((call) => call[0]).sort()).toEqual([
    '/api/agent/recent-work',
    '/api/engine/runtimes',
  ]);
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
