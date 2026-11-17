import { copyMemoryRuntime } from './memory/runtime.js';
import { execFileSync, spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { copyDesktopRuntime, verifyDesktopRuntime } from './desktop/runtime.js';
import { desktopSourceDigest } from '@observatory/runner';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = join(projectDir, 'build', 'observatory-release');

function filesBelow(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
      else throw new Error(`unsupported release output: ${relative(root, path)}`);
    }
  };
  visit(root);
  return files;
}

function bundle(entry: string, target: string, format: 'cjs' | 'esm'): void {
  const esbuild = join(projectDir, 'node_modules', '.bin', 'esbuild');
  const result = spawnSync(
    esbuild,
    [
      join(projectDir, entry),
      '--bundle',
      '--platform=node',
      `--format=${format}`,
      ...(format === 'esm'
        ? [
            "--banner:js=import { createRequire as __b70CreateRequire } from 'node:module'; const require = __b70CreateRequire(import.meta.url);",
          ]
        : []),
      '--target=node24',
      '--packages=bundle',
      '--external:sharp',
      `--outfile=${join(output, target)}`,
    ],
    { cwd: projectDir, stdio: 'inherit' }
  );
  if (result.status !== 0) throw new Error(`could not bundle ${target}`);
  execFileSync(process.execPath, ['--check', join(output, target)], { stdio: 'inherit' });
}

const revision = execFileSync(
  '/usr/bin/git',
  ['-C', resolve(projectDir, '..'), 'rev-parse', 'HEAD'],
  {
    encoding: 'utf8',
  }
).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('could not resolve repository HEAD');

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'web'), { recursive: true, mode: 0o755 });
mkdirSync(join(output, 'runtime'), { recursive: true, mode: 0o755 });
// One shared native image runtime for the runner and the embedded Studio.
// Native Sharp binaries must remain external to JavaScript bundles.
for (const dependency of ['sharp', 'ws', 'semver', 'detect-libc', '@img'])
  cpSync(join(projectDir, 'node_modules', dependency), join(output, 'node_modules', dependency), {
    recursive: true,
  });
bundle('packages/server/dist/index.js', 'server.cjs', 'cjs');
bundle('packages/server/dist/runner/main.js', 'runner.mjs', 'esm');
// Syntax checks alone miss CJS built-in requires inside ESM dependencies. Load
// the actual runner with an empty environment: it must reach config validation
// before any service, socket, workspace or model request can be started.
const runnerSmoke = spawnSync(process.execPath, [join(output, 'runner.mjs')], {
  env: {},
  encoding: 'utf8',
  timeout: 5_000,
});
if (runnerSmoke.status !== 1 || !runnerSmoke.stderr?.includes('Invalid runner configuration:'))
  throw new Error(`Runner bundle failed its load check: ${runnerSmoke.stderr?.slice(0, 2048)}`);

cpSync(join(projectDir, 'packages', 'web', 'dist'), join(output, 'web'), { recursive: true });
// Retain the existing Diffusion Desk Node implementation and native Sharp runtime.
const studio = join(output, 'runtime/studio');
cpSync(join(projectDir, 'vendor/diffusion-desk'), studio, { recursive: true });

cpSync(join(projectDir, 'packages', 'runner', 'dist'), join(output, 'runtime'), {
  recursive: true,
});

bundle('packages/runner/dist/durable-env-entry.js', 'runtime/durable-env-entry.js', 'esm');
bundle(
  'packages/runner/dist/durable-browser-client.js',
  'runtime/durable-browser-client.js',
  'esm'
);
cpSync(
  join(projectDir, 'node_modules/@earendil-works/pi-env/bin/pi-env-linux-x64/pi-env'),
  join(output, 'runtime/pi-env')
);

cpSync(join(projectDir, 'ops/licenses/pi-MIT.txt'), join(output, 'runtime/pi-LICENSE.txt'));

// Desktop is an explicitly prepared, source-built operator artifact; never downloaded at run time.
const memory = join(projectDir, 'build/memory-runtime');
if (existsSync(memory)) copyMemoryRuntime(projectDir, memory, join(output, 'runtime/memory'));

const desktop = join(projectDir, 'build/desktop-runtime');
if (existsSync(desktop)) {
  verifyDesktopRuntime(desktop, {
    sourceDigest: desktopSourceDigest(resolve(projectDir, '../third_party/agent-workspace-linux')),
    packageLockSha256: createHash('sha256')
      .update(readFileSync(join(projectDir, 'ops/desktop/packages.lock.json')))
      .digest('hex'),
  });
  copyDesktopRuntime(desktop, join(output, 'runtime/desktop'));
}

const browsers = join(projectDir, 'build/browser-runtime');
if (existsSync(browsers)) {
  const manifest = JSON.parse(readFileSync(join(browsers, 'manifest.json'), 'utf8')) as {
    packageLockSha256: string;
  };
  if (
    manifest.packageLockSha256 !==
    createHash('sha256')
      .update(readFileSync(join(projectDir, 'ops/browsers/package.lock.json')))
      .digest('hex')
  )
    throw new Error('Browser package pins changed; prepare a fresh reviewed browser runtime.');
  copyDesktopRuntime(browsers, join(output, 'runtime/browsers'));
}

const files = filesBelow(output).map((path) => ({
  file: relative(output, path),
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
}));
const artifactDigest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
writeFileSync(
  join(output, 'manifest.json'),
  `${JSON.stringify(
    { version: 1, target: 'observatory', revision, compatibility: 1, artifactDigest, files },
    null,
    2
  )}\n`,
  { mode: 0o644 }
);
process.stdout.write(`Prepared bootstrap release ${revision.slice(0, 12)} (${artifactDigest})\n`);
