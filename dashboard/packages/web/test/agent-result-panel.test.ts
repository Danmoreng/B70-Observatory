import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { AgentRunResult } from '@observatory/contracts';
import AgentResultPanel from '../src/components/agent/AgentResultPanel.vue';

const result: AgentRunResult = {
  runId: '11111111-1111-4111-8111-111111111111',
  resultRevision: 'a'.repeat(40),
  files: ['src/value.ts'],
  diff: 'diff --git a/src/value.ts b/src/value.ts',
  diffTruncated: false,
  checkStatus: 'passed',
  checks: [],
};

const accepted: AgentRunResult = {
  ...result,
  acceptedAt: '2026-09-13T18:00:00.000Z',
  acceptedRevision: 'a'.repeat(40),
};

const merged: AgentRunResult = {
  ...accepted,
  mergedAt: '2026-09-13T18:05:00.000Z',
  mergedRevision: 'd'.repeat(40),
};

describe('AgentResultPanel', () => {
  it('offers the approval button before acceptance and no merge action', () => {
    const wrapper = mount(AgentResultPanel, {
      props: {
        result,
        accepting: false,
        merging: false,
        resolving: false,
        canResolveConflict: false,
      },
    });
    const button = wrapper.get('.primary-button');
    expect(button.text()).toBe('Accept this result');
    expect(wrapper.text()).not.toContain('Accepted · not merged yet');
    expect(wrapper.text()).not.toContain('Merge into project');
  });

  it('shows a busy approval state and emits the exact selected result', async () => {
    const wrapper = mount(AgentResultPanel, {
      props: {
        result,
        accepting: true,
        merging: false,
        resolving: false,
        canResolveConflict: false,
      },
    });
    expect(wrapper.get('.primary-button').text()).toBe('Accepting …');
    await wrapper.get('.primary-button').trigger('click');
    expect(wrapper.emitted('accept')).toBeUndefined();
  });

  it('shows an accepted-not-merged state with its own merge action', async () => {
    const wrapper = mount(AgentResultPanel, {
      props: {
        result: accepted,
        accepting: false,
        merging: false,
        resolving: false,
        canResolveConflict: false,
      },
    });
    expect(wrapper.text()).toContain('Accepted · not merged yet');
    expect(wrapper.text()).not.toContain('Merged');
    const button = wrapper.get('.primary-button');
    expect(button.text()).toBe('Merge into project');
    await button.trigger('click');
    expect(wrapper.emitted('merge')?.[0]).toEqual([accepted]);
  });

  it('shows a busy merge state that cannot retrigger the action', async () => {
    const wrapper = mount(AgentResultPanel, {
      props: {
        result: accepted,
        accepting: false,
        merging: true,
        resolving: false,
        canResolveConflict: false,
      },
    });
    const button = wrapper.get('.primary-button');
    expect(button.text()).toBe('Merging …');
    await button.trigger('click');
    expect(wrapper.emitted('merge')).toBeUndefined();
  });

  it('shows the visible merged state with the integrated target revision', () => {
    const wrapper = mount(AgentResultPanel, {
      props: {
        result: merged,
        accepting: false,
        merging: false,
        resolving: false,
        canResolveConflict: false,
      },
    });
    expect(wrapper.text()).toContain('Merged');
    expect(wrapper.text()).toContain('d'.repeat(12));
    expect(wrapper.find('.primary-button').exists()).toBe(false);
  });

  it('keeps the conflict-resolution action available also after acceptance', async () => {
    const hidden = mount(AgentResultPanel, {
      props: {
        result: accepted,
        accepting: false,
        merging: false,
        resolving: false,
        canResolveConflict: false,
      },
    });
    expect(hidden.text()).not.toContain('Resolve conflicts with agent');

    const visible = mount(AgentResultPanel, {
      props: {
        result: accepted,
        accepting: false,
        merging: false,
        resolving: false,
        canResolveConflict: true,
      },
    });
    const button = visible.get('.quiet-button');
    expect(button.text()).toBe('Resolve conflicts with agent');
    await button.trigger('click');
    expect(visible.emitted('resolveConflict')?.[0]).toEqual([accepted]);
  });
});
