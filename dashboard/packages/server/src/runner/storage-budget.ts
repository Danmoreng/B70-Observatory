/** Persistent dashboard trace + unique image bytes; workspace/build files are separate. */
export const DEFAULT_RUN_STORAGE_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
export const RUN_STORAGE_CONTROL_RESERVE_BYTES = 64 * 1024;

export function isRunStorageBudgetError(error: unknown): error is Error {
  return error instanceof Error && 'code' in error && error.code === 'storage_budget';
}

/** Image callbacks are trusted runner persistence adapters, not model output. */
export function imageStorageFailureReason(error: unknown): string {
  return error instanceof Error && error.name === 'TaskStoreError'
    ? error.message.slice(0, 512)
    : 'Das Bild konnte nicht dauerhaft gespeichert werden.';
}
