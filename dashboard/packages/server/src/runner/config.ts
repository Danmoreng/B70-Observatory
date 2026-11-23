import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { DEFAULT_RUN_STORAGE_BUDGET_BYTES } from './storage-budget.js';

const absolutePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => isAbsolute(value) && !value.includes('\0'), 'must be an absolute path');

const relativeExecutable = z
  .string()
  .refine(
    (value) =>
      value.length > 0 &&
      value.length <= 512 &&
      value
        .split('/')
        .every((part) => part !== '.' && part !== '..' && /^[A-Za-z0-9@._+-]+$/.test(part)),
    'must be a safe relative executable path'
  );

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['127.0.0.1', '::1', 'localhost'].includes(url.hostname) &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export const RunnerConfigSchema = z
  .object({
    textRecipesEnabled: z.boolean().optional(),
    imageGenerationEnabled: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
    memoryRuntimeRoot: absolutePath.optional(),
    memoryModelPath: absolutePath.optional(),
    agentEngine: z.enum(['pi-rpc', 'pi-durable']).optional(),
    controlSocket: absolutePath,
    controlToken: z.string().regex(/^[a-f0-9]{64}$/),
    inferenceSocketRoot: absolutePath,
    databasePath: absolutePath,
    repository: absolutePath,
    targetBranch: z.string().min(1).max(256).optional(),
    projectRoots: z.array(absolutePath).min(1).max(16).optional(),
    stateRoot: absolutePath,
    supportRoot: absolutePath,
    supportExecutable: relativeExecutable,
    agentRuntimeRoot: absolutePath,
    agentExecutable: relativeExecutable,
    profileRoot: absolutePath,
    dependencyRoot: absolutePath,
    /**
     * Optional operator opt-in: browser runtime root (e.g. /opt/google/chrome),
     * ro-bound to /browser inside the job sandbox. Without it the browser
     * tools are unavailable and legacy installations keep working unchanged.
     */
    browserRuntimeRoot: absolutePath.optional(),
    /** Own X11 desktop; headless backend must be built into supportRoot/desktop. */
    desktopEnabled: z.boolean().optional(),
    /** Host bridge only; generated code keeps its private network namespace. */
    appHost: z.enum(['127.0.0.1', '0.0.0.0']).optional(),
    npmRegistryEnabled: z.boolean().optional(),
    runStorageBudgetBytes: z
      .number()
      .int()
      .min(64 * 1024 * 1024)
      .max(16 * 1024 ** 3)
      .optional(),
    revision: z.string().regex(/^[a-f0-9]{40}$/, 'must be a full lowercase commit hash'),
    upstreamUrl: z.string().refine(isLoopbackHttpUrl, 'must be a clean loopback http(s) URL'),
    /** All model requests use the Observatory gateway; upstreamUrl is health only. */
    gatewayUrl: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ['http:', 'https:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === '/'
          );
        } catch {
          return false;
        }
      }, 'must be a clean gateway origin')
      .optional(),
    gatewayToken: z
      .string()
      .min(16)
      .max(512)
      .regex(/^[A-Za-z0-9._~-]+$/)
      .optional(),
    inferenceIdleTimeoutMs: z.number().int().min(1).max(3_600_000).optional(),
    provider: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    model: z.string().min(1).max(256),
    thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    profileId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    maxActiveRuns: z.number().int().min(1).max(4),
    releaseSocket: absolutePath,
  })
  .strict();

export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export interface RunnerEnv {
  B70_RUNNER_TEXT_RECIPES?: string;
  B70_RUNNER_MEMORY_ENABLED?: string;
  B70_RUNNER_MEMORY_MODEL?: string;
  B70_RUNNER_GATEWAY_URL?: string;
  B70_RUNNER_GATEWAY_TOKEN?: string;
  B70_RUNNER_CONTROL_SOCKET?: string;
  B70_RUNNER_CONTROL_TOKEN?: string;
  B70_RUNNER_INFERENCE_SOCKET_ROOT?: string;
  B70_RUNNER_DATABASE_PATH?: string;
  B70_RUNNER_REPOSITORY?: string;
  B70_RUNNER_TARGET_BRANCH?: string;
  B70_RUNNER_PROJECT_ROOTS?: string;
  B70_RUNNER_STATE_ROOT?: string;
  B70_RUNNER_SUPPORT_ROOT?: string;
  B70_RUNNER_SUPPORT_EXECUTABLE?: string;
  B70_RUNNER_AGENT_RUNTIME_ROOT?: string;
  B70_RUNNER_AGENT_EXECUTABLE?: string;
  B70_RUNNER_PROFILE_ROOT?: string;
  B70_RUNNER_DEPENDENCY_ROOT?: string;
  B70_RUNNER_BROWSER_RUNTIME_ROOT?: string;
  B70_RUNNER_DESKTOP_ENABLED?: string;
  B70_RUNNER_APP_HOST?: string;
  B70_RUNNER_NPM_ENABLED?: string;
  B70_RUNNER_RUN_STORAGE_BUDGET_BYTES?: string;
  B70_RUNNER_REVISION?: string;
  B70_RUNNER_UPSTREAM_URL?: string;
  B70_RUNNER_INFERENCE_IDLE_TIMEOUT_MS?: string;
  B70_RUNNER_PROVIDER?: string;
  B70_RUNNER_MODEL?: string;
  B70_RUNNER_THINKING_LEVEL?: string;
  B70_RUNNER_PROFILE_ID?: string;
  B70_RUNNER_MAX_ACTIVE_RUNS?: string;
  B70_RUNNER_RELEASE_SOCKET?: string;
  [key: string]: string | undefined;
}

export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerConfigError';
  }
}

export function loadRunnerConfig(env: RunnerEnv = {}): RunnerConfig {
  const result = RunnerConfigSchema.safeParse({
    textRecipesEnabled: env.B70_RUNNER_TEXT_RECIPES === '1',
    imageGenerationEnabled:
      env.B70_RUNNER_IMAGE_GENERATION_ENABLED === undefined
        ? false
        : env.B70_RUNNER_IMAGE_GENERATION_ENABLED === '1'
          ? true
          : env.B70_RUNNER_IMAGE_GENERATION_ENABLED === '0'
            ? false
            : env.B70_RUNNER_IMAGE_GENERATION_ENABLED,
    memoryEnabled:
      env.B70_RUNNER_MEMORY_ENABLED === undefined
        ? false
        : env.B70_RUNNER_MEMORY_ENABLED === '1'
          ? true
          : env.B70_RUNNER_MEMORY_ENABLED === '0'
            ? false
            : env.B70_RUNNER_MEMORY_ENABLED,
    memoryRuntimeRoot:
      env.B70_RUNNER_MEMORY_ENABLED === '1' ? env.B70_RUNNER_SUPPORT_ROOT + '/memory' : undefined,
    memoryModelPath: env.B70_RUNNER_MEMORY_MODEL,
    agentEngine: env.B70_RUNNER_ENGINE ?? 'pi-rpc',
    controlSocket: env.B70_RUNNER_CONTROL_SOCKET ?? '/run/local-ai-b70-runner/control.sock',
    controlToken: env.B70_RUNNER_CONTROL_TOKEN,
    inferenceSocketRoot:
      env.B70_RUNNER_INFERENCE_SOCKET_ROOT ?? '/run/local-ai-b70-runner/inference',
    databasePath: env.B70_RUNNER_DATABASE_PATH ?? '/var/lib/local-ai-b70-runner/tasks.sqlite',
    repository: env.B70_RUNNER_REPOSITORY,
    targetBranch: env.B70_RUNNER_TARGET_BRANCH ?? 'main',
    projectRoots: (
      env.B70_RUNNER_PROJECT_ROOTS ??
      env.B70_RUNNER_REPOSITORY?.replace(/\/[^/]+$/, '') ??
      ''
    )
      .split(':')
      .filter(Boolean),
    stateRoot: env.B70_RUNNER_STATE_ROOT ?? '/var/lib/local-ai-b70-runner/runs',
    supportRoot: env.B70_RUNNER_SUPPORT_ROOT,
    supportExecutable: env.B70_RUNNER_SUPPORT_EXECUTABLE ?? 'sandbox-entry.js',
    agentRuntimeRoot: env.B70_RUNNER_AGENT_RUNTIME_ROOT,
    agentExecutable:
      env.B70_RUNNER_AGENT_EXECUTABLE ?? '@earendil-works/pi-coding-agent/dist/bundle/cli.js',
    profileRoot: env.B70_RUNNER_PROFILE_ROOT,
    dependencyRoot: env.B70_RUNNER_DEPENDENCY_ROOT,
    browserRuntimeRoot: env.B70_RUNNER_BROWSER_RUNTIME_ROOT,
    desktopEnabled:
      env.B70_RUNNER_DESKTOP_ENABLED === undefined
        ? false
        : env.B70_RUNNER_DESKTOP_ENABLED === '1'
          ? true
          : env.B70_RUNNER_DESKTOP_ENABLED === '0'
            ? false
            : env.B70_RUNNER_DESKTOP_ENABLED,
    appHost: env.B70_RUNNER_APP_HOST ?? '0.0.0.0',
    npmRegistryEnabled:
      env.B70_RUNNER_NPM_ENABLED === undefined
        ? true
        : env.B70_RUNNER_NPM_ENABLED === 'true'
          ? true
          : env.B70_RUNNER_NPM_ENABLED === 'false'
            ? false
            : env.B70_RUNNER_NPM_ENABLED,
    runStorageBudgetBytes: Number(
      env.B70_RUNNER_RUN_STORAGE_BUDGET_BYTES ?? DEFAULT_RUN_STORAGE_BUDGET_BYTES
    ),
    revision: env.B70_RUNNER_REVISION,
    upstreamUrl: env.B70_RUNNER_UPSTREAM_URL ?? 'http://127.0.0.1:8081',
    gatewayUrl: env.B70_RUNNER_GATEWAY_URL ?? 'http://127.0.0.1:8090',
    gatewayToken: env.B70_RUNNER_GATEWAY_TOKEN,
    inferenceIdleTimeoutMs: Number(env.B70_RUNNER_INFERENCE_IDLE_TIMEOUT_MS ?? 30 * 60_000),
    provider: env.B70_RUNNER_PROVIDER ?? 'b70-vllm',
    model: env.B70_RUNNER_MODEL ?? 'Qwen3.8-27B',
    thinkingLevel: env.B70_RUNNER_THINKING_LEVEL ?? 'medium',
    profileId: env.B70_RUNNER_PROFILE_ID ?? 'coding-default-v1',
    maxActiveRuns: Number(env.B70_RUNNER_MAX_ACTIVE_RUNS ?? '2'),
    releaseSocket: env.B70_RUNNER_RELEASE_SOCKET ?? '/run/local-ai-b70-release-helper/control.sock',
  });
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new RunnerConfigError(`Invalid runner configuration: ${details}`);
  }
  if (result.data.desktopEnabled && result.data.agentEngine !== 'pi-durable')
    throw new RunnerConfigError('Invalid runner configuration: desktop tools require pi-durable');
  if (
    result.data.imageGenerationEnabled &&
    (result.data.agentEngine !== 'pi-durable' || !result.data.gatewayToken)
  )
    throw new RunnerConfigError('Image tools require pi-durable and an authenticated gateway.');
  return result.data;
}
