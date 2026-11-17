/** Values substituted into the checked-in systemd unit templates. */
export interface ServiceUnitValues {
  user: string;
  group: string;
  projectDir: string;
  envFile: string;
  nodeBinary: string;
  helperBinary: string;
  releaseHelperBinary: string;
  releaseRoot: string;
  observatoryHost: string;
  releaseEnvFile: string;
  runnerEnvFile: string;
  runnerProjectRoots: string;
  userId: string;
}

/** Pure renderer kept separate so unit generation can be tested without installation. */
export function renderUnit(template: string, values: ServiceUnitValues): string {
  return template
    .replaceAll('{{USER}}', values.user)
    .replaceAll('{{GROUP}}', values.group)
    .replaceAll('{{PROJECT_DIR}}', values.projectDir)
    .replaceAll('{{ENV_FILE}}', values.envFile)
    .replaceAll('{{NODE_BINARY}}', values.nodeBinary)
    .replaceAll('{{HELPER_BINARY}}', values.helperBinary)
    .replaceAll('{{RELEASE_HELPER_BINARY}}', values.releaseHelperBinary)
    .replaceAll('{{RELEASE_ROOT}}', values.releaseRoot)
    .replaceAll('{{OBSERVATORY_HOST}}', values.observatoryHost)
    .replaceAll('{{RELEASE_ENV_FILE}}', values.releaseEnvFile)
    .replaceAll('{{RUNNER_ENV_FILE}}', values.runnerEnvFile)
    .replaceAll('{{RUNNER_PROJECT_ROOTS}}', values.runnerProjectRoots)
    .replaceAll('{{USER_ID}}', values.userId);
}
