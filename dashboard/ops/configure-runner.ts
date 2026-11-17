import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RunnerConfigSchema } from '../packages/server/src/runner/config.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function safePath(value: string, label: string): string {
  const path = resolve(value);
  if (/['"\r\n\0%\\]/.test(path)) throw new Error(`${label} contains an unsafe character`);
  return path;
}

function replaceEnvironmentValue(content: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const matcher = new RegExp(`^${name}=.*$`, 'm');
  return matcher.test(content) ? content.replace(matcher, line) : `${content.trimEnd()}\n${line}\n`;
}

function atomicWrite(path: string, content: string, mode: number): void {
  const pending = `${path}.new`;
  writeFileSync(pending, content, { encoding: 'utf8', mode });
  chmodSync(pending, mode);
  renameSync(pending, path);
}

function main(): void {
  const projectDir = safePath(argument('--project-dir') ?? '.', 'project directory');
  const repository = safePath(argument('--repository') ?? dirname(projectDir), 'repository');
  const agentRuntimeRoot = safePath(
    argument('--agent-runtime-root') ?? `${repository}/pi/node_modules`,
    'agent runtime root'
  );
  const envFile = safePath(
    argument('--env-file') ?? `${projectDir}/data/observatory.env`,
    'observatory env file'
  );
  const runnerEnvFile = safePath(
    argument('--runner-env-file') ?? `${projectDir}/data/runner.env`,
    'runner env file'
  );
  const profileRoot = safePath(
    argument('--profile-root') ?? `${projectDir}/data/runner-profile`,
    'runner profile root'
  );
  const supportRoot = safePath(`${projectDir}/packages/runner/dist`, 'support root');
  const dependencyRoot = safePath(
    `${repository}/dashboard/node_modules`,
    'dashboard dependency root'
  );
  const projectRoots = safePath(dirname(repository), 'allowed project root');
  if (!existsSync(envFile)) throw new Error(`missing Observatory environment file: ${envFile}`);
  for (const [path, label] of [
    [repository, 'repository'],
    [agentRuntimeRoot, 'Pi runtime'],
    [supportRoot, 'runner build'],
    [dependencyRoot, 'dashboard dependencies'],
  ] as const) {
    if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
  }
  const agentExecutable = '@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  if (!existsSync(`${agentRuntimeRoot}/${agentExecutable}`)) {
    throw new Error('the pinned Pi runtime is incomplete; expected coding-agent CLI is missing');
  }
  const dirty = execFileSync(
    '/usr/bin/git',
    ['-C', repository, 'status', '--porcelain', '--untracked-files=no'],
    { encoding: 'utf8' }
  );
  if (dirty.trim() !== '') {
    throw new Error('repository working tree must be clean before runner installation');
  }
  const revision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('could not resolve repository HEAD');

  mkdirSync(dirname(runnerEnvFile), { recursive: true, mode: 0o700 });
  mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  const unexpectedProfileEntries = readdirSync(profileRoot).filter(
    (entry) => entry !== 'models.json'
  );
  if (unexpectedProfileEntries.length > 0) {
    throw new Error('runner profile directory must contain only models.json');
  }
  const modelProfile = {
    providers: {
      'b70-vllm': {
        baseUrl: 'http://127.0.0.1:8081/v1',
        api: 'openai-completions',
        apiKey: '$B70_INFERENCE_TOKEN',
        models: [
          {
            id: 'Qwen3.8-27B',
            name: 'Arc B70 · Qwen3.8 27B · isolated vLLM',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 204800,
            maxTokens: 16384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            thinkingLevelMap: {
              off: 'none',
              minimal: null,
              low: 'low',
              medium: 'medium',
              high: 'high',
              xhigh: null,
              max: null,
            },
            samplingParams: {
              temperature: 1,
              top_p: 0.95,
              top_k: 20,
              min_p: 0,
              repeat_penalty: 1,
            },
            compat: {
              supportsDeveloperRole: false,
              supportsStore: false,
              supportsReasoningEffort: true,
              maxTokensField: 'max_tokens',
              thinkingFormat: 'qwen-chat-template',
            },
          },
        ],
      },
    },
  };
  const controlToken = randomBytes(32).toString('hex');
  const serverEnv = readFileSync(envFile, 'utf8');
  const serverValue = (name: string) =>
    new RegExp(`^${name}=(.*)$`, 'm').exec(serverEnv)?.[1]?.trim();
  const bindHost = serverValue('OBSERVATORY_HOST') ?? '127.0.0.1';
  const gatewayHost = ['0.0.0.0', '::'].includes(bindHost) ? '127.0.0.1' : bindHost;
  const gatewayUrl =
    argument('--gateway-url') ??
    process.env.B70_RUNNER_GATEWAY_URL ??
    `http://${gatewayHost.includes(':') ? `[${gatewayHost}]` : gatewayHost}:${serverValue('OBSERVATORY_PORT') ?? '8090'}`;
  const gatewayToken = process.env.B70_RUNNER_GATEWAY_TOKEN;
  if ((serverValue('OBSERVATORY_GATEWAY_AUTH_MODE') ?? 'token') === 'token' && !gatewayToken)
    throw new Error(
      'Set B70_RUNNER_GATEWAY_TOKEN to the existing gateway credential before configuring the runner.'
    );
  if (
    !RunnerConfigSchema.pick({ gatewayUrl: true, gatewayToken: true }).safeParse({
      gatewayUrl,
      gatewayToken,
    }).success
  )
    throw new Error('Invalid inference gateway origin or credential.');
  atomicWrite(`${profileRoot}/models.json`, `${JSON.stringify(modelProfile, null, 2)}\n`, 0o600);
  atomicWrite(
    runnerEnvFile,
    [
      'B70_RUNNER_CONTROL_SOCKET=/run/local-ai-b70-runner/control.sock',
      `B70_RUNNER_CONTROL_TOKEN=${controlToken}`,
      'B70_RUNNER_INFERENCE_SOCKET_ROOT=/run/local-ai-b70-runner/inference',
      'B70_RUNNER_DATABASE_PATH=/var/lib/local-ai-b70-runner/tasks.sqlite',
      `B70_RUNNER_REPOSITORY=${repository}`,
      'B70_RUNNER_STATE_ROOT=/var/lib/local-ai-b70-runner/runs',
      `B70_RUNNER_SUPPORT_ROOT=${supportRoot}`,
      'B70_RUNNER_SUPPORT_EXECUTABLE=sandbox-entry.js',
      `B70_RUNNER_AGENT_RUNTIME_ROOT=${agentRuntimeRoot}`,
      `B70_RUNNER_AGENT_EXECUTABLE=${agentExecutable}`,
      `B70_RUNNER_PROFILE_ROOT=${profileRoot}`,
      `B70_RUNNER_DEPENDENCY_ROOT=${dependencyRoot}`,
      `B70_RUNNER_REVISION=${revision}`,
      'B70_RUNNER_TARGET_BRANCH=main',
      `B70_RUNNER_PROJECT_ROOTS=${projectRoots}`,
      'B70_RUNNER_UPSTREAM_URL=http://127.0.0.1:8081',
      `B70_RUNNER_GATEWAY_URL=${gatewayUrl}`,
      ...(gatewayToken ? [`B70_RUNNER_GATEWAY_TOKEN=${gatewayToken}`] : []),
      'B70_RUNNER_PROVIDER=b70-vllm',
      'B70_RUNNER_MODEL=Qwen3.8-27B',
      'B70_RUNNER_THINKING_LEVEL=medium',
      'B70_RUNNER_PROFILE_ID=coding-default-v1',
      'B70_RUNNER_MAX_ACTIVE_RUNS=2',
      '',
    ].join('\n'),
    0o600
  );
  let observatoryEnv = readFileSync(envFile, 'utf8');
  observatoryEnv = replaceEnvironmentValue(
    observatoryEnv,
    'OBSERVATORY_AGENT_EXECUTION_MODE',
    'isolated'
  );
  observatoryEnv = replaceEnvironmentValue(
    observatoryEnv,
    'OBSERVATORY_AGENT_RUNNER_SOCKET',
    '/run/local-ai-b70-runner/control.sock'
  );
  observatoryEnv = replaceEnvironmentValue(
    observatoryEnv,
    'OBSERVATORY_AGENT_RUNNER_TOKEN',
    controlToken
  );
  atomicWrite(envFile, observatoryEnv, 0o600);
  process.stdout.write(
    `Prepared isolated runner config for commit ${revision}\nRunner env: ${runnerEnvFile}\nProfile: ${profileRoot}\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[b70-runner-config] ${error instanceof Error ? error.message : 'configuration failed'}\n`
  );
  process.exitCode = 1;
}
