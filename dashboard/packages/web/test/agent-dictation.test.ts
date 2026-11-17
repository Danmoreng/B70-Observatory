import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import AgentDictation from '../src/components/agent/AgentDictation.vue';

const api = vi.hoisted(() => ({
  status: vi.fn(async () => ({ available: true })),
  transcribe: vi.fn(async () => 'Gesprochener Text.'),
}));
vi.mock('../src/lib/api.js', () => ({
  fetchSpeechStatus: api.status,
  transcribeSpeech: api.transcribe,
}));
const recorders: FakeRecorder[] = [];
class FakeRecorder {
  static isTypeSupported(type: string) {
    return type === 'audio/mp4';
  }
  state = 'inactive';
  mimeType = 'audio/mp4';
  ondataavailable?: (event: { data: Blob }) => void;
  onstop: (() => void) | null = null;
  onerror?: () => void;
  constructor() {
    recorders.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio']) });
    this.onstop?.();
  }
}
function microphone(
  getUserMedia: () => Promise<{ getTracks: () => { stop: () => void }[] }> = vi.fn(async () => ({
    getTracks: () => [{ stop: vi.fn() }],
  }))
) {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return getUserMedia;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('explains why HTTP cannot use the microphone', async () => {
  microphone();
  vi.stubGlobal('isSecureContext', false);
  const wrapper = mount(AgentDictation);
  await flushPromises();
  expect(wrapper.text()).toContain('requires HTTPS');
  expect(wrapper.get('button').attributes('disabled')).toBeDefined();
  wrapper.unmount();
});
it('keeps the HTTP limitation in an accessible tooltip instead of a permanent composer line', async () => {
  microphone();
  vi.stubGlobal('isSecureContext', false);
  const wrapper = mount(AgentDictation, { props: { compact: true } });
  await flushPromises();
  expect(wrapper.find('small').exists()).toBe(false);
  expect(wrapper.get('.agent-dictation').attributes('title')).toContain('requires HTTPS');
  expect(wrapper.get('button').attributes('aria-label')).toContain('requires HTTPS');
  expect(wrapper.find('button svg').exists()).toBe(true);
  expect(wrapper.get('button').attributes('disabled')).toBeDefined();
  wrapper.unmount();
});
it('records only after a tap and emits editable text after stopping', async () => {
  const getUserMedia = microphone();
  const wrapper = mount(AgentDictation);
  await flushPromises();
  expect(getUserMedia).not.toHaveBeenCalled();
  await wrapper.get('button').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('Recording');
  expect(api.transcribe).not.toHaveBeenCalled();
  await wrapper.get('button').trigger('click');
  await flushPromises();
  expect(api.transcribe).toHaveBeenCalledWith(expect.any(Blob), expect.any(AbortSignal));
  expect(wrapper.emitted('transcript')).toEqual([['Gesprochener Text.']]);
  expect(wrapper.emitted('busy')?.at(-1)).toEqual([false]);
  wrapper.unmount();
});
it('releases a late permission grant when the task is closed', async () => {
  let resolve!: (value: { getTracks: () => { stop: () => void }[] }) => void;
  const stop = vi.fn();
  microphone(
    vi.fn(
      () =>
        new Promise<{ getTracks: () => { stop: () => void }[] }>((r) => {
          resolve = r;
        })
    )
  );
  const wrapper = mount(AgentDictation);
  await flushPromises();
  await wrapper.get('button').trigger('click');
  wrapper.unmount();
  resolve({ getTracks: () => [{ stop }] });
  await flushPromises();
  expect(stop).toHaveBeenCalled();
  expect(wrapper.emitted('transcript')).toBeUndefined();
});
it('never inserts text after an unsuccessful transcription', async () => {
  microphone();
  api.transcribe.mockRejectedValueOnce(new Error('offline'));
  const wrapper = mount(AgentDictation);
  await flushPromises();
  await wrapper.get('button').trigger('click');
  await flushPromises();
  recorders.at(-1)!.stop();
  await flushPromises();
  expect(wrapper.emitted('transcript')).toBeUndefined();
  expect(wrapper.get('[role="alert"]').text()).toContain('typed text is unchanged');
  wrapper.unmount();
});

it('keeps the dictation action available in the compact composer without its idle explanation', async () => {
  microphone();
  const wrapper = mount(AgentDictation, { props: { compact: true } });
  await flushPromises();
  expect(wrapper.get('button').text()).toBe('Dictate');
  expect(wrapper.find('small').exists()).toBe(false);
  await wrapper.get('button').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('Recording');
  wrapper.unmount();
});
