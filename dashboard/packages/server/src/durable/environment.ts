import { Connection, RemoteExecutionEnv } from '@earendil-works/pi-env';
import {
  buildWorkspaceUtilityArguments,
  DEFAULT_SANDBOX_LIMITS,
  stopSandboxedJob,
} from '@observatory/runner';
import type { RunnerConfig } from '../runner/config.js';
import type { AgentProject } from '@observatory/contracts';
import { join } from 'node:path';
import { remainingWorkSeconds } from './working-hours.js';

export function createDurableEnvironment(
  config: RunnerConfig,
  project: AgentProject,
  workspace: string,
  sandboxRunId: string,
  npmToken?: string
) {
  const options = {
    runId: sandboxRunId,
    workspacePath: workspace,
    runtimeRoot: config.supportRoot,
    runtimeExecutable: 'durable-env-entry.js',
    ...(config.browserRuntimeRoot ? { browserRuntimeRoot: config.browserRuntimeRoot } : {}),
    ...(config.desktopEnabled ? { desktopEnabled: true } : {}),
    ...(project.dependencyPath
      ? {
          dependencyRoot: join(project.repositoryPath, project.dependencyPath),
          dependencyTarget: project.dependencyPath,
        }
      : {}),
    ...(npmToken ? { npm: { socketRoot: config.inferenceSocketRoot, token: npmToken } } : {}),
    limits: {
      ...DEFAULT_SANDBOX_LIMITS,
      tasksMax: config.browserRuntimeRoot || config.desktopEnabled ? 512 : 128,
      runtimeSeconds: remainingWorkSeconds(),
    },
  };
  const connection = new Connection({
    command: ['/usr/bin/systemd-run', ...buildWorkspaceUtilityArguments(options)],
  });
  const env = new RemoteExecutionEnv({
    connection,
    id: 'b70:' + workspace,
    cwd: project.workdir === '.' ? '/workspace' : '/workspace/' + project.workdir,
  });
  return {
    env,
    async close() {
      connection.close();
      await stopSandboxedJob(sandboxRunId).catch(() => undefined);
    },
  };
}
