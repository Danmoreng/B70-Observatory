import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../src/lib/i18n.js';
import { runStatusLabel, taskStatusView } from '../src/lib/labels.js';

describe('runStatusLabel', () => {
  it.each([
    ['queued', 'Waiting'],
    ['starting', 'Starting Pi'],
    ['running', 'Agent is working'],
    ['completed', 'Finished · unverified'],
    ['yielded', 'Waiting for input'],
    ['failed', 'Run failed'],
    ['cancelled', 'Cancelled'],
    ['interrupted', 'Interrupted'],
  ])('renders the durable %s state without needing a live snapshot', (status, label) => {
    expect(runStatusLabel(status, undefined)).toBe(label);
  });
});

describe('taskStatusView', () => {
  it('renders a saved pause as paused instead of failed', () => {
    expect(runStatusLabel('interrupted', 'paused')).toBe('Paused');
    expect(
      taskStatusView({
        taskStatus: 'open',
        runStatus: 'interrupted',
        snapshotStatus: 'paused',
        hasResult: false,
        hasOpenQuestion: false,
      }).label
    ).toBe('Paused');
  });
  afterEach(() => {
    setLocale('en');
  });

  it('says working while the selected run is active, regardless of results', () => {
    for (const runStatus of ['starting', 'running'] as const) {
      expect(
        taskStatusView({ taskStatus: 'open', runStatus, hasResult: false, hasOpenQuestion: false })
      ).toEqual({
        label: 'Working',
        action: 'Steer the run or queue the next step below.',
      });
    }
  });

  it('shows queued work as waiting without suggesting live steering', () => {
    expect(
      taskStatusView({
        taskStatus: 'open',
        runStatus: 'queued',
        hasResult: false,
        hasOpenQuestion: false,
      })
    ).toEqual({ label: 'Waiting' });
    expect(runStatusLabel(undefined, 'queued')).toBe('Waiting');
    setLocale('de');
    expect(
      taskStatusView({
        taskStatus: 'open',
        runStatus: 'queued',
        hasResult: false,
        hasOpenQuestion: false,
      }).label
    ).toBe('Wartet');
  });

  it('flags an open question over any other terminal state', () => {
    expect(
      taskStatusView({
        taskStatus: 'open',
        runStatus: 'yielded',
        hasResult: true,
        hasOpenQuestion: true,
      })
    ).toEqual({
      label: 'Needs your answer',
      action: 'Answer the open question below.',
    });
  });

  it('asks for a review once a result exists, and to continue without one', () => {
    expect(
      taskStatusView({
        taskStatus: 'open',
        runStatus: 'completed',
        hasResult: true,
        hasOpenQuestion: false,
      })
    ).toEqual({
      label: 'For review',
      action: 'Review the changes in the Changes tab.',
    });
    expect(
      taskStatusView({
        taskStatus: 'open',
        runStatus: 'completed',
        hasResult: false,
        hasOpenQuestion: false,
      })
    ).toEqual({
      label: 'Finished · unverified',
      action: 'Continue below with the next step.',
    });
  });

  it('keeps failure states honest and archived tasks quiet', () => {
    expect(
      taskStatusView({
        taskStatus: 'open',
        runStatus: 'failed',
        hasResult: false,
        hasOpenQuestion: false,
      }).label
    ).toBe('Run failed');
    expect(
      taskStatusView({
        taskStatus: 'archived',
        runStatus: 'completed',
        hasResult: true,
        hasOpenQuestion: false,
      })
    ).toEqual({
      label: 'Archived',
    });
  });

  it('mirrors the compact states in German', () => {
    setLocale('de');
    expect(
      taskStatusView({
        taskStatus: 'open',
        runStatus: 'running',
        hasResult: false,
        hasOpenQuestion: false,
      })
    ).toEqual({
      label: 'In Arbeit',
      action: 'Leite unten den Lauf oder reihe den nächsten Schritt ein.',
    });
    expect(
      taskStatusView({
        taskStatus: 'open',
        runStatus: 'yielded',
        hasResult: true,
        hasOpenQuestion: true,
      }).label
    ).toBe('Braucht deine Antwort');
    expect(
      taskStatusView({
        taskStatus: 'open',
        runStatus: 'completed',
        hasResult: true,
        hasOpenQuestion: false,
      }).label
    ).toBe('Zur Prüfung');
  });
});
