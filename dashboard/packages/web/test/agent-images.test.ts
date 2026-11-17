import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import type { AgentTimelineImage } from '@observatory/contracts';
import AgentTimeline from '../src/components/agent/AgentTimeline.vue';

describe('browser images in the human transcript', () => {
  it('keeps an earlier turn image bound to its original run in a continued conversation', () => {
    const originalRun = '11111111-1111-4111-8111-111111111111';
    const wrapper = mount(AgentTimeline, {
      props: {
        runId: '44444444-4444-4444-8444-444444444444',
        loading: false,
        items: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            at: '2026-10-22T18:00:00Z',
            kind: 'task',
            title: 'Reference',
            images: [
              {
                id: '22222222-2222-4222-8222-222222222222',
                runId: originalRun,
                mimeType: 'image/png',
                width: 1,
                height: 1,
                byteLength: 80,
              },
            ],
          },
        ],
      },
    });
    expect(wrapper.find('.image-thumb img').attributes('src')).toBe(
      `/api/agent/runs/${originalRun}/images/22222222-2222-4222-8222-222222222222`
    );
    wrapper.unmount();
  });

  it('renders image-bearing browser actions inline and opens the same image at full size', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const image: AgentTimelineImage = {
      id: '22222222-2222-4222-8222-222222222222',
      runId,
      mimeType: 'image/png',
      width: 1280,
      height: 860,
      byteLength: 191567,
    };
    const wrapper = mount(AgentTimeline, {
      attachTo: document.body,
      props: {
        runId,
        loading: false,
        items: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            at: '2026-10-17T19:00:00Z',
            kind: 'tool',
            title: 'browser_action',
            toolName: 'browser_action',
            outputText: 'Language changed',
            images: [image],
            state: 'complete',
          },
        ],
      },
    });
    try {
      const src = `/api/agent/runs/${runId}/images/${image.id}`;
      expect(wrapper.find('.timeline-item .image-thumb img').attributes('src')).toBe(src);
      await wrapper.find('.image-thumb').trigger('click');
      await nextTick();
      expect(document.querySelector('dialog[open] img')?.getAttribute('src')).toBe(src);
      document
        .querySelector('dialog')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await nextTick();
      expect(document.querySelector('dialog[open]')).toBeNull();
    } finally {
      wrapper.unmount();
    }
  });
});
