import type { DurableRunStatus, DurableTurnStatus } from './index.js';

const RUN_TRANSITIONS: Readonly<Record<DurableRunStatus, readonly DurableRunStatus[]>> = {
  queued: ['starting', 'cancelled', 'interrupted'],
  starting: ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['completed', 'yielded', 'failed', 'cancelled', 'interrupted'],
  completed: [],
  yielded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

const TURN_TRANSITIONS: Readonly<Record<DurableTurnStatus, readonly DurableTurnStatus[]>> = {
  queued: ['active', 'cancelled', 'interrupted'],
  active: ['waiting_for_input', 'completed', 'cancelled', 'interrupted'],
  waiting_for_input: ['active', 'cancelled', 'interrupted'],
  completed: [],
  cancelled: [],
  interrupted: [],
};

export function canTransitionRun(from: DurableRunStatus, to: DurableRunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionTurn(from: DurableTurnStatus, to: DurableTurnStatus): boolean {
  return TURN_TRANSITIONS[from].includes(to);
}

/**
 * Explicit recovery edges, deliberately kept separate from the normal
 * lifecycle graph. `interrupted -> queued` is the durable requeue performed
 * by a dedicated recovery command (AgentTaskStore.requeueDurableRun) after
 * the previous runner stopped. It is not a normal edge: `canTransitionRun`
 * must keep answering false for it, and only that explicit recovery command
 * may perform it.
 */
const RUN_RECOVERY_TRANSITIONS: Readonly<Record<DurableRunStatus, readonly DurableRunStatus[]>> = {
  queued: [],
  starting: [],
  running: [],
  completed: [],
  yielded: [],
  failed: [],
  cancelled: [],
  interrupted: ['queued'],
};

export function canRecoverRun(from: DurableRunStatus, to: DurableRunStatus): boolean {
  return RUN_RECOVERY_TRANSITIONS[from].includes(to);
}

export function isTerminalRunStatus(status: DurableRunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

export function isTerminalTurnStatus(status: DurableTurnStatus): boolean {
  return TURN_TRANSITIONS[status].length === 0;
}
