import { mount, enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTimelineItem } from '@observatory/contracts';
import AgentDesktopPanel from '../src/components/agent/AgentDesktopPanel.vue';
const runId = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const imageId = '33333333-3333-4333-8333-333333333333';
const newerImageId = '44444444-4444-4444-8444-444444444444';
const items: AgentTimelineItem[] = [
  {
    id: imageId,
    at: '2026-11-07T16:00:00.000Z',
    kind: 'tool',
    title: 'browser_action',
    toolName: 'browser_action',
    images: [
      { id: imageId, runId, mimeType: 'image/png', width: 1440, height: 900, byteLength: 80 },
    ],
  },
];
const fetchMock = vi.fn();
enableAutoUnmount(afterEach);
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ runId, items: [], hasMore: false }),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('agent screenshot pane', () => {
  it('shows exactly the persisted browser tool image with its time and no extra chrome', () => {
    const wrapper = mount(AgentDesktopPanel, { props: { runId, items } });
    expect(wrapper.get('img').attributes('src')).toBe(`/api/agent/runs/${runId}/images/${imageId}`);
    expect(wrapper.get('a').attributes('href')).toBe(wrapper.get('img').attributes('src'));
    expect(wrapper.get('time').attributes('datetime')).toBe(items[0]!.at);
    expect(wrapper.text()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(wrapper.find('header, footer, button, .desktop-status').exists()).toBe(false);
  });
  it('updates only when an agent screenshot arrives, ignoring generated images and image reads', async () => {
    const wrapper = mount(AgentDesktopPanel, { props: { runId, items } });
    const next: AgentTimelineItem = {
      ...items[0]!,
      id: newerImageId,
      at: '2026-11-07T16:01:00.000Z',
      images: [{ ...items[0]!.images![0]!, id: newerImageId }],
    };
    await wrapper.setProps({
      items: [...items, { ...next, toolName: 'generate_image' }, { ...next, toolName: 'read' }],
    });
    expect(wrapper.get('img').attributes('src')).toContain(imageId);
    await wrapper.setProps({ items: [...items, next] });
    expect(wrapper.get('img').attributes('src')).toBe(
      `/api/agent/runs/${runId}/images/${newerImageId}`
    );
    expect(wrapper.get('time').attributes('datetime')).toBe(next.at);
  });
  it('keeps the last screenshot while the next browser tool is running without an image', async () => {
    const wrapper = mount(AgentDesktopPanel, { props: { runId, items } });
    await wrapper.setProps({
      items: [...items, { ...items[0]!, id: newerImageId, images: undefined, state: 'running' }],
    });
    expect(wrapper.get('img').attributes('src')).toContain(imageId);
  });
  it('supports native tool screenshots and never reuses an image from another run', async () => {
    const wrapper = mount(AgentDesktopPanel, {
      props: { runId, items: items.map((item) => ({ ...item, toolName: 'desktop_observe' })) },
    });
    expect(wrapper.get('img').attributes('src')).toContain(imageId);
    await wrapper.setProps({ runId: other });
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('time').exists()).toBe(false);
  });
  it('lets a chosen older screenshot stay selected and follows latest only on request', async () => {
    const wrapper = mount(AgentDesktopPanel, { props: { runId, items } });
    const next = {
      ...items[0]!,
      id: newerImageId,
      at: '2026-11-07T16:01:00.000Z',
      images: [{ ...items[0]!.images![0]!, id: newerImageId }],
    };
    await wrapper.setProps({ items: [...items, next] });
    expect(wrapper.findAll('.screenshot-filmstrip button')).toHaveLength(2);
    await wrapper.findAll('.screenshot-filmstrip button')[0]!.trigger('click');
    expect(wrapper.get('.desktop-screen img').attributes('src')).toContain(imageId);
    const thirdId = '55555555-5555-4555-8555-555555555555';
    await wrapper.setProps({
      items: [
        ...items,
        next,
        {
          ...next,
          id: thirdId,
          at: '2026-11-07T16:02:00.000Z',
          images: [{ ...next.images[0]!, id: thirdId }],
        },
      ],
    });
    expect(wrapper.get('.desktop-screen img').attributes('src')).toContain(imageId);
    await wrapper.get('.screenshot-follow').trigger('click');
    expect(wrapper.get('.desktop-screen img').attributes('src')).toContain(thirdId);
  });
  it('restores older screenshots from the persisted journal outside the live window', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        runId,
        items: [
          {
            id: 1,
            runId,
            sequence: 1,
            recordedAt: '2026-11-07T16:00:00.000Z',
            event: { operation: 'append', sequence: 1, runId, item: items[0] },
          },
        ],
        hasMore: false,
      }),
    });
    const next = {
      ...items[0]!,
      id: newerImageId,
      at: '2026-11-07T16:01:00.000Z',
      images: [{ ...items[0]!.images![0]!, id: newerImageId }],
    };
    const wrapper = mount(AgentDesktopPanel, { props: { runId, items: [next] } });
    await flushPromises();
    expect(wrapper.findAll('.screenshot-filmstrip button')).toHaveLength(2);
    await wrapper.findAll('.screenshot-filmstrip button')[0]!.trigger('click');
    expect(wrapper.get('.desktop-screen img').attributes('src')).toContain(imageId);
  });
  it('makes no periodic capture requests, including visibility changes and remounting', async () => {
    const wrapper = mount(AgentDesktopPanel, { props: { runId, items } });
    await vi.advanceTimersByTimeAsync(30_000);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(30_000);
    wrapper.unmount();
    mount(AgentDesktopPanel, { props: { runId, items } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/trace?'))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
