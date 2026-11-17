import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stageApprovedDesktop, stageApprovedBrowsers } from './desktop-artifact.js';

interface Command {
  label: string;
  argv: string[];
}

interface ReleaseConfig {
  revision: string;
  workdir: string;
  commands: Command[];
}

const HASH = /^[a-f0-9]{40}$/;
const SAFE_RELATIVE = /^(?!\x2f)(?!.*(?:^|\x2f)\.\.(?:\x2f|$))[A-Za-z0-9@._+\x2f-]+$/;
const MAX_LOG = 512 * 1024;

function finish(value: Record<string, unknown>, status = 0): never {
  process.stdout.write(JSON.stringify(value));
  process.exit(status);
}

function fail(message: string, log = ''): never {
  finish({ ok: false, error: message.slice(0, 512), log: log.slice(0, MAX_LOG) }, 1);
}

function decode(): ReleaseConfig {
  const encoded = process.argv[2];
  if (encoded === undefined || encoded.length > 16_384) fail('Invalid release configuration.');
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ReleaseConfig;
    if (!HASH.test(value.revision) || !SAFE_RELATIVE.test(value.workdir)) {
      fail('Invalid release source binding.');
    }
    if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 8) {
      fail('Invalid release command list.');
    }
    for (const command of value.commands) {
      if (
        typeof command.label !== 'string' ||
        command.label.length < 1 ||
        command.label.length > 160 ||
        !Array.isArray(command.argv) ||
        command.argv.length < 1 ||
        command.argv.length > 32 ||
        command.argv.some(
          (part) => typeof part !== 'string' || part.length < 1 || part.length > 1024
        )
      ) {
        fail('Invalid release command.');
      }
    }
    return value;
  } catch {
    fail('Invalid release configuration.');
  }
}

function run(argv: string[], cwd: string, timeout: number): { ok: boolean; log: string } {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_LOG * 2,
    env: {
      HOME: '/tmp',
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      CI: '1',
      B70_READONLY_DEPS: '1',
      B70_RELEASE_BUILD: '1',
      npm_config_cache: '/tmp/npm-cache',
    },
  });
  return {
    ok: result.status === 0,
    log: `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`.slice(0, MAX_LOG),
  };
}

function filesBelow(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
      else fail('Release output contains an unsupported file type.');
    }
  };
  visit(root);
  return files;
}

const config = decode();
const workspace = '/workspace';
const cwd = resolve(workspace, config.workdir);
if (cwd !== workspace && !cwd.startsWith(`${workspace}/`)) fail('Invalid release work directory.');
const head = run(['/usr/bin/git', 'rev-parse', 'HEAD'], workspace, 10_000);
if (!head.ok || head.log.trim() !== config.revision)
  fail('Release checkout does not match commit.');

try {
  stageApprovedBrowsers(
    '/runtime/browsers',
    join(cwd, 'build/browser-runtime'),
    join(cwd, 'ops/browsers/package.lock.json')
  );
  stageApprovedDesktop(
    '/runtime/desktop',
    join(cwd, 'build/desktop-runtime'),
    join(workspace, 'third_party/agent-workspace-linux'),
    join(cwd, 'ops/desktop/packages.lock.json')
  );
} catch (error) {
  fail(error instanceof Error ? error.message : 'Cannot stage the approved desktop runtime.');
}

let buildLog = '';
for (const command of config.commands) {
  const result = run(command.argv, cwd, 20 * 60_000);
  buildLog += `\n## ${command.label}\n${result.log}`;
  if (!result.ok) fail(`${command.label} failed; the active version was not changed.`, buildLog);
}

const artifact = join(workspace, '.b70-release');
rmSync(artifact, { recursive: true, force: true });
mkdirSync(join(artifact, 'web'), { recursive: true, mode: 0o755 });
mkdirSync(join(artifact, 'runtime'), { recursive: true, mode: 0o755 });

const esbuild = join(cwd, 'node_modules', '.bin', 'esbuild');
for (const [entry, output, format] of [
  ['packages/server/dist/index.js', 'server.cjs', 'cjs'],
  ['packages/server/dist/runner/main.js', 'runner.mjs', 'esm'],
] as const) {
  const bundled = run(
    [
      esbuild,
      join(cwd, entry),
      '--bundle',
      '--platform=node',
      `--format=${format}`,
      '--target=node24',
      '--packages=bundle',
      `--outfile=${join(artifact, output)}`,
    ],
    cwd,
    5 * 60_000
  );
  buildLog += `\n## Bundle ${output}\n${bundled.log}`;
  if (!bundled.ok) fail(`Bundling ${output} failed; the active version was not changed.`, buildLog);
  const syntax = run(['/usr/bin/node', '--check', join(artifact, output)], cwd, 60_000);
  buildLog += syntax.log;
  if (!syntax.ok) fail(`Syntax check for ${output} failed.`, buildLog);
}

cpSync(join(cwd, 'packages', 'web', 'dist'), join(artifact, 'web'), { recursive: true });
// The ordinary build prepares the complete immutable Durable runtime (worker,
// pi-env, tool clients, and optional desktop). Preserve it in cockpit releases.
const preparedRuntime = join(cwd, 'build/observatory-release/runtime');
cpSync(
  existsSync(join(preparedRuntime, 'pi-env')) ? preparedRuntime : join(cwd, 'packages/runner/dist'),
  join(artifact, 'runtime'),
  { recursive: true, dereference: true }
);

const fileDigests = filesBelow(artifact).map((path) => {
  const file = relative(artifact, path);
  return { file, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
});
const artifactDigest = createHash('sha256').update(JSON.stringify(fileDigests)).digest('hex');
writeFileSync(
  join(artifact, 'manifest.json'),
  `${JSON.stringify(
    {
      version: 1,
      target: 'observatory',
      revision: config.revision,
      compatibility: 1,
      artifactDigest,
      files: fileDigests,
    },
    null,
    2
  )}\n`,
  { encoding: 'utf8', mode: 0o644 }
);

finish({
  ok: true,
  artifactRelativePath: '.b70-release',
  artifactDigest,
  log: buildLog.slice(0, MAX_LOG),
});
