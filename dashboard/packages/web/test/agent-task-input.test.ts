import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentImagePicker from '../src/components/agent/AgentImagePicker.vue';
import AgentTaskInput from '../src/components/agent/AgentTaskInput.vue';
import { agentDraftKey, clearAgentDrafts } from '../src/lib/drafts.js';
import { setLocale } from '../src/lib/i18n.js';

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '22222222-2222-4222-8222-222222222222';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    taskId,
    baseMode: 'steer' as const,
    isActive: true,
    canToggleFollowup: true,
    steering: false,
    continuing: false,
    cancelling: false,
    onSubmit: vi.fn(async () => true),
    ...overrides,
  };
}

afterEach(() => {
  setLocale('en');
  clearAgentDrafts();
  vi.restoreAllMocks();
});

vi.mock('../src/lib/api.js', () => ({
  fetchSpeechStatus: vi.fn(async () => ({ available: false, device: 'cpu', maxSeconds: 120 })),
  transcribeSpeech: vi.fn(),
}));

describe('AgentTaskInput', () => {
  it('keeps all controls in the input row and image previews outside that row', async () => {
    const wrapper = mount(AgentTaskInput, {
      props: baseProps({ baseMode: 'continue', isActive: false, canToggleFollowup: false }),
    });
    const row = wrapper.get('.input-compose');
    expect(row.find('textarea').exists()).toBe(true);
    expect(row.find('.agent-dictation button svg').exists()).toBe(true);
    expect(row.findComponent(AgentImagePicker).exists()).toBe(true);
    expect(row.find('button[type="submit"]').exists()).toBe(true);
    wrapper
      .getComponent(AgentImagePicker)
      .vm.$emit('update:modelValue', [{ mimeType: 'image/png', data: 'AAAA', label: 'Reference' }]);
    await flushPromises();
    expect(row.find('.image-previews').exists()).toBe(false);
    expect(wrapper.find('.image-attachments .image-previews').exists()).toBe(true);
    await wrapper.get('.image-previews button[aria-label="Remove Reference"]').trigger('click');
    expect(wrapper.getComponent(AgentImagePicker).props('modelValue')).toEqual([]);
    wrapper.unmount();
  });
  it('defaults to steering for an active run and clears only after a confirmed send', async () => {
    const onSubmit = vi.fn(async () => true);
    const wrapper = mount(AgentTaskInput, { props: baseProps({ onSubmit }) });
    expect(wrapper.get('.task-input-hint').text()).toBe(
      'Send adds your comment to the running task.'
    );
    expect(wrapper.get('button[type="submit"]').text()).toBe('Send comment to agent');
    expect(wrapper.get('.stop-button').text()).toBe('Stop run');

    await wrapper.get('textarea').setValue('use the main branch');
    await wrapper.trigger('submit');
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledWith('use the main branch', 'steer');
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');
    expect(localStorage.getItem(agentDraftKey(taskId, 'steer'))).toBeNull();
    wrapper.unmount();
  });

  it('keeps the text and the draft when the backend rejects the action', async () => {
    const onSubmit = vi.fn(async () => false);
    const wrapper = mount(AgentTaskInput, { props: baseProps({ onSubmit }) });
    await wrapper.get('textarea').setValue('retry this step');
    await wrapper.trigger('submit');
    await flushPromises();
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('retry this step');
    expect(localStorage.getItem(agentDraftKey(taskId, 'steer'))).toBe('retry this step');
    wrapper.unmount();
  });

  it('keeps the visible text and both drafts when the task switches during a pending send', async () => {
    localStorage.setItem(agentDraftKey(otherTaskId, 'steer'), 'draft B steer');
    const gate = deferred<boolean>();
    const onSubmit = vi.fn(() => gate.promise);
    const wrapper = mount(AgentTaskInput, { props: baseProps({ onSubmit }) });

    await wrapper.get('textarea').setValue('send A');
    await wrapper.trigger('submit');
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('send A', 'steer');

    // Switch to task B before the backend answers.
    await wrapper.setProps({ taskId: otherTaskId });
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('draft B steer');

    gate.resolve(true);
    await flushPromises();

    // The late confirmation must not touch B's visible text or draft...
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('draft B steer');
    expect(localStorage.getItem(agentDraftKey(otherTaskId, 'steer'))).toBe('draft B steer');
    // ...but removes exactly A's sent draft.
    expect(localStorage.getItem(agentDraftKey(taskId, 'steer'))).toBeNull();
    wrapper.unmount();
  });

  it('keeps the switched mode untouched when the mode changes during a pending send', async () => {
    localStorage.setItem(agentDraftKey(taskId, 'followup'), 'followup draft');
    const gate = deferred<boolean>();
    const onSubmit = vi.fn(() => gate.promise);
    const wrapper = mount(AgentTaskInput, { props: baseProps({ onSubmit }) });

    await wrapper.get('textarea').setValue('steer text');
    await wrapper.trigger('submit');
    await flushPromises();

    // Flip to the followup mode while the steer send is still pending.
    await wrapper.get('.task-input-actions .composer-followup').trigger('click');
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('followup draft');

    gate.resolve(true);
    await flushPromises();

    expect(onSubmit).toHaveBeenCalledWith('steer text', 'steer');
    // The visible followup draft is untouched; the sent steer draft is gone.
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('followup draft');
    expect(localStorage.getItem(agentDraftKey(taskId, 'followup'))).toBe('followup draft');
    expect(localStorage.getItem(agentDraftKey(taskId, 'steer'))).toBeNull();
    wrapper.unmount();
  });

  it('keeps a newer draft when the same task keeps being edited during a pending send', async () => {
    const gate = deferred<boolean>();
    const onSubmit = vi.fn(() => gate.promise);
    const wrapper = mount(AgentTaskInput, { props: baseProps({ onSubmit }) });

    await wrapper.get('textarea').setValue('first version');
    await wrapper.trigger('submit');
    await flushPromises();

    // The user keeps typing before the backend answers.
    await wrapper.get('textarea').setValue('second version');

    gate.resolve(true);
    await flushPromises();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('first version', 'steer');
    // The edited text and its draft survive the late confirmation.
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('second version');
    expect(localStorage.getItem(agentDraftKey(taskId, 'steer'))).toBe('second version');
    wrapper.unmount();
  });

  it('keeps the text and the draft when the send promise rejects, without unhandled rejection', async () => {
    const gate = deferred<boolean>();
    const onSubmit = vi.fn(() => gate.promise);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    const wrapper = mount(AgentTaskInput, { props: baseProps({ onSubmit }) });
    await wrapper.get('textarea').setValue('fragile send');
    await wrapper.trigger('submit');
    await flushPromises();

    gate.reject(new Error('backend down'));
    await flushPromises();
    await Promise.resolve(); // let any unhandled rejection surface
    process.off('unhandledRejection', onRejection);

    expect(rejections).toEqual([]);
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('fragile send');
    expect(localStorage.getItem(agentDraftKey(taskId, 'steer'))).toBe('fragile send');
    wrapper.unmount();
  });

  it('ignores a second submit while the first send is pending', async () => {
    const gate = deferred<boolean>();
    const onSubmit = vi.fn(() => gate.promise);
    const wrapper = mount(AgentTaskInput, { props: baseProps({ onSubmit }) });

    await wrapper.get('textarea').setValue('only once');
    await wrapper.trigger('submit');
    await wrapper.trigger('submit');
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    gate.resolve(true);
    await flushPromises();
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');
    expect(localStorage.getItem(agentDraftKey(taskId, 'steer'))).toBeNull();
    wrapper.unmount();
  });

  it('switches the same input to queueFollowup via the compact afterwards toggle', async () => {
    const onSubmit = vi.fn(async () => true);
    const wrapper = mount(AgentTaskInput, { props: baseProps({ onSubmit }) });
    const toggle = wrapper.get('.task-input-actions .composer-followup');
    expect(toggle.text()).toBe('Work afterwards');

    await toggle.trigger('click');
    expect(wrapper.get('.task-input-hint').text()).toBe(
      'Send queues this instruction for after the current run.'
    );
    await wrapper.get('textarea').setValue('then run the docs build');
    await wrapper.trigger('submit');
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledWith('then run the docs build', 'followup');
    expect(localStorage.getItem(agentDraftKey(taskId, 'followup'))).toBeNull();
    wrapper.unmount();
  });

  it('answers an open question through answerQuestion wording and shows the question', async () => {
    const onSubmit = vi.fn(async () => true);
    const wrapper = mount(AgentTaskInput, {
      props: baseProps({
        onSubmit,
        baseMode: 'answer',
        isActive: false,
        canToggleFollowup: false,
        question: 'Hours or days?',
      }),
    });
    expect(wrapper.get('.task-question').text()).toBe('Hours or days?');
    expect(wrapper.get('.task-input-hint').text()).toBe(
      'Send answers the open question and continues.'
    );
    expect(wrapper.get('button[type="submit"]').text()).toBe('Answer and continue');
    expect(wrapper.find('.stop-button').exists()).toBe(false);
    expect(wrapper.find('.task-input-actions .composer-followup').exists()).toBe(false);

    await wrapper.get('textarea').setValue('Use days.');
    await wrapper.trigger('submit');
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledWith('Use days.', 'answer');
    wrapper.unmount();
  });

  it('continues a finished task through continueTask wording', async () => {
    const onSubmit = vi.fn(async () => true);
    const wrapper = mount(AgentTaskInput, {
      props: baseProps({
        onSubmit,
        baseMode: 'continue',
        isActive: false,
        canToggleFollowup: false,
      }),
    });
    expect(wrapper.get('.task-input-hint').text()).toBe('Send starts a new run on this task.');
    expect(wrapper.get('button[type="submit"]').text()).toBe('Continue');
    expect(wrapper.find('.stop-button').exists()).toBe(false);

    await wrapper.get('textarea').setValue('now add tests');
    await wrapper.trigger('submit');
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledWith('now add tests', 'continue');
    wrapper.unmount();
  });

  it('restores the local draft per task and mode, and does not mix tasks', async () => {
    localStorage.setItem(agentDraftKey(taskId, 'steer'), 'draft A steer');
    localStorage.setItem(agentDraftKey(taskId, 'continue'), 'draft A continue');
    const other = '22222222-2222-4222-8222-222222222222';
    localStorage.setItem(agentDraftKey(other, 'steer'), 'draft B steer');

    const wrapper = mount(AgentTaskInput, { props: baseProps() });
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('draft A steer');

    // Switching tasks replaces the text with the other task's own draft.
    await wrapper.setProps({ taskId: other });
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('draft B steer');

    // Switching back restores the first draft again.
    await wrapper.setProps({ taskId });
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('draft A steer');
    wrapper.unmount();

    // A fresh mount (page reload) sees the stored draft again.
    const reloaded = mount(AgentTaskInput, {
      props: baseProps({ baseMode: 'continue' as const, isActive: false }),
    });
    expect((reloaded.get('textarea').element as HTMLTextAreaElement).value).toBe(
      'draft A continue'
    );
    reloaded.unmount();
  });

  it('returns to steering with its own draft once the follow-up is queued and no longer toggleable', async () => {
    // A separate steer draft that must survive the whole sequence.
    localStorage.setItem(agentDraftKey(taskId, 'steer'), 'steer the run');
    const gate = deferred<boolean>();
    const onSubmit = vi.fn(() => gate.promise);
    const wrapper = mount(AgentTaskInput, {
      // Initially no follow-up toggle at all (a follow-up is already queued
      // from before); the input must stay in steer mode and steer directly.
      props: baseProps({ onSubmit, canToggleFollowup: false, queuedFollowup: 'old queued' }),
    });
    expect(wrapper.find('.task-input-actions .composer-followup').exists()).toBe(false);
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('steer the run');
    await wrapper.get('textarea').setValue('steer now');
    await wrapper.trigger('submit');
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('steer now', 'steer');
    wrapper.unmount();

    // Fresh mount with the toggle available: queue a follow-up while it is
    // still pending in the backend.
    localStorage.setItem(agentDraftKey(taskId, 'steer'), 'steer the run');
    const gate2 = deferred<boolean>();
    const onSubmit2 = vi.fn(() => gate2.promise);
    const second = mount(AgentTaskInput, { props: baseProps({ onSubmit: onSubmit2 }) });
    await second.get('.task-input-actions .composer-followup').trigger('click');
    await second.get('textarea').setValue('then run the build');
    await second.trigger('submit');
    await flushPromises();
    expect(onSubmit2).toHaveBeenCalledTimes(1);
    expect(onSubmit2).toHaveBeenCalledWith('then run the build', 'followup');

    // The parent marks the follow-up as queued: the toggle disappears.
    await second.setProps({ canToggleFollowup: false, queuedFollowup: 'then run the build' });
    expect(second.find('.task-input-actions .composer-followup').exists()).toBe(false);
    // The input must be back in steer mode with its own draft restored.
    expect(second.get('.task-input-hint').text()).toBe(
      'Send adds your comment to the running task.'
    );
    expect((second.get('textarea').element as HTMLTextAreaElement).value).toBe('steer the run');

    // The late confirmation of the queued follow-up must not delete the
    // visible (and now different-mode) steer draft.
    gate2.resolve(true);
    await flushPromises();
    expect((second.get('textarea').element as HTMLTextAreaElement).value).toBe('steer the run');
    expect(localStorage.getItem(agentDraftKey(taskId, 'steer'))).toBe('steer the run');
    expect(localStorage.getItem(agentDraftKey(taskId, 'followup'))).toBeNull();

    // Steering is directly possible again.
    await second.get('textarea').setValue('fix the layout');
    await second.trigger('submit');
    await flushPromises();
    expect(onSubmit2).toHaveBeenCalledTimes(2);
    expect(onSubmit2).toHaveBeenLastCalledWith('fix the layout', 'steer');
    expect((second.get('textarea').element as HTMLTextAreaElement).value).toBe('');
    expect(localStorage.getItem(agentDraftKey(taskId, 'steer'))).toBeNull();
    second.unmount();
  });

  it('shows the explicitly queued follow-up above the composer', () => {
    const wrapper = mount(AgentTaskInput, {
      props: baseProps({ queuedFollowup: 'later build step' }),
    });
    expect(wrapper.get('.queue-note').text()).toBe('Already queued: later build step');
    expect(wrapper.find('.steering-deliveries').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('task reference drafts', () => {
  const image = { mimeType: 'image/png' as const, data: 'AAAA', label: 'Reference' };
  it('keeps image drafts after failure and across task switches, clearing only on confirmation', async () => {
    const onSubmit = vi.fn(async () => false);
    const wrapper = mount(AgentTaskInput, {
      props: baseProps({ baseMode: 'continue', isActive: false, onSubmit }),
    });
    await wrapper.get('textarea').setValue('Match this reference');
    wrapper.getComponent(AgentImagePicker).vm.$emit('update:modelValue', [image]);
    await flushPromises();
    await wrapper.trigger('submit');
    expect(onSubmit).toHaveBeenLastCalledWith('Match this reference', 'continue', [image]);
    expect(wrapper.getComponent(AgentImagePicker).props('modelValue')).toEqual([image]);
    await wrapper.setProps({ taskId: otherTaskId });
    expect(wrapper.getComponent(AgentImagePicker).props('modelValue')).toEqual([]);
    await wrapper.setProps({ taskId });
    expect(wrapper.getComponent(AgentImagePicker).props('modelValue')).toEqual([image]);
    onSubmit.mockResolvedValueOnce(true);
    await wrapper.trigger('submit');
    expect(wrapper.getComponent(AgentImagePicker).props('modelValue')).toEqual([]);
    wrapper.unmount();
  });
  it('does not offer unsupported image input while a task is running', () => {
    const wrapper = mount(AgentTaskInput, { props: baseProps() });
    expect(wrapper.findComponent(AgentImagePicker).exists()).toBe(false);
    wrapper.unmount();
  });
});

it('offers pause only for active durable conversations and emits the pause action', async () => {
  const wrapper = mount(AgentTaskInput, { props: baseProps({ canPause: true }) });
  const button = wrapper.findAll('button').find((item) => item.text() === 'Pause run')!;
  expect(button).toBeDefined();
  await button.trigger('click');
  expect(wrapper.emitted('pause')).toHaveLength(1);
  await wrapper.setProps({ canPause: false });
  expect(wrapper.findAll('button').some((item) => item.text() === 'Pause run')).toBe(false);
});
