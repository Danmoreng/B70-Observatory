import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { AgentRunResult, ReleaseJob } from '@observatory/contracts';
import AgentReleasePanel from '../src/components/agent/AgentReleasePanel.vue';

const result: AgentRunResult = {
  runId: '11111111-1111-4111-8111-111111111111',
  resultRevision: 'a'.repeat(40),
  files: ['dashboard/src/value.ts'],
  diff: 'diff',
  diffTruncated: false,
  checkStatus: 'passed',
  checks: [],
  acceptedAt: '2026-09-13T18:00:00.000Z',
  acceptedRevision: 'a'.repeat(40),
  mergedAt: '2026-09-13T18:02:00.000Z',
  mergedRevision: 'a'.repeat(40),
};

const release: ReleaseJob = {
  id: '22222222-2222-4222-8222-222222222222',
  taskId: '33333333-3333-4333-8333-333333333333',
  runId: result.runId,
  projectId: '44444444-4444-4444-8444-444444444444',
  target: 'observatory',
  revision: result.resultRevision,
  status: 'prepared',
  checkStatus: 'passed',
  buildLog: '535 tests passed',
  artifactDigest: 'b'.repeat(64),
  createdAt: '2026-09-13T18:01:00.000Z',
  updatedAt: '2026-09-13T18:02:00.000Z',
  preparedAt: '2026-09-13T18:02:00.000Z',
};

describe('AgentReleasePanel', () => {
  it('starts a build only for a merged result on an approved target', async () => {
    const wrapper = mount(AgentReleasePanel, {
      props: { result, releases: [], capable: true, releasing: false },
    });
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('prepare')?.[0]).toEqual([result]);
  });

  it('blocks the build while the result is only accepted but not merged', () => {
    const wrapper = mount(AgentReleasePanel, {
      props: {
        result: {
          ...result,
          mergedAt: undefined,
          mergedRevision: undefined,
        },
        releases: [],
        capable: true,
        releasing: false,
      },
    });
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.text()).toContain(
      'Merge this exact result into the project before building a release.'
    );
  });

  it('shows the durable artifact digest and build log', () => {
    const wrapper = mount(AgentReleasePanel, {
      props: { result, releases: [release], capable: true, releasing: false },
    });
    expect(wrapper.text()).toContain('Ready to activate');
    expect(wrapper.text()).toContain(release.artifactDigest);
    expect(wrapper.get('pre').text()).toContain('535 tests passed');
  });

  it('offers activation and rollback for a prepared version', async () => {
    const wrapper = mount(AgentReleasePanel, {
      props: {
        result,
        releases: [release],
        capable: true,
        releasing: false,
        deploying: false,
        deployment: {
          status: 'active',
          current: {
            releaseId: 'bootstrap-123',
            revision: 'c'.repeat(40),
            digest: 'd'.repeat(64),
          },
          previous: {
            releaseId: 'bootstrap-122',
            revision: 'e'.repeat(40),
            digest: 'f'.repeat(64),
          },
          updatedAt: '2026-09-13T18:03:00.000Z',
        },
      },
    });
    const buttons = wrapper.findAll('button');
    await buttons.find((button) => button.text() === 'Activate version')?.trigger('click');
    expect(wrapper.emitted('activate')?.[0]).toEqual([release]);
    await buttons.find((button) => button.text() === 'Roll back')?.trigger('click');
    expect(wrapper.emitted('rollback')).toHaveLength(1);
  });
});
