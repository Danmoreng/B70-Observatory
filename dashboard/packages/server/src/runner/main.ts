import { loadRunnerConfig, RunnerConfigError } from './config.js';
import { createRunner } from './service.js';
import { access, lstat, mkdir, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export async function main(): Promise<void> {
  const config = loadRunnerConfig(process.env);
  await Promise.all([
    access('/usr/bin/bwrap', constants.X_OK),
    access('/usr/bin/systemd-run', constants.X_OK),
    access(config.repository, constants.R_OK),
    access(join(config.supportRoot, config.supportExecutable), constants.R_OK),
    access(join(config.agentRuntimeRoot, config.agentExecutable), constants.R_OK),
    access(join(config.profileRoot, 'models.json'), constants.R_OK),
    access(config.dependencyRoot, constants.R_OK),
  ]);
  const profileEntries = await readdir(config.profileRoot);
  const modelsStat = await lstat(join(config.profileRoot, 'models.json'));
  if (
    profileEntries.length !== 1 ||
    profileEntries[0] !== 'models.json' ||
    !modelsStat.isFile() ||
    modelsStat.isSymbolicLink()
  ) {
    throw new RunnerConfigError('runner profile must contain one regular models.json file');
  }
  await mkdir(config.stateRoot, { recursive: true, mode: 0o700 });
  const runner = await createRunner(config);
  try {
    await runner.relay.start();
  } catch (error) {
    await runner.service.close();
    throw error;
  }
  try {
    await runner.control.start();
  } catch (error) {
    await runner.service.close();
    await runner.relay.close();
    throw error;
  }
  await runner.service.resumeDurableWork();
  const recoveryTimer = setInterval(() => {
    void runner.service
      .resumeDurableWork()
      .catch((error) => console.error('[b70-runner] recovery:', error));
  }, 30_000);
  recoveryTimer.unref();
  process.stdout.write(`[b70-runner] ready on ${config.controlSocket}\n`);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(recoveryTimer);
    await runner.control.close();
    await runner.service.close();
    await runner.relay.close();
  };
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
}

main().catch((error: unknown) => {
  const message = error instanceof RunnerConfigError ? error.message : 'runner startup failed';
  process.stderr.write(`[b70-runner] ${message}\n`);
  process.exit(1);
});
