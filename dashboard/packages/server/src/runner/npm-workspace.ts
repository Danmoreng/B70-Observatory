import { randomBytes } from 'node:crypto';
import { launchWorkspaceUtility } from '@observatory/runner';
import type { NpmRegistryAccess } from './npm-registry.js';

export async function prepareNpmWorkspace(
  supportRoot: string,
  registry: NpmRegistryAccess | undefined,
  workspacePath: string,
  build = false
): Promise<string> {
  if (registry === undefined) return '';
  const token = randomBytes(32).toString('hex');
  registry.register(token);
  try {
    const job = launchWorkspaceUtility({
      runId: randomBytes(16).toString('hex'),
      workspacePath,
      runtimeRoot: supportRoot,
      runtimeExecutable: 'npm-prepare.js',
      npm: { socketRoot: registry.socketRoot, token },
      args: [Buffer.from(JSON.stringify({ build })).toString('base64url')],
      limits: {
        memoryBytes: 4 * 1024 ** 3,
        cpuQuotaPercent: 200,
        tasksMax: 128,
        runtimeSeconds: 15 * 60,
        tmpBytes: 1024 ** 3,
      },
    });
    return await new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      job.child.stdout.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-16384);
      });
      job.child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-16384);
      });
      job.child.once('error', reject);
      job.child.once('close', (code) => {
        try {
          const value = JSON.parse(stdout) as { ok: boolean; error?: string };
          if (code !== 0 || !value.ok)
            reject(new Error(`${value.error ?? 'npm preparation failed'}\n${stderr.slice(-4096)}`));
          else resolve(stderr);
        } catch (error) {
          reject(
            new Error(
              `npm helper failed: ${error instanceof Error ? error.message : String(error)}\n${stderr.slice(-4096)}`
            )
          );
        }
      });
      job.child.stdin.end();
    });
  } finally {
    registry.revoke(token);
  }
}
