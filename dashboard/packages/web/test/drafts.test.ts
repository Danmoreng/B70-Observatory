import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentDraftKey,
  agentDraftKeysForTask,
  clearAgentDrafts,
  readAgentDraft,
  removeAgentDraft,
  writeAgentDraft,
} from '../src/lib/drafts.js';

const taskId = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('agent input drafts', () => {
  it('keeps drafts per task and mode without mixing them', () => {
    writeAgentDraft(taskId, 'steer', 'Korrigiere den Pfad');
    writeAgentDraft(taskId, 'continue', 'Füge einen Test hinzu');
    const other = '22222222-2222-4222-8222-222222222222';
    writeAgentDraft(other, 'steer', 'Anderes Projekt');

    expect(readAgentDraft(taskId, 'steer')).toBe('Korrigiere den Pfad');
    expect(readAgentDraft(taskId, 'continue')).toBe('Füge einen Test hinzu');
    expect(readAgentDraft(other, 'steer')).toBe('Anderes Projekt');
    expect(readAgentDraft(taskId, 'answer')).toBeUndefined();
    expect(localStorage.getItem(agentDraftKey(taskId, 'followup'))).toBeNull();
  });

  it('removes a draft for one mode only and deletes it on empty text', () => {
    writeAgentDraft(taskId, 'steer', 'a');
    writeAgentDraft(taskId, 'followup', 'b');
    removeAgentDraft(taskId, 'steer');
    expect(readAgentDraft(taskId, 'steer')).toBeUndefined();
    expect(readAgentDraft(taskId, 'followup')).toBe('b');

    writeAgentDraft(taskId, 'followup', '   ');
    expect(readAgentDraft(taskId, 'followup')).toBeUndefined();
    expect(agentDraftKeysForTask(taskId)).toHaveLength(4);
  });

  it('clears only agent drafts, keeping unrelated localStorage entries', () => {
    localStorage.setItem('observatory.locale', 'de');
    writeAgentDraft(taskId, 'steer', 'a');
    writeAgentDraft(taskId, 'answer', 'b');
    clearAgentDrafts();
    expect(readAgentDraft(taskId, 'steer')).toBeUndefined();
    expect(readAgentDraft(taskId, 'answer')).toBeUndefined();
    expect(localStorage.getItem('observatory.locale')).toBe('de');
  });

  it('stays harmless when localStorage is unavailable or throws', () => {
    const broken: Storage = {
      get length(): number {
        throw new Error('quota');
      },
      clear: () => undefined,
      getItem: () => {
        throw new Error('quota');
      },
      key: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('quota');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    vi.stubGlobal('localStorage', broken);
    expect(() => {
      writeAgentDraft(taskId, 'steer', 'x');
      readAgentDraft(taskId, 'steer');
      removeAgentDraft(taskId, 'steer');
      clearAgentDrafts();
    }).not.toThrow();

    vi.stubGlobal('localStorage', undefined);
    expect(readAgentDraft(taskId, 'steer')).toBeUndefined();
    expect(() => clearAgentDrafts()).not.toThrow();
  });
});
