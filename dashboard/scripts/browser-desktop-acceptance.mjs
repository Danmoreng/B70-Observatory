/** Real browser tools and native desktop inside the existing bwrap resource scope. */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  launchWorkspaceUtility,
  stopSandboxedJob,
  DEFAULT_SANDBOX_LIMITS,
} from '../packages/runner/dist/index.js';
const output = resolve(process.argv[2] ?? 'build/browser-desktop-acceptance');
const root = mkdtempSync(join(tmpdir(), 'b70-visible-browser-'));
const workspace = join(root, 'workspace'),
  runtime = join(root, 'runtime');
mkdirSync(workspace);
mkdirSync(runtime);
const runId = randomBytes(16).toString('hex');
cpSync(resolve('build/observatory-release/runtime/desktop'), join(runtime, 'desktop'), {
  recursive: true,
});
cpSync(resolve('build/observatory-release/runtime/browsers'), join(runtime, 'browsers'), {
  recursive: true,
});
execFileSync(resolve('node_modules/.bin/esbuild'), [
  resolve('packages/runner/test/fixtures/browser-desktop/probe.ts'),
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node24',
  `--outfile=${runtime}/durable-env-entry.js`,
]);
try {
  const job = launchWorkspaceUtility({
    runId,
    workspacePath: workspace,
    runtimeRoot: runtime,
    runtimeExecutable: 'durable-env-entry.js',
    desktopEnabled: true,
    browserRuntimeRoot: '/opt/google/chrome',
    limits: { ...DEFAULT_SANDBOX_LIMITS, tasksMax: 512, runtimeSeconds: 180 },
  });
  job.child.stdin.end();
  job.child.stdout.pipe(process.stdout);
  job.child.stderr.pipe(process.stderr);
  const code = await new Promise((resolve, reject) => {
    job.child.once('error', reject);
    job.child.once('close', resolve);
  });
  mkdirSync(output, { recursive: true });
  cpSync(join(workspace, 'evidence'), output, { recursive: true });
  if (code !== 0) throw new Error('Visible browser acceptance failed');
  console.log(readFileSync(join(output, 'report.json'), 'utf8'));
} finally {
  await stopSandboxedJob(runId).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
