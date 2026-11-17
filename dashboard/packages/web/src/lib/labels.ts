import { t } from './i18n.js';
import type { AgentTimelineItem } from '@observatory/contracts';

/** Localize known application-generated headings, never user or agent prose. */
export function timelineTitle(item: Pick<AgentTimelineItem, 'kind' | 'title'>): string {
  if (item.kind === 'thinking') return t('agent.thinking');
  if (item.kind === 'task') {
    if (['Task', 'Aufgabe'].includes(item.title)) return t('agent.task');
    if (['Deine Nachricht', 'Your message'].includes(item.title)) return t('agent.yourMessage');
  }
  const generated = {
    'Dein Kommentar · zugestellt': 'agent.commentDelivered',
    Wiederholungsversuch: 'agent.retryTitle',
    'Kontext wird komprimiert': 'agent.compactingTitle',
    'Kontext komprimiert': 'agent.compactedTitle',
    'Kontextkomprimierung fehlgeschlagen': 'agent.compactionFailedTitle',
    'Memory · verwendeter Startkontext': 'agent.memoryContextTitle',
    'Bild nicht gespeichert': 'agent.imageNotSavedTitle',
  } as const;
  const key = generated[item.title as keyof typeof generated];
  return key && !['assistant', 'task', 'tool'].includes(item.kind) ? t(key) : item.title;
}

/**
 * Display labels for the agent cockpit's status values. Kept free of
 * framework code beyond the i18n lookup so the cockpit container and its
 * presentation components share one vocabulary; the active locale decides
 * whether the wording is English (default) or German.
 */

/** Label for the run in the summary bar; the durable status wins. */
export function runStatusLabel(
  durableRunStatus: string | undefined,
  snapshotStatus: string | undefined
): string {
  if (snapshotStatus === 'paused') return t('label.paused');
  switch (durableRunStatus) {
    case 'queued':
      return t('label.waiting');
    case 'starting':
      return t('label.piStarting');
    case 'running':
      return t('label.agentWorking');
    case 'completed':
      return t('label.finishedUnverified');
    case 'yielded':
      return t('label.waitingInput');
    case 'failed':
      return t('label.runFailed');
    case 'interrupted':
      return t('label.interrupted');
    case 'cancelled':
      return t('label.cancelled');
  }
  switch (snapshotStatus) {
    case 'queued':
      return t('label.waiting');
    case 'starting':
      return t('label.piStarting');
    case 'running':
      return t('label.agentWorking');
    case 'cancelling':
      return t('label.cancelling');
    case 'cancelled':
      return t('label.cancelled');
    case 'settled':
      return t('label.finishedUnverified');
    case 'failed':
      return t('label.runFailed');
    case 'idle':
      return t('label.ready');
    case 'disabled':
      return t('label.executionDisabled');
    case 'unreachable':
      return t('label.runnerUnreachable');
    default:
      return t('label.loading');
  }
}

/** Label for a timeline item; an interrupted run frames errors differently. */
export function timelineStateLabel(state: string, durableRunStatus?: string): string {
  switch (state) {
    case 'queued':
      return t('label.waiting');
    case 'running':
      return t('label.running');
    case 'complete':
      return t('label.finished');
    case 'error':
      return durableRunStatus === 'interrupted' ? t('label.interrupted') : t('label.error');
    default:
      return state;
  }
}

/**
 * Compact status of one selected durable task. Deliberately derived from the
 * task itself (durable run status, open question, stored result) so it never
 * reflects a different global run, and always paired with the next useful
 * action the user can take.
 */
export interface TaskStatusView {
  label: string;
  action?: string;
}

export function taskStatusView(input: {
  taskStatus: string;
  runStatus: string;
  hasResult: boolean;
  hasOpenQuestion: boolean;
  snapshotStatus?: string;
}): TaskStatusView {
  const { taskStatus, runStatus, hasResult, hasOpenQuestion } = input;
  if (runStatus === 'queued') return { label: t('label.waiting') };
  if (['starting', 'running'].includes(runStatus)) {
    return { label: t('agent.state.working'), action: t('agent.nextAction.steer') };
  }
  if (taskStatus === 'archived') return { label: t('agent.state.archived') };
  if (input.snapshotStatus === 'paused')
    return { label: t('label.paused'), action: t('agent.nextAction.continue') };

  if (hasOpenQuestion) {
    return { label: t('agent.state.needsAnswer'), action: t('agent.nextAction.answer') };
  }
  if (runStatus === 'completed' || runStatus === 'yielded') {
    if (hasResult)
      return { label: t('agent.state.forReview'), action: t('agent.nextAction.review') };
    return {
      label: runStatus === 'yielded' ? t('label.waitingInput') : t('label.finishedUnverified'),
      action: t('agent.nextAction.continue'),
    };
  }
  if (runStatus === 'failed') {
    return { label: t('label.runFailed'), action: t('agent.nextAction.continue') };
  }
  if (runStatus === 'interrupted') {
    return { label: t('label.interrupted'), action: t('agent.nextAction.continue') };
  }
  if (runStatus === 'cancelled') {
    return { label: t('label.cancelled'), action: t('agent.nextAction.continue') };
  }
  return { label: t('label.loading') };
}

/** Label for a task row in the task list. */
export function taskStatusLabel(status: string): string {
  switch (status) {
    case 'queued':
      return t('label.waiting');
    case 'starting':
      return t('label.starting');
    case 'running':
      return t('label.active');
    case 'completed':
      return t('label.finished');
    case 'failed':
      return t('label.failed');
    case 'interrupted':
      return t('label.interrupted');
    case 'cancelled':
      return t('label.cancelled');
    case 'yielded':
      return t('label.waitingInput');
    default:
      return status;
  }
}

/** Label for a steering delivery; a confirmation always wins over the status. */
export function steeringStatusLabel(status: string, confirmedAt?: string): string {
  if (confirmedAt !== undefined) return t('label.confirmed');
  switch (status) {
    case 'stored':
      return t('label.stored');
    case 'sent':
      return t('label.delivered');
    case 'acknowledged':
      return t('label.acknowledged');
    case 'uncertain':
      return t('label.deliveryUncertain');
    case 'cancelled':
      return t('label.notDelivered');
    default:
      return status;
  }
}
