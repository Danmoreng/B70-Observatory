import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isIP } from 'node:net';
import { renderUnit } from './service-unit.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function safePath(value: string, label: string): string {
  const path = resolve(value);
  if (/[\r\n\0%"\\]/.test(path)) throw new Error(`${label} contains an unsafe character`);
  return path;
}

function safeAccount(value: string, label: string): string {
  if (!/^[a-z_][a-z0-9_-]*$/i.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function readRunnerProjectRoots(content: string): string {
  const raw = /^B70_RUNNER_PROJECT_ROOTS=(.*)$/m.exec(content)?.[1]?.trim();
  if (raw === undefined || raw === '') {
    throw new Error('runner environment does not declare B70_RUNNER_PROJECT_ROOTS');
  }
  const roots = raw.split(':').map((value, index) => safePath(value, `project root ${index + 1}`));
  if (roots.length > 16 || roots.some((root) => /\s/.test(root))) {
    throw new Error('runner project roots must be 1–16 absolute paths without whitespace');
  }
  return roots.join(' ');
}

function replaceEnvironmentValue(content: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const matcher = new RegExp(`^${name}=.*$`, 'm');
  return matcher.test(content) ? content.replace(matcher, line) : `${content.trimEnd()}\n${line}\n`;
}

function observatoryHost(content: string): string {
  const configured = /^OBSERVATORY_HOST=(.*)$/m.exec(content)?.[1]?.trim() ?? '127.0.0.1';
  if (configured === '0.0.0.0' || configured === '::' || configured === 'localhost') {
    return 'localhost';
  }
  if (isIP(configured) === 0) throw new Error('OBSERVATORY_HOST must be an IP address');
  return configured;
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun && process.getuid?.() !== 0) throw new Error('run this installer with sudo');
  const projectDir = safePath(argument('--project-dir') ?? '.', 'project directory');
  const envFile = safePath(
    argument('--env-file') ?? `${projectDir}/data/observatory.env`,
    'env file'
  );
  const runnerEnvFile = safePath(
    argument('--runner-env-file') ?? `${projectDir}/data/runner.env`,
    'runner env file'
  );
  const user = safeAccount(argument('--user') ?? process.env.SUDO_USER ?? '', 'user');
  const detectedGroup = execFileSync('id', ['-gn', user], { encoding: 'utf8' }).trim();
  const userId = execFileSync('id', ['-u', user], { encoding: 'utf8' }).trim();
  if (!/^[0-9]+$/.test(userId)) throw new Error('invalid user id');
  const group = safeAccount(argument('--group') ?? detectedGroup, 'group');
  const groupId = execFileSync('getent', ['group', group], { encoding: 'utf8' })
    .trim()
    .split(':')[2];
  if (groupId === undefined || !/^[0-9]+$/.test(groupId)) throw new Error('invalid group id');
  const unitDir = safePath(argument('--unit-dir') ?? '/etc/systemd/system', 'unit directory');
  const helperBuild = safePath(
    argument('--helper-build') ?? `${projectDir}/build/local-ai-b70-gpu-helper`,
    'helper build'
  );
  const helperBinary = safePath(
    argument('--helper-binary') ?? '/usr/local/libexec/local-ai-b70-gpu-helper',
    'helper binary'
  );
  const releaseHelperBuild = safePath(
    argument('--release-helper-build') ?? `${projectDir}/build/local-ai-b70-release-helper.mjs`,
    'release helper build'
  );
  const releaseHelperBinary = safePath(
    argument('--release-helper-binary') ?? '/usr/local/libexec/local-ai-b70-release-helper.mjs',
    'release helper binary'
  );
  const releaseRoot = safePath(
    argument('--release-root') ?? '/var/lib/local-ai-b70-releases',
    'release root'
  );
  const bootstrapBuild = safePath(
    argument('--bootstrap-build') ?? `${projectDir}/build/observatory-release`,
    'bootstrap release build'
  );
  const releaseEnvFile = safePath(
    argument('--release-env-file') ?? '/etc/local-ai-b70/release-helper.env',
    'release helper env file'
  );
  if (!existsSync(envFile)) throw new Error(`missing environment file: ${envFile}`);
  if (!existsSync(runnerEnvFile)) {
    throw new Error(
      `missing runner environment file: ${runnerEnvFile}; run npm run configure:runner`
    );
  }
  const template = readFileSync(
    new URL('./local-ai-b70-observatory.service.template', import.meta.url),
    'utf8'
  );
  const helperTemplate = readFileSync(
    new URL('./local-ai-b70-gpu-helper.service.template', import.meta.url),
    'utf8'
  );
  const runnerTemplate = readFileSync(
    new URL('./local-ai-b70-runner.service.template', import.meta.url),
    'utf8'
  );
  const releaseHelperTemplate = readFileSync(
    new URL('./local-ai-b70-release-helper.service.template', import.meta.url),
    'utf8'
  );
  const values = {
    user,
    group,
    projectDir,
    envFile,
    runnerEnvFile,
    runnerProjectRoots: readRunnerProjectRoots(readFileSync(runnerEnvFile, 'utf8')),
    userId,
    nodeBinary: process.execPath,
    helperBinary,
    releaseHelperBinary,
    releaseRoot,
    observatoryHost: observatoryHost(readFileSync(envFile, 'utf8')),
    releaseEnvFile,
  };
  const content = renderUnit(template, {
    ...values,
  });
  const helperContent = renderUnit(helperTemplate, {
    ...values,
  });
  const runnerContent = renderUnit(runnerTemplate, values);
  const releaseHelperContent = renderUnit(releaseHelperTemplate, values);
  if (!existsSync(`${projectDir}/packages/server/dist/index.js`)) {
    throw new Error('missing production build; run npm run build first');
  }
  if (!existsSync(helperBuild)) {
    throw new Error('missing native GPU helper build; run npm run build first');
  }
  if (!existsSync(`${projectDir}/packages/server/dist/runner/main.js`)) {
    throw new Error('missing runner build; run npm run build first');
  }
  if (!existsSync(`${projectDir}/packages/runner/dist/sandbox-entry.js`)) {
    throw new Error('missing sandbox entry build; run npm run build first');
  }
  if (!existsSync(`${projectDir}/packages/runner/dist/release-builder.js`)) {
    throw new Error('missing release builder; run npm run build first');
  }
  if (!existsSync(releaseHelperBuild)) {
    throw new Error('missing release helper build; run npm run build first');
  }
  if (!existsSync(`${bootstrapBuild}/manifest.json`)) {
    throw new Error('missing bootstrap release artifact; run npm run build first');
  }
  for (const binary of ['/usr/bin/bwrap', '/usr/bin/systemd-run']) {
    if (!existsSync(binary)) throw new Error(`missing required sandbox tool: ${binary}`);
  }
  if (dryRun) {
    process.stdout.write(`${helperContent}\n${releaseHelperContent}\n${runnerContent}\n${content}`);
    return;
  }
  let observatoryEnv = readFileSync(envFile, 'utf8');
  if (!/^OBSERVATORY_RELEASE_HEALTH_TOKEN=[a-f0-9]{64}$/m.test(observatoryEnv)) {
    observatoryEnv = replaceEnvironmentValue(
      observatoryEnv,
      'OBSERVATORY_RELEASE_HEALTH_TOKEN',
      randomBytes(32).toString('hex')
    );
    writeFileSync(envFile, observatoryEnv, { encoding: 'utf8', mode: 0o600 });
    chmodSync(envFile, 0o600);
    execFileSync('chown', [`${user}:${group}`, envFile]);
  }
  const releaseHealthToken = /^OBSERVATORY_RELEASE_HEALTH_TOKEN=([a-f0-9]{64})$/m.exec(
    observatoryEnv
  )?.[1];
  const configuredPort = /^OBSERVATORY_PORT=([0-9]+)$/m.exec(observatoryEnv)?.[1] ?? '8090';
  if (
    releaseHealthToken === undefined ||
    !Number.isInteger(Number(configuredPort)) ||
    Number(configuredPort) < 1 ||
    Number(configuredPort) > 65535
  ) {
    throw new Error('invalid release healthcheck configuration');
  }
  mkdirSync(dirname(releaseEnvFile), { recursive: true, mode: 0o755 });
  writeFileSync(
    releaseEnvFile,
    [
      `OBSERVATORY_HOST=${observatoryHost(observatoryEnv)}`,
      `OBSERVATORY_PORT=${configuredPort}`,
      `OBSERVATORY_RELEASE_HEALTH_TOKEN=${releaseHealthToken}`,
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 }
  );
  chmodSync(releaseEnvFile, 0o600);
  chownSync(releaseEnvFile, 0, 0);
  const dataDirectory = `${projectDir}/data`;
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  execFileSync('chown', [`${user}:${group}`, dataDirectory]);
  mkdirSync(dirname(helperBinary), { recursive: true, mode: 0o755 });
  mkdirSync(dirname(releaseHelperBinary), { recursive: true, mode: 0o755 });
  const pendingHelperBinary = `${helperBinary}.new`;
  copyFileSync(helperBuild, pendingHelperBinary);
  chmodSync(pendingHelperBinary, 0o755);
  chownSync(pendingHelperBinary, 0, 0);
  renameSync(pendingHelperBinary, helperBinary);
  const pendingReleaseHelperBinary = `${releaseHelperBinary}.new`;
  copyFileSync(releaseHelperBuild, pendingReleaseHelperBinary);
  chmodSync(pendingReleaseHelperBinary, 0o755);
  chownSync(pendingReleaseHelperBinary, 0, 0);
  renameSync(pendingReleaseHelperBinary, releaseHelperBinary);

  const manifest = JSON.parse(readFileSync(`${bootstrapBuild}/manifest.json`, 'utf8')) as {
    revision?: unknown;
    artifactDigest?: unknown;
  };
  if (
    typeof manifest.revision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(manifest.revision) ||
    typeof manifest.artifactDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.artifactDigest)
  )
    throw new Error('invalid bootstrap release manifest');
  const bootstrapId = `bootstrap-${manifest.revision.slice(0, 12)}`;
  const releasesDirectory = `${releaseRoot}/releases`;
  const bootstrapDestination = `${releasesDirectory}/${bootstrapId}`;
  mkdirSync(releasesDirectory, { recursive: true, mode: 0o700 });
  chownSync(releaseRoot, 0, Number(groupId));
  chmodSync(releaseRoot, 0o750);
  chownSync(releasesDirectory, 0, Number(groupId));
  chmodSync(releasesDirectory, 0o750);
  const pendingBootstrap = `${bootstrapDestination}.pending`;
  if (!existsSync(bootstrapDestination)) {
    rmSync(pendingBootstrap, { recursive: true, force: true });
    cpSync(bootstrapBuild, pendingBootstrap, { recursive: true });
    renameSync(pendingBootstrap, bootstrapDestination);
  }
  const currentPending = `${releaseRoot}/current.new`;
  try {
    rmSync(currentPending, { force: true });
  } catch {
    // A missing pending link is the expected first-install case.
  }
  symlinkSync(`releases/${bootstrapId}`, currentPending);
  renameSync(currentPending, `${releaseRoot}/current`);
  writeFileSync(
    `${releaseRoot}/state.json`,
    `${JSON.stringify(
      {
        version: 1,
        status: 'active',
        current: {
          releaseId: bootstrapId,
          revision: manifest.revision,
          digest: manifest.artifactDigest,
        },
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  const unitPath = `${unitDir}/local-ai-b70-observatory.service`;
  const helperUnitPath = `${unitDir}/local-ai-b70-gpu-helper.service`;
  const runnerUnitPath = `${unitDir}/local-ai-b70-runner.service`;
  const releaseHelperUnitPath = `${unitDir}/local-ai-b70-release-helper.service`;
  writeFileSync(helperUnitPath, helperContent, { encoding: 'utf8', mode: 0o644 });
  chmodSync(helperUnitPath, 0o644);
  writeFileSync(unitPath, content, { encoding: 'utf8', mode: 0o644 });
  chmodSync(unitPath, 0o644);
  writeFileSync(runnerUnitPath, runnerContent, { encoding: 'utf8', mode: 0o644 });
  chmodSync(runnerUnitPath, 0o644);
  writeFileSync(releaseHelperUnitPath, releaseHelperContent, { encoding: 'utf8', mode: 0o644 });
  chmodSync(releaseHelperUnitPath, 0o644);
  if (!process.argv.includes('--no-systemctl')) {
    execFileSync('loginctl', ['enable-linger', user], { stdio: 'inherit' });
    execFileSync('systemctl', ['daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['enable', '--now', 'local-ai-b70-gpu-helper.service'], {
      stdio: 'inherit',
    });
    execFileSync('systemctl', ['enable', '--now', 'local-ai-b70-release-helper.service'], {
      stdio: 'inherit',
    });
    execFileSync('systemctl', ['enable', '--now', 'local-ai-b70-runner.service'], {
      stdio: 'inherit',
    });
    execFileSync('systemctl', ['enable', '--now', 'local-ai-b70-observatory.service'], {
      stdio: 'inherit',
    });
  }
  console.log(`Installed ${unitPath}`);
  console.log(`Installed ${helperUnitPath}`);
  console.log(`Installed ${runnerUnitPath}`);
  console.log(`Installed ${releaseHelperUnitPath}`);
}

try {
  main();
} catch (error) {
  console.error(`[observatory] ${error instanceof Error ? error.message : 'installation failed'}`);
  process.exitCode = 1;
}
