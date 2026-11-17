import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentTimeline from '../src/components/agent/AgentTimeline.vue';
import type { AgentTimelineItem } from '@observatory/contracts';

const item: AgentTimelineItem = {
  id: '11111111-1111-4111-8111-111111111111',
  at: '2026-11-07T18:00:00Z',
  kind: 'tool',
  title: 'browser_action',
  toolName: 'browser_action',
  state: 'running',
  argumentsText: '{}',
  outputText: 'Waiting',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function fixture(live = true) {
  let resized!: ResizeObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = callback;
      }
      observe() {}
      disconnect = disconnect;
    }
  );
  const wrapper = mount(AgentTimeline, {
    props: { items: [item], loading: false, isLiveRun: live },
  });
  const viewport = wrapper.get('.agent-timeline');
  const metrics = { height: 1000, visible: 300, top: 700 };
  Object.defineProperties(viewport.element, {
    scrollHeight: { get: () => metrics.height },
    clientHeight: { get: () => metrics.visible },
    scrollTop: {
      get: () => metrics.top,
      set: (v: number) => {
        metrics.top = v;
      },
    },
  });
  const scroll = vi.spyOn(viewport.element, 'scrollTo').mockImplementation((...args: unknown[]) => {
    const options = args[0];
    if (
      options &&
      typeof options === 'object' &&
      'top' in options &&
      typeof options.top === 'number'
    )
      metrics.top = Math.max(0, Math.min(options.top, metrics.height - metrics.visible));
  });
  await flushPromises();
  const resize = async () => {
    resized([], {} as ResizeObserver);
    await flushPromises();
  };
  return { wrapper, viewport, metrics, scroll, resize, disconnect };
}
describe('timeline follow intent', () => {
  it('stays pinned through tool output growth, delayed images and viewport height changes', async () => {
    const f = await fixture();
    f.metrics.height += 1200;
    await f.viewport.trigger('scroll'); // Layout scroll with unchanged scrollTop.
    expect(f.wrapper.find('.follow-button').exists()).toBe(false);
    await f.wrapper.setProps({
      items: [{ ...item, outputText: 'New tool output\n'.repeat(100), state: 'complete' }],
    });
    await f.resize();
    expect(f.metrics.top).toBe(f.metrics.height - f.metrics.visible);
    f.metrics.height += 600; // Late image/Markdown expansion.
    f.metrics.visible = 200; // Composer or pending-message area changes size.
    await f.resize();
    expect(f.metrics.top).toBe(f.metrics.height - f.metrics.visible);
    expect(f.wrapper.find('.follow-button').exists()).toBe(false);
    f.wrapper.unmount();
    expect(f.disconnect).toHaveBeenCalled();
  });
  it('preserves upward scrolling during pending DOM updates and resumes on Follow or the bottom', async () => {
    const f = await fixture();
    const update = f.wrapper.setProps({
      items: [item, { ...item, id: '22222222-2222-4222-8222-222222222222' }],
    });
    await f.viewport.trigger('wheel', { deltaY: -200 });
    f.metrics.top = 400;
    await f.viewport.trigger('scroll');
    await update;
    f.scroll.mockClear();
    f.metrics.height = 2000;
    await f.resize();
    expect(f.scroll).not.toHaveBeenCalled();
    expect(f.metrics.top).toBe(400);
    await f.wrapper.get('.follow-button').trigger('click');
    await flushPromises();
    expect(f.metrics.top).toBe(1700);
    await f.viewport.trigger('pointerdown', { pointerType: 'mouse' });
    f.metrics.top = 900;
    await f.viewport.trigger('scroll');
    window.dispatchEvent(new Event('pointerup'));
    expect(f.wrapper.find('.follow-button').exists()).toBe(true);
    f.metrics.top = 1700;
    await f.viewport.trigger('scroll');
    f.metrics.height = 2400;
    await f.resize();
    expect(f.metrics.top).toBe(2100);
    expect(f.wrapper.find('.follow-button').exists()).toBe(false);
    f.wrapper.unmount();
  });
  it('does not mistake a layout-induced upward adjustment for touch or scrollbar input', async () => {
    const f = await fixture();
    f.metrics.height += 1000;
    f.metrics.top -= 80;
    await f.viewport.trigger('scroll');
    await f.resize();
    expect(f.metrics.top).toBe(f.metrics.height - f.metrics.visible);
    const touch = (name: string, y: number) => {
      const event = new Event(name, { bubbles: true });
      Object.defineProperty(event, 'touches', { value: [{ clientY: y }] });
      f.viewport.element.dispatchEvent(event);
    };
    touch('touchstart', 200);
    touch('touchmove', 350);
    f.metrics.top -= 200;
    await f.viewport.trigger('scroll');
    f.scroll.mockClear();
    await f.resize();
    expect(f.scroll).not.toHaveBeenCalled();
    expect(f.wrapper.find('.follow-button').exists()).toBe(true);
    f.wrapper.unmount();
  });

  it('respects small upward gestures even inside the near-end tolerance', async () => {
    const f = await fixture();
    await f.viewport.trigger('wheel', { deltaY: -10 });
    f.metrics.top -= 10;
    await f.viewport.trigger('scroll');
    f.scroll.mockClear();
    await f.resize();
    expect(f.scroll).not.toHaveBeenCalled();
    expect(f.wrapper.find('.follow-button').exists()).toBe(true);
    f.metrics.top += 10;
    await f.viewport.trigger('scroll');
    expect(f.wrapper.find('.follow-button').exists()).toBe(false);
    f.wrapper.unmount();
  });

  it('leaves historical views alone as images and output arrive', async () => {
    const f = await fixture(false);
    f.scroll.mockClear();
    f.metrics.top = 100;
    f.metrics.height = 3000;
    await f.resize();
    expect(f.scroll).not.toHaveBeenCalled();
    expect(f.metrics.top).toBe(100);
    f.wrapper.unmount();
  });
});
