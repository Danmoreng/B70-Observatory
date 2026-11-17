// Operator acceptance only: generated/native code executes inside the normal job sandbox.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  launchWorkspaceUtility,
  stopSandboxedJob,
  DEFAULT_SANDBOX_LIMITS,
} from '../packages/runner/dist/index.js';

const dashboard = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[2] ?? join(dashboard, 'build/desktop-acceptance'));
const root = mkdtempSync(join(tmpdir(), 'b70-desktop-accept-'));
const runtimeRoot = join(root, 'runtime');
const workspacePath = join(root, 'workspace');
const runId = randomBytes(16).toString('hex');
mkdirSync(runtimeRoot);
mkdirSync(workspacePath);
const fixture = join(dashboard, 'packages/runner/test/fixtures/desktop');
for (const file of ['canvas.cpp', 'widgets.cpp'])
  cpSync(join(fixture, file), join(workspacePath, file));
cpSync(join(dashboard, 'build/observatory-release/runtime/desktop'), join(runtimeRoot, 'desktop'), {
  recursive: true,
  verbatimSymlinks: true,
});
execFileSync(join(dashboard, 'node_modules/.bin/esbuild'), [
  join(fixture, 'probe.ts'),
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node24',
  `--outfile=${runtimeRoot}/durable-env-entry.js`,
]);
try {
  const job = launchWorkspaceUtility({
    runId,
    workspacePath,
    runtimeRoot,
    runtimeExecutable: 'durable-env-entry.js',
    desktopEnabled: true,
    ...(process.env.B70_DESKTOP_TEST_BROWSER_ROOT
      ? { browserRuntimeRoot: process.env.B70_DESKTOP_TEST_BROWSER_ROOT }
      : {}),
    limits: { ...DEFAULT_SANDBOX_LIMITS, tasksMax: 256, runtimeSeconds: 300 },
  });
  job.child.stdin.end();
  job.child.stdout.pipe(process.stdout);
  job.child.stderr.pipe(process.stderr);
  const code = await new Promise((accept, reject) => {
    job.child.once('error', reject);
    job.child.once('close', accept);
  });
  mkdirSync(output, { recursive: true });
  cpSync(join(workspacePath, 'evidence'), output, { recursive: true });
  if (code !== 0) throw new Error('Desktop acceptance failed; see ' + output);
  console.log(readFileSync(join(output, 'report.json'), 'utf8'));
  console.log('Desktop evidence: ' + output);
} finally {
  await stopSandboxedJob(runId).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
