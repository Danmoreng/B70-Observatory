import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AgentTimeline from '../src/components/agent/AgentTimeline.vue';
import {
  AgentRunSnapshotSchema,
  AgentStreamEventSchema,
  SERVICE_NAME,
  type AgentRunSnapshot,
  type DurableTaskDetail,
  type DurableTraceEvent,
} from '@observatory/contracts';
import {
  appendTaskTrace,
  reconcileAgentSnapshot,
  reduceAgentSnapshot,
  reduceAgentStreamState,
  taskDetailKey,
} from '../src/composables/useAgentCockpit.js';

const itemId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const base: AgentRunSnapshot = AgentRunSnapshotSchema.parse({
  service: SERVICE_NAME,
  enabled: true,
  status: 'running',
  sequence: 2,
  runId,
  pendingSteering: 0,
  timeline: [
    {
      id: itemId,
      at: '2026-09-12T12:00:00.000Z',
      kind: 'assistant',
      title: 'Agent',
      text: 'Hello',
      state: 'running',
    },
  ],
});

describe('Agent Cockpit stream reducer', () => {
  it('keeps tool arguments, screenshots and results in one open card with a single header', () => {
    const wrapper = mount(AgentTimeline, {
      props: {
        runId,
        loading: false,
        items: [
          {
            id: itemId,
            at: '2026-11-15T18:00:00.000Z',
            kind: 'tool',
            title: 'browser_action',
            toolName: 'browser_action',
            argumentsText: '{"action":"inspect"}',
            outputText: 'Visible DOM report',
            state: 'complete',
            images: [
              {
                id: itemId,
                runId,
                mimeType: 'image/png',
                width: 600,
                height: 800,
                byteLength: 100,
              },
            ],
          },
        ],
      },
    });
    const card = wrapper.get('article.tool-call');
    expect(card.findAll('header')).toHaveLength(1);
    expect(card.findAll('.tool-payload-card')).toHaveLength(2);
    expect(card.findAll('.tool-payload-card')[0]!.text()).toContain('{"action":"inspect"}');
    const output = card.findAll('.tool-payload-card')[1]!;
    expect(output.text()).toContain('Visible DOM report');
    expect(output.find('img').attributes('src')).toContain(itemId);
    expect(card.findAll('img')).toHaveLength(1);
    expect(card.find('details, summary').exists()).toBe(false);
    wrapper.unmount();
  });
  it('appends streaming text without inventing zero-value gaps or duplicate entries', () => {
    const event = AgentStreamEventSchema.parse({
      operation: 'append_text',
      sequence: 3,
      itemId,
      text: ' world',
    });
    const next = reduceAgentSnapshot(base, event);
    expect(next.timeline).toHaveLength(1);
    expect(next.timeline[0]?.text).toBe('Hello world');
    expect(next.sequence).toBe(3);
  });

  it('applies only fetched trace deltas to an already cached task snapshot', () => {
    const detail = { latestSnapshot: base, traceEventCount: 12 } as DurableTaskDetail;
    const delta: DurableTraceEvent[] = [
      {
        id: 13,
        runId,
        sequence: 3,
        recordedAt: '2026-09-12T12:00:01.000Z',
        event: AgentStreamEventSchema.parse({
          operation: 'append_text',
          sequence: 3,
          itemId,
          text: ' from cache',
        }),
      },
    ];

    const next = appendTaskTrace(detail, delta);
    expect(next.latestSnapshot?.timeline[0]?.text).toBe('Hello from cache');
    expect(next.latestSnapshot?.sequence).toBe(3);
    expect(next.traceEventCount).toBe(13);
  });

  it('ignores replayed events and accepts an authoritative reset', () => {
    const stale = AgentStreamEventSchema.parse({
      operation: 'append_text',
      sequence: 2,
      itemId,
      text: ' duplicate',
    });
    expect(reduceAgentSnapshot(base, stale)).toBe(base);

    const resetSnapshot = AgentRunSnapshotSchema.parse({
      ...base,
      status: 'settled',
      sequence: 9,
      finishedAt: '2026-09-12T12:01:00.000Z',
      timeline: [],
    });
    const reset = AgentStreamEventSchema.parse({
      operation: 'reset',
      sequence: 9,
      snapshot: resetSnapshot,
    });
    expect(reduceAgentSnapshot(base, reset)).toEqual(resetSnapshot);
  });

  it('switches immediately to a new run even when its sequence starts below the old run', () => {
    const previous = AgentRunSnapshotSchema.parse({
      ...base,
      status: 'settled',
      sequence: 42,
      finishedAt: '2026-09-12T12:01:00.000Z',
    });
    const nextRun = AgentRunSnapshotSchema.parse({
      ...base,
      runId: '33333333-3333-4333-8333-333333333333',
      sequence: 2,
      task: 'Neue Aufgabe',
      timeline: [{ ...base.timeline[0]!, id: '44444444-4444-4444-8444-444444444444' }],
    });
    const reset = AgentStreamEventSchema.parse({
      operation: 'reset',
      sequence: nextRun.sequence,
      snapshot: nextRun,
    });

    expect(reduceAgentSnapshot(previous, reset)).toEqual(nextRun);
  });

  it('accepts a lower-sequence authoritative snapshot after a server restart', () => {
    const restarted = AgentRunSnapshotSchema.parse({
      service: SERVICE_NAME,
      enabled: true,
      status: 'idle',
      sequence: 0,
      pendingSteering: 0,
      timeline: [],
    });
    expect(reconcileAgentSnapshot(base, restarted)).toBe(base);
    expect(reconcileAgentSnapshot(base, restarted, true)).toEqual(restarted);
  });
});

describe('Agent Cockpit connection state', () => {
  it('keeps schema and transport failures distinct', () => {
    const connected = { connection: 'connected' as const };
    expect(reduceAgentStreamState(connected, 'schema_error', 'invalid event')).toEqual({
      connection: 'connected',
      issue: { kind: 'schema', message: 'invalid event' },
    });
    expect(reduceAgentStreamState(connected, 'transport_error', 'socket lost')).toEqual({
      connection: 'disconnected',
      issue: { kind: 'transport', message: 'socket lost' },
    });
  });

  it('clears a stale issue only after a valid authoritative snapshot', () => {
    const failed = reduceAgentStreamState(
      { connection: 'connected' },
      'schema_error',
      'invalid event'
    );
    expect(reduceAgentStreamState(failed, 'open')).toEqual({
      connection: 'connected',
      issue: { kind: 'schema', message: 'invalid event' },
    });
    expect(reduceAgentStreamState(failed, 'snapshot')).toEqual({ connection: 'connected' });
  });
});

describe('Agent Cockpit task cache keys', () => {
  it('uses the bare task id today and already composes a future project scope', () => {
    expect(taskDetailKey(undefined, 'task-1')).toBe('task-1');
    expect(taskDetailKey('project-9', 'task-1')).toBe('project-9:task-1');
  });
});

describe('Agent Cockpit timeline labels', () => {
  const timelineSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/components/agent/AgentTimeline.vue'),
    'utf8'
  );
  const itemHeaderStart = timelineSource.indexOf('<header>', timelineSource.indexOf('v-for="item'));
  const itemHeader = timelineSource.slice(
    itemHeaderStart,
    timelineSource.indexOf('</header>', itemHeaderStart) + '</header>'.length
  );

  it('shows one title plus state and time for each timeline event', () => {
    // The thinking item carries exactly one translated header instead of a
    // raw title. Standard task headers are localized; custom titles remain visible.
    const wrapper = mount(AgentTimeline, {
      props: {
        items: [{ ...base.timeline[0]!, kind: 'thinking', title: 'Reasoning' }],
        loading: false,
      },
    });
    expect(wrapper.get('.timeline-item header strong').text()).toBe('Thinking');
    expect(wrapper.get('.timeline-item header time').attributes('datetime')).toBe(
      base.timeline[0]!.at
    );
    expect(wrapper.findAll('.timeline-item header strong')).toHaveLength(1);
    wrapper.unmount();
    expect(itemHeader).toContain('item.state');
    expect(itemHeader).toContain('{{ formatClock(item.at) }}');
    expect(timelineSource).not.toContain('kindLabel');
  });

  it('keeps user instructions and steering comments prominent', () => {
    expect(timelineSource).toContain("item.kind === 'task' || item.kind === 'steering'");
    expect(timelineSource).toContain('class="user-message"');
  });

  it('shows thinking open with exactly one translated header', () => {
    expect(timelineSource).not.toContain('<details');
    expect(timelineSource).not.toContain('<summary');
    expect(timelineSource).not.toContain('show-more');
    // The single translated header replaces the raw thinking title.
    const wrapper = mount(AgentTimeline, {
      props: {
        items: [
          {
            ...base.timeline[0]!,
            kind: 'thinking',
            title: 'Reasoning',
            text: 'Complete reasoning',
          },
        ],
        loading: false,
      },
    });
    expect(wrapper.get('.timeline-item header strong').text()).toBe('Thinking');
    expect(wrapper.get('.timeline-reasoning-text').text()).toBe('Complete reasoning');
    expect(wrapper.find('details, summary').exists()).toBe(false);
    wrapper.unmount();
    expect(itemHeader).not.toContain("t('agent.thinkingDetails')");
    // The reasoning text is a direct, non-collapsed block.
    expect(timelineSource).toContain('class="timeline-reasoning-text"');
    expect(timelineSource).toContain("item.kind === 'thinking' && item.text");
  });

  it('keeps raw tool arguments and outputs open in labeled cards', () => {
    expect(timelineSource).toContain('class="tool-payload"');
    expect(timelineSource).toContain('item.argumentsText');
    const wrapper = mount(AgentTimeline, {
      props: {
        items: [
          {
            ...base.timeline[0]!,
            kind: 'tool',
            title: 'bash',
            toolName: 'bash',
            argumentsText: '{"cmd":"test"}',
            outputText: 'Full raw output bleibt unverändert',
          },
        ],
        loading: false,
      },
    });
    expect(wrapper.findAll('.tool-payload-card pre').map((node) => node.text())).toEqual([
      '{"cmd":"test"}',
      'Full raw output bleibt unverändert',
    ]);
    wrapper.unmount();
    expect(timelineSource).toContain(`:aria-label="t('agent.toolArguments')"`);
    expect(timelineSource).toContain(`:aria-label="t('agent.toolOutput')"`);
    // Nothing is collapsed, clipped or hidden per event: the whole
    // conversation scrolls, individual blocks never.
    expect(timelineSource).not.toContain('<details');
    expect(timelineSource).not.toContain('<summary');
    expect(timelineSource).not.toContain('max-height');
    expect(timelineSource).not.toContain('-webkit-line-clamp');
    expect(timelineSource).toContain('class="timeline-text timeline-inline-text"');
    expect(timelineSource).not.toContain('copyTimelineText');
    expect(timelineSource).not.toContain('copy-timeline');
  });

  it('keeps notices and errors visible instead of hiding them', () => {
    expect(timelineSource).toContain('timeline-inline-text');
  });

  it('renders assistant responses through the safe Markdown component', () => {
    expect(timelineSource).toContain("import MarkdownText from '../MarkdownText.vue'");
    expect(timelineSource).toContain("item.kind === 'assistant' && item.text");
    expect(timelineSource).toContain('<MarkdownText');
  });

  it('starts the trace directly with its content and keeps only the follow control', () => {
    expect(timelineSource).not.toContain('timeline-heading');
    expect(timelineSource).not.toContain("t('agent.log')");
    expect(timelineSource).not.toContain('Trace JSON');
    expect(timelineSource).not.toContain('timeline-retention');
    expect(timelineSource).toContain('class="follow-button"');
  });

  it('omits permanent instructional copy from the working view', () => {
    for (const redundantCopy of [
      'Live in die Arbeit schauen',
      'Was sichtbar ist',
      'LIVE EINGREIFEN',
      'NEUER LAUF',
      'Pi stellt ihn nach den Tool Calls',
    ]) {
      expect(timelineSource).not.toContain(redundantCopy);
    }
  });

  it('uses conversation, changes and details tabs around one shared input', () => {
    const cockpitSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/components/AgentCockpit.vue'),
      'utf8'
    );
    expect(cockpitSource).toContain('class="task-view-tabs"');
    expect(cockpitSource).toContain("taskView === 'activity'");
    expect(cockpitSource).toContain("taskView === 'changes'");
    expect(cockpitSource).toContain("taskView === 'details'");
    expect(cockpitSource).toContain('import AgentTaskInput');
    expect(cockpitSource).toContain('<AgentTaskInput');
    expect(cockpitSource).not.toContain('AgentSteeringForm');
    // The historical run list lives in the Details view, not next to the
    // conversation.
    expect(cockpitSource).toContain('class="details-subnav"');
    expect(cockpitSource).toContain('class="run-list"');
    expect(cockpitSource).not.toContain('class="panel task-conversation"');
  });
});
