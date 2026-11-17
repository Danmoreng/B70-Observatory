import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import EngineControls from '../src/components/EngineControls.vue';

const api = vi.hoisted(() => ({
  fetch: vi.fn(),
  change: vi.fn(),
}));

vi.mock('../src/lib/api.js', () => ({
  fetchEngineService: api.fetch,
  changeEngineService: api.change,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  api.fetch.mockReset();
  api.change.mockReset();
});

it('shows actual user-service state and changes autostart independently of runtime', async () => {
  api.fetch.mockResolvedValue({ activeState: 'active', autostart: true });
  api.change.mockResolvedValue({ activeState: 'active', autostart: false });
  const wrapper = mount(EngineControls);
  await flushPromises();
  const buttons = wrapper.findAll('button');
  expect(buttons.map((button) => button.text())).toEqual([
    'Start',
    'Shut down',
    'Restart',
    'Start with computer: On',
  ]);
  expect(buttons[0]?.attributes('disabled')).toBeDefined();
  await buttons[3]?.trigger('click');
  await flushPromises();
  expect(api.change).toHaveBeenCalledWith('disable');
  expect(wrapper.text()).toContain('Running');
  expect(wrapper.text()).toContain('Start with computer: Off');
  wrapper.unmount();
});

it('confirms shutdown and leaves the service untouched when cancelled', async () => {
  api.fetch.mockResolvedValue({ activeState: 'active', autostart: true });
  const confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  const wrapper = mount(EngineControls);
  await flushPromises();
  await wrapper.findAll('button')[1]?.trigger('click');
  expect(confirm).toHaveBeenCalled();
  expect(api.change).not.toHaveBeenCalled();
  wrapper.unmount();
});

it('shows the planned image phase, protects running turns, and refreshes after the GPU is restored', async () => {
  vi.useFakeTimers();
  api.fetch.mockResolvedValue({
    activeState: 'inactive',
    autostart: true,
    gpu: { phase: 'image', activeText: 0, waitingText: 2, waitingImages: 0 },
  });
  const wrapper = mount(EngineControls);
  try {
    await flushPromises();
    expect(wrapper.text()).toContain('Image engine active');
    expect(wrapper.text()).toContain('Waiting text turns: 2');
    expect(
      wrapper.findAll('button').every((button) => button.attributes('disabled') !== undefined)
    ).toBe(true);
    api.fetch.mockResolvedValue({
      activeState: 'active',
      autostart: true,
      gpu: { phase: 'text', activeText: 0, waitingText: 0, waitingImages: 0 },
    });
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(wrapper.text()).toContain('Text engine ready');
    expect(wrapper.findAll('button')[1]?.attributes('disabled')).toBeUndefined();
  } finally {
    wrapper.unmount();
    vi.useRealTimers();
  }
});
