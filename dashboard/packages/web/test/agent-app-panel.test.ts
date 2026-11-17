import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppPreviewSchema, type AppPreview } from '@observatory/contracts';
import { stopAppPreview } from '../src/lib/api.js';
import AgentAppPanel from '../src/components/agent/AgentAppPanel.vue';

enableAutoUnmount(afterEach);

const projectId = '10000000-0000-4000-8000-000000000001';
const revision = 'a'.repeat(40);

const mockState = vi.hoisted(() => ({
  preview: undefined as AppPreview | undefined,
}));

vi.mock('../src/lib/api.js', () => ({
  fetchAppPreview: vi.fn(async () => {
    if (mockState.preview === undefined) throw new Error('no preview yet');
    return mockState.preview;
  }),
  startAppPreview: vi.fn(async () => mockState.preview),
  stopAppPreview: vi.fn(async () => mockState.preview),
}));

const preview = (status: AppPreview['status']): AppPreview =>
  AppPreviewSchema.parse({
    projectId,
    status,
    ...(status === 'running'
      ? { revision, port: 8090, accessPath: `/_b70/open/${'0'.repeat(64)}` }
      : {}),
    logs: '',
  });

const button = (wrapper: ReturnType<typeof mount>, text: string) =>
  wrapper.findAll('button').find((entry) => entry.text().trim() === text);

describe('app preview panel', () => {
  it('labels the status as an app preview and hides the dead stop button while stopped', async () => {
    mockState.preview = preview('stopped');
    const wrapper = mount(AgentAppPanel, { props: { projectId, name: 'Alpha' } });
    await flushPromises();
    expect(wrapper.text()).toContain('App preview: stopped');
    expect(button(wrapper, 'Stop app')).toBeUndefined();
    const start = button(wrapper, 'Start app');
    expect(start).toBeDefined();
    expect(start?.attributes('disabled')).toBeUndefined();
  });

  it('hides the start button when starting is not possible', async () => {
    mockState.preview = preview('stopped');
    const wrapper = mount(AgentAppPanel, {
      props: {
        projectId,
        name: 'Alpha',
        runId: '20000000-0000-4000-8000-000000000002',
        revision,
        canStart: false,
      },
    });
    await flushPromises();
    expect(button(wrapper, 'Start app')).toBeUndefined();
    expect(button(wrapper, 'Stop app')).toBeUndefined();
  });

  it('offers stop and open only while the preview runs', async () => {
    mockState.preview = preview('running');
    const wrapper = mount(AgentAppPanel, { props: { projectId, name: 'Alpha' } });
    await flushPromises();
    expect(wrapper.text()).toContain('App preview: running on the LAN');
    const stop = button(wrapper, 'Stop app');
    expect(stop).toBeDefined();
    expect(stop?.attributes('disabled')).toBeUndefined();
    const open = wrapper.findAll('a').find((entry) => entry.text().includes('Open app'));
    expect(open).toBeDefined();
  });
  it('names the pending stop correctly without claiming the app is starting', async () => {
    mockState.preview = preview('running');
    let finish: (value: AppPreview) => void = () => {};
    vi.mocked(stopAppPreview).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const wrapper = mount(AgentAppPanel, { props: { projectId, name: 'Alpha' } });
    await flushPromises();
    await button(wrapper, 'Stop app')!.trigger('click');
    expect(wrapper.text()).toContain('Stopping app …');
    expect(wrapper.text()).not.toContain('Starting app …');
    finish(preview('stopped'));
    await flushPromises();
    expect(wrapper.text()).toContain('App preview: stopped');
    expect(button(wrapper, 'Stop app')).toBeUndefined();
  });
});
