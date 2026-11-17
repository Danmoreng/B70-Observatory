/**
 * Local input drafts for the agent task input, kept per task and per mode so
 * switching tasks or reloading the page never mixes or loses in-progress text.
 *
 * Only short draft strings are stored — never transcripts, credentials or
 * anything that could be a secret. localStorage can be unavailable (private
 * mode, quota, tests); every access is best-effort and must never break the
 * input itself.
 */

const DRAFT_PREFIX = 'observatory.agent.draft.';

/** The four existing task actions a draft can belong to. */
export type AgentInputMode = 'steer' | 'followup' | 'answer' | 'continue';

const MODES: readonly AgentInputMode[] = ['steer', 'followup', 'answer', 'continue'];

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function agentDraftKey(taskId: string, mode: AgentInputMode): string {
  return `${DRAFT_PREFIX}${taskId}.${mode}`;
}

export function readAgentDraft(taskId: string, mode: AgentInputMode): string | undefined {
  try {
    return storage()?.getItem(agentDraftKey(taskId, mode)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Empty text removes the draft; a storage failure is deliberately silent. */
export function writeAgentDraft(taskId: string, mode: AgentInputMode, text: string): void {
  try {
    const target = storage();
    if (target === undefined) return;
    if (text.trim() === '') target.removeItem(agentDraftKey(taskId, mode));
    else target.setItem(agentDraftKey(taskId, mode), text);
  } catch {
    // Drafts are a convenience; the input keeps working without storage.
  }
}

export function removeAgentDraft(taskId: string, mode: AgentInputMode): void {
  try {
    storage()?.removeItem(agentDraftKey(taskId, mode));
  } catch {
    // Ignore: clearing is best-effort.
  }
}

/**
 * Removes every agent input draft. Called when the user signs out, because a
 * stored draft must not survive the session in this browser.
 */
export function clearAgentDrafts(): void {
  const target = storage();
  if (target === undefined) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key !== null && key.startsWith(DRAFT_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => target.removeItem(key));
  } catch {
    // Ignore: an unusable storage must not block sign-out.
  }
}

/** Draft keys of one task, in a stable mode order (used by tests and cleanup). */
export function agentDraftKeysForTask(taskId: string): string[] {
  return MODES.map((mode) => agentDraftKey(taskId, mode));
}
