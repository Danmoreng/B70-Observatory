import { accessSync, constants, realpathSync, statSync, type PathLike } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WorkspaceSnapshot } from './workspace.js';

const BUBBLEWRAP = '/usr/bin/bwrap';
const SYSTEMD_RUN = '/usr/bin/systemd-run';
const SYSTEMCTL = '/usr/bin/systemctl';
const SAFE_RUN_ID = /^[a-f0-9]{8,64}$/;
const SAFE_EXECUTABLE = /^(?:[A-Za-z0-9@._+-]+\/)*[A-Za-z0-9@._+-]+$/;
const SAFE_TOKEN = /^[a-f0-9]{64}$/;
const SAFE_MOUNT_TARGET = /^(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/;

export interface SandboxLimits {
  memoryBytes: number;
  cpuQuotaPercent: number;
  tasksMax: number;
  runtimeSeconds: number;
  tmpBytes: number;
}

export const RUN_DEADLINE_POLICY = Object.freeze({
  firstWarningSeconds: 60 * 60,
  finalWarningSeconds: 65 * 60,
  hardCutoffSeconds: 70 * 60,
});

export const DEFAULT_SANDBOX_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  memoryBytes: 4 * 1024 * 1024 * 1024,
  cpuQuotaPercent: 200,
  tasksMax: 128,
  runtimeSeconds: RUN_DEADLINE_POLICY.hardCutoffSeconds,
  tmpBytes: 512 * 1024 * 1024,
});

export interface SandboxJobOptions {
  /** Lowercase hex identifier generated and owned by the trusted runner. */
  runId: string;
  /** Per-run writable copy. Never the source repository or deployment tree. */
  workspace: WorkspaceSnapshot;
  /** Review jobs see the exact workspace revision through a read-only mount. */
  workspaceWritable?: boolean;
  /** Trusted execution mode exposed only to the bundled cockpit extension. */
  runMode?: 'implementation' | 'review';
  npmEnabled?: boolean;
  /** Immutable runtime tree prepared outside the job. */
  runtimeRoot: string;
  /** Sanitized Pi/model profile without Observatory or operator credentials. */
  profileRoot: string;
  /** Allow writes only for a private per-run profile beside the workspace snapshot. */
  writableProfile?: boolean;
  /** Relative executable path below runtimeRoot; never supplied by the browser. */
  runtimeExecutable: string;
  /** Execute the trusted runtime file through the fixed system Node binary. */
  runtimeNodeEntrypoint?: boolean;
  /** Optional immutable Pi dependency tree, mounted separately from the trusted entrypoint. */
  agentRuntimeRoot?: string;
  /** Relative JavaScript entrypoint below agentRuntimeRoot. */
  agentExecutable?: string;
  /** Directory containing only the runner-owned inference relay socket. */
  inferenceSocketRoot?: string;
  /** Per-run bearer capability accepted only by the inference relay. */
  inferenceToken?: string;
  /** Existing lockfile-matched dependencies, mounted read-only below /workspace. */
  dependencyRoot?: string;
  /** Safe relative destination such as dashboard/node_modules. */
  dependencyTarget?: string;
  /** Protocol arguments assembled by trusted code. No shell is involved. */
  args?: readonly string[];
  limits?: SandboxLimits;
  /**
   * Optional operator-configured browser runtime root (e.g.
   * /opt/google/chrome), ro-bound to /browser with /etc/fonts. The fixed
   * executable is /browser/chrome; without this option the sandbox has no
   * browser and no browser tools.
   */
  browserRuntimeRoot?: string;
}

export interface SandboxedJob {
  child: ChildProcessWithoutNullStreams;
  unitName: string;
}

/** A short immutable helper operating on one explicitly selected repository. */
export interface WorkspaceUtilityOptions {
  runId: string;
  workspacePath: string;
  runtimeRoot: string;
  runtimeExecutable: string;
  /** Enforce read-only repository access for snapshot/inspection helpers. */
  readOnly?: boolean;
  /** Optional immutable second repository, exposed as /result. */
  sourcePath?: string;
  /** Fixed app runtime: read-only source, private socket and persistent data directories. */
  application?: { socketRoot: string; dataRoot: string };
  /** Fixed Durable environment worker can use the already approved browser runtime. */
  browserRuntimeRoot?: string;
  /** Fixed headless native-desktop runtime, already inside the immutable support tree. */
  desktopEnabled?: boolean;
  npm?: { socketRoot: string; token: string };
  dependencyRoot?: string;
  dependencyTarget?: string;
  args?: readonly string[];
  limits?: SandboxLimits;
}

interface ResolvedSandboxJobOptions extends Omit<
  SandboxJobOptions,
  'limits' | 'args' | 'workspace'
> {
  workspace: string;
  runtimeRoot: string;
  profileRoot: string;
  executable: string;
  agentRuntimeRoot?: string;
  agentExecutable?: string;
  inferenceSocketRoot?: string;
  browserRuntimeRoot?: string;
  dependencyRoot?: string;
  dependencyTarget?: string;
  args: readonly string[];
  limits: SandboxLimits;
}

export class SandboxConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxConfigurationError';
  }
}

function existingDirectory(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new SandboxConfigurationError(`${label} must be an absolute path`);
  }
  let canonical: string;
  try {
    canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new SandboxConfigurationError(`${label} must reference an existing directory`);
  }
  return canonical;
}

function isWithin(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
  );
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SandboxConfigurationError(`${label} is outside the supported range`);
  }
  return value;
}

function resolveOptions(options: SandboxJobOptions): ResolvedSandboxJobOptions {
  if (!SAFE_RUN_ID.test(options.runId)) {
    throw new SandboxConfigurationError('runId must be 8–64 lowercase hexadecimal characters');
  }
  if (!SAFE_EXECUTABLE.test(options.runtimeExecutable)) {
    throw new SandboxConfigurationError('runtimeExecutable must be a safe relative path');
  }
  if (
    options.workspace.runId !== options.runId ||
    !/^[a-f0-9]{40}$/.test(options.workspace.revision) ||
    options.workspace.branch !== `agent/${options.runId}`
  ) {
    throw new SandboxConfigurationError('workspace snapshot does not match the validated run');
  }
  const workspace = existingDirectory(options.workspace.path, 'workspace');
  const runtimeRoot = existingDirectory(options.runtimeRoot, 'runtimeRoot');
  const profileRoot = existingDirectory(options.profileRoot, 'profileRoot');
  if (options.writableProfile === true && dirname(profileRoot) !== dirname(workspace)) {
    throw new SandboxConfigurationError(
      'writable profile must belong to the same private run as the workspace'
    );
  }
  const optionalValues = [
    options.agentRuntimeRoot,
    options.agentExecutable,
    options.inferenceSocketRoot,
    options.inferenceToken,
  ];
  if (
    optionalValues.some((value) => value !== undefined) &&
    optionalValues.some((value) => value === undefined)
  ) {
    throw new SandboxConfigurationError(
      'agentRuntimeRoot, agentExecutable, inferenceSocketRoot and inferenceToken must be configured together'
    );
  }
  const agentRuntimeRoot =
    options.agentRuntimeRoot === undefined
      ? undefined
      : existingDirectory(options.agentRuntimeRoot, 'agentRuntimeRoot');
  const inferenceSocketRoot =
    options.inferenceSocketRoot === undefined
      ? undefined
      : existingDirectory(options.inferenceSocketRoot, 'inferenceSocketRoot');
  const browserRuntimeRoot =
    options.browserRuntimeRoot === undefined
      ? undefined
      : existingDirectory(options.browserRuntimeRoot, 'browserRuntimeRoot');
  if ((options.dependencyRoot === undefined) !== (options.dependencyTarget === undefined)) {
    throw new SandboxConfigurationError(
      'dependencyRoot and dependencyTarget must be configured together'
    );
  }
  const dependencyRoot =
    options.dependencyRoot === undefined
      ? undefined
      : existingDirectory(options.dependencyRoot, 'dependencyRoot');
  if (
    options.dependencyTarget !== undefined &&
    (!SAFE_MOUNT_TARGET.test(options.dependencyTarget) ||
      options.dependencyTarget.split('/').some((part) => part === '.' || part === '..'))
  ) {
    throw new SandboxConfigurationError('dependencyTarget must be a safe relative path');
  }
  const roots = [
    workspace,
    runtimeRoot,
    profileRoot,
    agentRuntimeRoot,
    inferenceSocketRoot,
    browserRuntimeRoot,
    dependencyRoot,
  ].filter((value): value is string => value !== undefined);
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const left = roots[leftIndex]!;
      const right = roots[rightIndex]!;
      if (isWithin(left, right) || isWithin(right, left)) {
        throw new SandboxConfigurationError('sandbox mount roots must be disjoint');
      }
    }
  }
  const executable = resolve(runtimeRoot, options.runtimeExecutable);
  let executableRealPath: string;
  try {
    executableRealPath = realpathSync(executable);
    accessSync(
      executableRealPath as PathLike,
      options.runtimeNodeEntrypoint === true ? constants.R_OK : constants.X_OK
    );
  } catch {
    throw new SandboxConfigurationError('runtimeExecutable must exist and be executable');
  }
  if (!isWithin(runtimeRoot, executableRealPath)) {
    throw new SandboxConfigurationError('runtimeExecutable must stay inside runtimeRoot');
  }
  let agentExecutable: string | undefined;
  if (agentRuntimeRoot !== undefined) {
    if (!SAFE_EXECUTABLE.test(options.agentExecutable!)) {
      throw new SandboxConfigurationError('agentExecutable must be a safe relative path');
    }
    try {
      agentExecutable = realpathSync(resolve(agentRuntimeRoot, options.agentExecutable!));
      accessSync(agentExecutable as PathLike, constants.R_OK);
    } catch {
      throw new SandboxConfigurationError('agentExecutable must exist and be readable');
    }
    if (!isWithin(agentRuntimeRoot, agentExecutable)) {
      throw new SandboxConfigurationError('agentExecutable must stay inside agentRuntimeRoot');
    }
    if (!SAFE_TOKEN.test(options.inferenceToken!)) {
      throw new SandboxConfigurationError(
        'inferenceToken must be 64 lowercase hexadecimal characters'
      );
    }
  }
  const args = options.args ?? [];
  if (args.length > 64 || args.some((value) => value.length > 4096 || value.includes('\0'))) {
    throw new SandboxConfigurationError('job arguments exceed the fixed protocol limits');
  }
  const requested = options.limits ?? DEFAULT_SANDBOX_LIMITS;
  // The PID controller counts every thread. Chrome, the main agent, two
  // sub-agents and Node/Rust build pools share this bounded allowance.
  const browserTasks = browserRuntimeRoot !== undefined;
  const limits: SandboxLimits = {
    memoryBytes: boundedInteger(
      requested.memoryBytes,
      128 * 1024 * 1024,
      32 * 1024 * 1024 * 1024,
      'memoryBytes'
    ),
    cpuQuotaPercent: boundedInteger(requested.cpuQuotaPercent, 10, 800, 'cpuQuotaPercent'),
    tasksMax: boundedInteger(
      browserTasks && requested.tasksMax === DEFAULT_SANDBOX_LIMITS.tasksMax
        ? 512
        : requested.tasksMax,
      8,
      512,
      'tasksMax'
    ),
    runtimeSeconds: boundedInteger(requested.runtimeSeconds, 1, 8 * 60 * 60, 'runtimeSeconds'),
    tmpBytes: boundedInteger(
      requested.tmpBytes,
      16 * 1024 * 1024,
      4 * 1024 * 1024 * 1024,
      'tmpBytes'
    ),
  };
  return {
    ...options,
    workspace,
    runtimeRoot,
    profileRoot,
    executable: executableRealPath,
    agentRuntimeRoot,
    agentExecutable,
    inferenceSocketRoot,
    browserRuntimeRoot,
    dependencyRoot,
    dependencyTarget: options.dependencyTarget,
    args,
    limits,
  };
}

export function buildBubblewrapArguments(options: SandboxJobOptions): string[] {
  const resolved = resolveOptions(options);
  const executableInSandbox = `/runtime/${relative(resolved.runtimeRoot, resolved.executable)}`;
  const command = resolved.runtimeNodeEntrypoint
    ? ['/usr/bin/node', executableInSandbox]
    : [executableInSandbox];
  const mounts: string[] = [];
  const environment: string[] = [];
  if (
    resolved.agentRuntimeRoot !== undefined &&
    resolved.agentExecutable !== undefined &&
    resolved.inferenceSocketRoot !== undefined
  ) {
    mounts.push(
      '--ro-bind',
      resolved.agentRuntimeRoot,
      '/agent-runtime',
      '--ro-bind',
      resolved.inferenceSocketRoot,
      '/inference'
    );
    environment.push(
      '--setenv',
      'B70_AGENT_EXECUTABLE',
      `/agent-runtime/${relative(resolved.agentRuntimeRoot, resolved.agentExecutable)}`,
      '--setenv',
      'B70_INFERENCE_TOKEN',
      resolved.inferenceToken!
    );
  }
  if (resolved.browserRuntimeRoot !== undefined) {
    // Operator opt-in only: the fixed browser root plus fontconfig stay
    // read-only; no host namespaces, sockets or paths beyond these two.
    mounts.push(
      '--ro-bind',
      resolved.browserRuntimeRoot,
      '/browser',
      '--ro-bind',
      '/etc/fonts',
      '/etc/fonts'
    );
    environment.push('--setenv', 'B70_BROWSER_ROOT', '/browser');
  }
  return [
    '--unshare-all',
    '--unshare-user',
    '--die-with-parent',
    '--new-session',
    '--disable-userns',
    '--uid',
    '65534',
    '--gid',
    '65534',
    '--hostname',
    'b70-job',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib',
    '/lib64',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--size',
    String(resolved.limits.tmpBytes),
    '--tmpfs',
    '/tmp',
    '--dir',
    '/home',
    '--dir',
    '/home/agent',
    resolved.workspaceWritable === false ? '--ro-bind' : '--bind',
    resolved.workspace,
    '/workspace',
    ...(resolved.dependencyRoot === undefined
      ? []
      : ['--ro-bind', resolved.dependencyRoot, `/workspace/${resolved.dependencyTarget!}`]),
    '--ro-bind',
    resolved.runtimeRoot,
    '/runtime',
    resolved.writableProfile === true ? '--bind' : '--ro-bind',
    resolved.profileRoot,
    '/profile',
    ...mounts,
    '--chdir',
    '/workspace',
    '--clearenv',
    '--setenv',
    'HOME',
    '/home/agent',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'LANG',
    'C.UTF-8',
    // Build/test tools otherwise size their worker pools from all host CPUs,
    // although the sandbox has only a two-CPU quota. Children inherit these.
    '--setenv',
    'VITEST_MAX_WORKERS',
    '2',
    '--setenv',
    'RAYON_NUM_THREADS',
    '2',
    '--setenv',
    'PI_OFFLINE',
    '1',
    '--setenv',
    'PI_CODING_AGENT_DIR',
    '/profile',
    '--setenv',
    'B70_RUN_MODE',
    resolved.runMode ?? 'implementation',
    ...environment,
    ...(resolved.npmEnabled === true ? ['--setenv', 'B70_NPM_ENABLED', '1'] : []),
    '--',
    ...command,
    ...resolved.args,
  ];
}

export function unitNameFor(runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new SandboxConfigurationError('runId must be 8–64 lowercase hexadecimal characters');
  }
  return `local-ai-b70-job-${runId}.scope`;
}

export function buildSystemdScopeArguments(options: SandboxJobOptions): string[] {
  const resolved = resolveOptions(options);
  const unitName = unitNameFor(resolved.runId);
  return [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    `--unit=${unitName.slice(0, -'.scope'.length)}`,
    `--property=MemoryMax=${resolved.limits.memoryBytes}`,
    '--property=MemorySwapMax=0',
    `--property=TasksMax=${resolved.limits.tasksMax}`,
    `--property=CPUQuota=${resolved.limits.cpuQuotaPercent}%`,
    `--property=RuntimeMaxSec=${resolved.limits.runtimeSeconds}s`,
    '--property=OOMPolicy=kill',
    '--property=KillMode=control-group',
    BUBBLEWRAP,
    ...buildBubblewrapArguments(options),
  ];
}

/** Launch a job in a transient, non-restarting systemd scope and bwrap sandbox. */
export function launchSandboxedJob(options: SandboxJobOptions): SandboxedJob {
  const unitName = unitNameFor(options.runId);
  const child = spawn(SYSTEMD_RUN, buildSystemdScopeArguments(options), {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { child, unitName };
}

export function buildWorkspaceUtilityArguments(options: WorkspaceUtilityOptions): string[] {
  if (!SAFE_RUN_ID.test(options.runId)) {
    throw new SandboxConfigurationError('runId must be 8–64 lowercase hexadecimal characters');
  }
  if (!SAFE_EXECUTABLE.test(options.runtimeExecutable)) {
    throw new SandboxConfigurationError('runtimeExecutable must be a safe relative path');
  }
  const workspace = existingDirectory(options.workspacePath, 'workspacePath');
  const runtimeRoot = existingDirectory(options.runtimeRoot, 'runtimeRoot');
  const sourcePath =
    options.sourcePath === undefined
      ? undefined
      : existingDirectory(options.sourcePath, 'sourcePath');
  const dependencyRoot =
    options.dependencyRoot === undefined
      ? undefined
      : existingDirectory(options.dependencyRoot, 'dependencyRoot');
  if ((dependencyRoot === undefined) !== (options.dependencyTarget === undefined)) {
    throw new SandboxConfigurationError('utility dependency mount is incomplete');
  }
  if (
    options.dependencyTarget !== undefined &&
    (!SAFE_MOUNT_TARGET.test(options.dependencyTarget) ||
      options.dependencyTarget.split('/').some((part) => part === '.' || part === '..'))
  ) {
    throw new SandboxConfigurationError('dependencyTarget must be a safe relative path');
  }
  if (isWithin(workspace, runtimeRoot) || isWithin(runtimeRoot, workspace)) {
    throw new SandboxConfigurationError('utility mount roots must be disjoint');
  }
  if (
    sourcePath !== undefined &&
    [workspace, runtimeRoot].some(
      (root) => isWithin(root, sourcePath) || isWithin(sourcePath, root)
    )
  ) {
    throw new SandboxConfigurationError('utility mount roots must be disjoint');
  }
  let applicationMounts: string[] = [];
  if (options.application !== undefined) {
    if (
      options.runtimeExecutable !== 'app-entry.js' ||
      sourcePath !== undefined ||
      dependencyRoot !== undefined
    ) {
      throw new SandboxConfigurationError('application requires the fixed app runtime');
    }
    const socketRoot = existingDirectory(options.application.socketRoot, 'app socket');
    const dataRoot = existingDirectory(options.application.dataRoot, 'app data');
    const roots = [workspace, runtimeRoot, socketRoot, dataRoot];
    for (let i = 0; i < roots.length; i++)
      for (let j = i + 1; j < roots.length; j++) {
        if (isWithin(roots[i]!, roots[j]!) || isWithin(roots[j]!, roots[i]!)) {
          throw new SandboxConfigurationError('application mounts must be disjoint');
        }
      }
    applicationMounts = ['--ro-bind', socketRoot, '/app-socket', '--bind', dataRoot, '/app-data'];
  }
  let npmMounts: string[] = [];
  let npmEnvironment: string[] = [];
  if (options.npm !== undefined) {
    if (
      !['npm-prepare.js', 'durable-env-entry.js'].includes(options.runtimeExecutable) ||
      options.application !== undefined ||
      sourcePath !== undefined ||
      (dependencyRoot !== undefined && options.runtimeExecutable !== 'durable-env-entry.js') ||
      !SAFE_TOKEN.test(options.npm.token)
    )
      throw new SandboxConfigurationError('invalid npm utility capability');
    const socketRoot = existingDirectory(options.npm.socketRoot, 'npm socket root');
    if (
      [workspace, runtimeRoot].some(
        (root) => isWithin(root, socketRoot) || isWithin(socketRoot, root)
      )
    )
      throw new SandboxConfigurationError('npm mounts must be disjoint');
    npmMounts = ['--ro-bind', socketRoot, '/inference'];
    npmEnvironment = ['--setenv', 'B70_NPM_TOKEN', options.npm.token];
  }
  const browserMounts: string[] = [];
  if (options.desktopEnabled === true) {
    if (options.runtimeExecutable !== 'durable-env-entry.js')
      throw new SandboxConfigurationError('desktop requires fixed Durable worker');
    const desktopExecutable = realpathSync(joinDesktopExecutable(runtimeRoot));
    if (!isWithin(runtimeRoot, desktopExecutable))
      throw new SandboxConfigurationError('desktop executable must stay inside runtimeRoot');
    accessSync(desktopExecutable, constants.X_OK);
    for (const name of ['passwd', 'group', 'nsswitch.conf']) {
      const file = realpathSync(resolve(runtimeRoot, 'desktop/etc', name));
      if (!isWithin(runtimeRoot, file))
        throw new SandboxConfigurationError('desktop identity files must stay inside runtimeRoot');
      browserMounts.push('--ro-bind', file, `/etc/${name}`);
    }
  }
  if (options.browserRuntimeRoot !== undefined) {
    if (options.runtimeExecutable !== 'durable-env-entry.js')
      throw new SandboxConfigurationError('browser mount requires fixed Durable worker');
    const browserRoot = existingDirectory(options.browserRuntimeRoot, 'browser runtime');
    if (
      [workspace, runtimeRoot].some(
        (root) => isWithin(root, browserRoot) || isWithin(browserRoot, root)
      )
    )
      throw new SandboxConfigurationError('browser runtime must be disjoint');
    browserMounts.push(
      '--ro-bind',
      browserRoot,
      '/browser',
      '--ro-bind',
      '/etc/fonts',
      '/etc/fonts'
    );
  }
  if (options.desktopEnabled === true && options.browserRuntimeRoot === undefined)
    browserMounts.push('--ro-bind', '/etc/fonts', '/etc/fonts');
  const executable = realpathSync(resolve(runtimeRoot, options.runtimeExecutable));
  if (!isWithin(runtimeRoot, executable)) {
    throw new SandboxConfigurationError('runtimeExecutable must stay inside runtimeRoot');
  }
  accessSync(executable as PathLike, constants.R_OK);
  const args = options.args ?? [];
  if (args.length > 64 || args.some((value) => value.length > 16_384 || value.includes('\0'))) {
    throw new SandboxConfigurationError('utility arguments exceed the fixed protocol limits');
  }
  const requested = options.limits ?? {
    ...DEFAULT_SANDBOX_LIMITS,
    runtimeSeconds: 15 * 60,
    memoryBytes: 2 * 1024 * 1024 * 1024,
  };
  const limits: SandboxLimits = {
    memoryBytes: boundedInteger(
      requested.memoryBytes,
      128 * 1024 * 1024,
      32 * 1024 * 1024 * 1024,
      'memoryBytes'
    ),
    cpuQuotaPercent: boundedInteger(requested.cpuQuotaPercent, 10, 800, 'cpuQuotaPercent'),
    tasksMax: boundedInteger(requested.tasksMax, 8, 512, 'tasksMax'),
    runtimeSeconds: boundedInteger(requested.runtimeSeconds, 1, 8 * 60 * 60, 'runtimeSeconds'),
    tmpBytes: boundedInteger(
      requested.tmpBytes,
      16 * 1024 * 1024,
      4 * 1024 * 1024 * 1024,
      'tmpBytes'
    ),
  };
  const executableInSandbox = `/runtime/${relative(runtimeRoot, executable)}`;
  return [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    `--unit=${unitNameFor(options.runId).slice(0, -'.scope'.length)}`,
    `--property=MemoryMax=${limits.memoryBytes}`,
    '--property=MemorySwapMax=0',
    `--property=TasksMax=${limits.tasksMax}`,
    `--property=CPUQuota=${limits.cpuQuotaPercent}%`,
    options.application === undefined
      ? `--property=RuntimeMaxSec=${limits.runtimeSeconds}s`
      : '--property=RuntimeMaxSec=infinity',
    '--property=OOMPolicy=kill',
    '--property=KillMode=control-group',
    BUBBLEWRAP,
    '--unshare-all',
    '--unshare-user',
    '--die-with-parent',
    '--new-session',
    '--disable-userns',
    '--uid',
    '65534',
    '--gid',
    '65534',
    '--hostname',
    'b70-job',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib',
    '/lib64',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--size',
    String(limits.tmpBytes),
    '--tmpfs',
    '/tmp',
    options.application === undefined && options.readOnly !== true ? '--bind' : '--ro-bind',
    workspace,
    '/workspace',
    ...applicationMounts,
    ...npmMounts,
    ...browserMounts,
    ...(sourcePath === undefined ? [] : ['--ro-bind', sourcePath, '/result']),
    ...(dependencyRoot === undefined
      ? []
      : ['--ro-bind', dependencyRoot, `/workspace/${options.dependencyTarget!}`]),
    '--ro-bind',
    runtimeRoot,
    '/runtime',
    '--chdir',
    '/workspace',
    '--clearenv',
    '--setenv',
    'HOME',
    '/tmp',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'LANG',
    'C.UTF-8',
    ...npmEnvironment,
    ...(options.browserRuntimeRoot === undefined
      ? []
      : ['--setenv', 'B70_BROWSER_ROOT', '/browser']),
    ...(options.desktopEnabled === true
      ? ['--setenv', 'B70_DESKTOP_ROOT', '/runtime/desktop']
      : []),
    '--',
    '/usr/bin/node',
    executableInSandbox,
    ...args,
  ];
}

function joinDesktopExecutable(runtimeRoot: string): string {
  return resolve(runtimeRoot, 'desktop/bin/agent-workspace-linux');
}

/** Run trusted fixed logic against repository content without host/network access. */
export function launchWorkspaceUtility(options: WorkspaceUtilityOptions): SandboxedJob {
  const unitName = unitNameFor(options.runId);
  const child = spawn(SYSTEMD_RUN, buildWorkspaceUtilityArguments(options), {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { child, unitName };
}

/** Stop exactly one validated job scope. No arbitrary unit name is accepted. */
export async function stopSandboxedJob(
  runId: string,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'
): Promise<void> {
  const unitName = unitNameFor(runId);
  await new Promise<void>((resolvePromise, reject) => {
    execFile(
      SYSTEMCTL,
      ['--user', 'kill', '--kill-whom=all', `--signal=${signal}`, unitName],
      { timeout: 10_000 },
      (error) => (error === null ? resolvePromise() : reject(error))
    );
  });
}
