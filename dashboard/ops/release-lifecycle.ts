import { chmodSync, chownSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ReleaseRef {
  releaseId: string;
  revision: string;
  digest: string;
}
export interface HelperState {
  version: 1;
  status: 'idle' | 'activating' | 'active' | 'failed' | 'rolled_back';
  current?: ReleaseRef;
  previous?: ReleaseRef;
  pending?: ReleaseRef;
  message?: string;
  updatedAt: string;
}

type StateUpdate = Omit<HelperState, 'version' | 'updatedAt'>;
interface Operations {
  readState(): HelperState;
  writeState(state: StateUpdate): unknown;
  currentTarget(): string | undefined;
  switchCurrent(target: string): void;
  prepare(input: ReleaseRef): void;
  hasRelease(input: ReleaseRef): boolean;
  restartAndCheck(): Promise<void>;
}

/** Root owns installed artifacts; the helper's service group can read/traverse them. */
export function normalizeReleasePermissions(root: string): void {
  const stat = lstatSync(root);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error('unsupported installed release entry');
  chownSync(root, process.getuid!(), process.getgid!());
  chmodSync(root, stat.isDirectory() || (stat.mode & 0o111) !== 0 ? 0o750 : 0o640);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(root)) normalizeReleasePermissions(join(root, entry));
  }
}

const SERVICES = ['local-ai-b70-runner.service', 'local-ai-b70-observatory.service'];
export async function restartReleaseServices(
  systemctl: (args: string[]) => Promise<void>,
  healthy: () => Promise<boolean>
): Promise<void> {
  // A failed candidate may have exhausted StartLimitBurst before recovery starts.
  await systemctl(['reset-failed', ...SERVICES]);
  await systemctl(['restart', ...SERVICES]);
  if (!(await healthy())) throw new Error('the Observatory release did not become healthy');
  // systemctl is-active with multiple units succeeds if ANY unit is active.
  for (const service of SERVICES) await systemctl(['is-active', '--quiet', service]);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'release operation failed';
}

export function createReleaseLifecycle(ops: Operations) {
  async function recover(target: string | undefined): Promise<string> {
    if (target === undefined) return 'No previous release is available for recovery.';
    try {
      ops.switchCurrent(target);
      await ops.restartAndCheck();
      return 'Previous release restored and health checked.';
    } catch (error) {
      return `RECOVERY FAILED: ${message(error)}`;
    }
  }

  return {
    async activate(input: ReleaseRef): Promise<void> {
      const before = ops.readState();
      const oldTarget = ops.currentTarget();
      let switched = false;
      try {
        // Copy, verify and fix access modes before changing the live release.
        ops.prepare(input);
        ops.switchCurrent(`releases/${input.releaseId}`);
        switched = true;
        await ops.restartAndCheck();
        ops.writeState({
          status: 'active',
          current: input,
          previous:
            before.current?.releaseId === input.releaseId ? before.previous : before.current,
        });
      } catch (error) {
        const recovery = switched ? await recover(oldTarget) : 'Live release was not changed.';
        ops.writeState({
          status: 'failed',
          current: before.current,
          previous: before.previous,
          pending: input,
          message: `${message(error)} ${recovery}`,
        });
      }
    },
    async rollback(): Promise<void> {
      const before = ops.readState();
      const oldTarget = ops.currentTarget();
      if (before.previous === undefined || !ops.hasRelease(before.previous)) {
        ops.writeState({
          ...before,
          status: 'failed',
          message: 'No previous release is available.',
        });
        return;
      }
      let switched = false;
      try {
        ops.switchCurrent(`releases/${before.previous.releaseId}`);
        switched = true;
        await ops.restartAndCheck();
        ops.writeState({
          status: 'rolled_back',
          current: before.previous,
          previous: before.current,
        });
      } catch (error) {
        const recovery = switched ? await recover(oldTarget) : 'Live release was not changed.';
        ops.writeState({ ...before, status: 'failed', message: `${message(error)} ${recovery}` });
      }
    },
    async recoverInterrupted(): Promise<void> {
      const before = ops.readState();
      const recovery = await recover(
        before.current === undefined ? undefined : `releases/${before.current.releaseId}`
      );
      ops.writeState({
        ...before,
        status: 'failed',
        message: `Interrupted release operation. ${recovery}`,
      });
    },
  };
}
