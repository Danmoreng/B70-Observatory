import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { AgentTimelineItem } from '@observatory/contracts';
import AgentTimeline from '../src/components/agent/AgentTimeline.vue';
import { conversationItems } from '../src/lib/agent-conversations.js';

const main: AgentTimelineItem = {
  id: '11111111-1111-4111-8111-111111111111',
  at: '2026-10-17T14:00:00.000Z',
  kind: 'assistant',
  title: 'Agent',
  text: 'Main conversation',
};
const child: AgentTimelineItem = {
  ...main,
  id: '22222222-2222-4222-8222-222222222222',
  agent: { id: '1234567890abcdef', name: 'Rules' },
  kind: 'thinking',
  text: 'Child reasoning',
};
describe('separate agent conversations', () => {
  it('shows the main agent initially and switches the whole trace to the named child', async () => {
    const wrapper = mount(AgentTimeline, {
      props: {
        items: [
          main,
          child,
          {
            ...main,
            id: '33333333-3333-4333-8333-333333333333',
            kind: 'notice',
            title: 'Pi-Diagnose',
            text: '{"type":"b70_subagent_event"}',
          },
        ],
        loading: false,
        subagents: [{ id: '1234567890abcdef', name: 'Rules', status: 'running' }],
      },
    });
    expect(wrapper.text()).toContain('Main conversation');
    expect(wrapper.text()).not.toContain('Child reasoning');
    expect(wrapper.text()).not.toContain('Pi-Diagnose');
    expect(wrapper.text()).not.toContain('b70_subagent_event');
    const buttons = wrapper.findAll('.agent-conversation-tabs button');
    expect(buttons).toHaveLength(2);
    await buttons[1]!.trigger('click');
    expect(wrapper.text()).toContain('Child reasoning');
    expect(wrapper.text()).not.toContain('Main conversation');
    expect(wrapper.findAll('details, summary')).toHaveLength(0);
    await buttons[0]!.trigger('click');
    expect(wrapper.text()).toContain('Main conversation');
    wrapper.unmount();
  });

  it('separates historical prefixed child messages while keeping errors and tool output visible', () => {
    const old = {
      ...child,
      agent: undefined,
      title: '[Rules] Reasoning',
      text: '[Sub-Agent Rules]\nOld child',
    };
    expect(conversationItems([main, old], 'main')).toEqual([main]);
    expect(conversationItems([main, old], 'legacy:Rules')).toEqual([old]);
    const error = {
      ...main,
      kind: 'error' as const,
      title: 'Pi-Erweiterungsfehler',
      text: 'real error',
    };
    expect(conversationItems([error], 'main')).toEqual([error]);
  });
});
