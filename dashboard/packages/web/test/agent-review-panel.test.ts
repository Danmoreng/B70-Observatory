import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import {
  AgentRunSnapshotSchema,
  SERVICE_NAME,
  type AgentReview,
  type AgentRunResult,
} from '@observatory/contracts';
import AgentReviewPanel from '../src/components/agent/AgentReviewPanel.vue';

const result: AgentRunResult = {
  runId: '11111111-1111-4111-8111-111111111111',
  resultRevision: 'a'.repeat(40),
  files: ['src/value.ts'],
  diff: 'diff',
  diffTruncated: false,
  checkStatus: 'passed',
  checks: [],
};

const review: AgentReview = {
  id: '22222222-2222-4222-8222-222222222222',
  taskId: '33333333-3333-4333-8333-333333333333',
  sourceRunId: result.runId,
  reviewerRunId: '44444444-4444-4444-8444-444444444444',
  resultRevision: result.resultRevision,
  status: 'completed',
  summary: 'One actionable issue.',
  findings: [
    {
      id: '55555555-5555-4555-8555-555555555555',
      severity: 'high',
      title: 'Missing bound',
      file: 'src/value.ts',
      line: 8,
      reasoning: 'The value can overflow.',
      selected: false,
    },
  ],
  stale: false,
  createdAt: '2026-09-13T17:00:00.000Z',
  finishedAt: '2026-09-13T17:01:00.000Z',
};

const liveSnapshot = AgentRunSnapshotSchema.parse({
  service: SERVICE_NAME,
  enabled: true,
  status: 'settled',
  sequence: 4,
  runId: review.reviewerRunId,
  pendingSteering: 0,
  timeline: [
    {
      id: '66666666-6666-4666-8666-666666666666',
      at: '2026-09-13T17:00:30.000Z',
      kind: 'thinking',
      title: 'Reasoning',
      text: 'Inspecting the boundary.',
      state: 'complete',
    },
  ],
});

describe('AgentReviewPanel', () => {
  it('starts a revision-bound review and emits only selected findings for correction', async () => {
    const wrapper = mount(AgentReviewPanel, {
      props: {
        reviews: [review],
        result,
        mayStart: true,
        reviewing: false,
        correcting: false,
        liveSnapshot,
      },
    });

    await wrapper.get('.review-launch textarea').setValue('Inspect the boundary.');
    await wrapper.get('.review-launch').trigger('submit');
    expect(wrapper.emitted('review')?.[0]).toEqual([
      {
        sourceRunId: result.runId,
        resultRevision: result.resultRevision,
        instructions: 'Inspect the boundary.',
      },
    ]);
    expect(wrapper.get('.review-activity .agent-timeline').text()).toContain(
      'Inspecting the boundary.'
    );

    await wrapper.get('.review-finding input').setValue(true);
    await wrapper.get('.review-correction').trigger('submit');
    expect(wrapper.emitted('correct')?.[0]).toEqual([
      { reviewId: review.id, findingIds: [review.findings[0]!.id] },
    ]);
  });

  it('disables correction of findings from an older revision', () => {
    const wrapper = mount(AgentReviewPanel, {
      props: {
        reviews: [{ ...review, stale: true }],
        result,
        mayStart: true,
        reviewing: false,
        correcting: false,
        liveSnapshot,
      },
    });

    expect(wrapper.get('.review-stale').text()).toBe('Older version');
    expect(wrapper.get('.review-finding input').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.review-correction').exists()).toBe(false);
  });
});
