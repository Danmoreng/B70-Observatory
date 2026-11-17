/** Current workbench -> real local model -> sandbox -> persisted result. No production writes. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { buildApp } from '../packages/server/dist/app.js';
import { loadServerConfig } from '../packages/server/dist/config.js';
import { createRunner } from '../packages/server/dist/runner/service.js';
import { loadRunnerConfig } from '../packages/server/dist/runner/config.js';
import { RunnerAgentClient } from '../packages/server/dist/agent/runner-client.js';
import { openBrowser, until } from './lib/browser-cdp.mjs';

const engine = process.env.B70_SMOKE_ENGINE ?? 'pi-durable';
assert.ok(['pi-durable', 'pi-rpc'].includes(engine));
const root = mkdtempSync(join(tmpdir(), 'b70-cockpit-runtime-'));
const repository = join(root, 'repository');
const output = resolve('target/cockpit-runtime', engine);
for (const directory of [repository, output, join(root, 'state/runs'), join(root, 'deps')])
  mkdirSync(directory, { recursive: true });
const git = (...args) =>
  execFileSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Runtime qualification');
git('config', 'user.email', 'runtime@local.invalid');
mkdirSync(join(repository, 'dashboard'));
writeFileSync(join(repository, 'README.md'), 'Qualification word: Prisma58\n');
writeFileSync(join(repository, 'dashboard/README.md'), 'Disposable runtime fixture.\n');
git('add', '.');
git('commit', '-qm', 'Runtime fixture');
const config = loadRunnerConfig({
  B70_RUNNER_ENGINE: engine,
  B70_RUNNER_CONTROL_TOKEN: randomBytes(32).toString('hex'),
  B70_RUNNER_CONTROL_SOCKET: join(root, 'control.sock'),
  B70_RUNNER_INFERENCE_SOCKET_ROOT: join(root, 'inference'),
  B70_RUNNER_DATABASE_PATH: join(root, 'state/tasks.sqlite'),
  B70_RUNNER_REPOSITORY: repository,
  B70_RUNNER_PROJECT_ROOTS: root,
  B70_RUNNER_STATE_ROOT: join(root, 'state/runs'),
  B70_RUNNER_SUPPORT_ROOT: resolve('build/observatory-release/runtime'),
  B70_RUNNER_AGENT_RUNTIME_ROOT: resolve('../pi/node_modules'),
  B70_RUNNER_PROFILE_ROOT: resolve('../pi/runner-profile'),
  B70_RUNNER_DEPENDENCY_ROOT: join(root, 'deps'),
  B70_RUNNER_REVISION: git('rev-parse', 'HEAD'),
  B70_RUNNER_UPSTREAM_URL: 'http://127.0.0.1:8081',
  B70_RUNNER_GATEWAY_URL: process.env.B70_RUNNER_GATEWAY_URL ?? 'http://127.0.0.1:8090',
  B70_RUNNER_GATEWAY_TOKEN: process.env.B70_RUNNER_GATEWAY_TOKEN,
  B70_RUNNER_THINKING_LEVEL: 'low',
  B70_RUNNER_NPM_ENABLED: 'false',
  B70_RUNNER_RELEASE_SOCKET: join(root, 'no-release.sock'),
});
let runner, client, app, browser;
try {
  runner = await createRunner(config);
  await runner.relay.start();
  await runner.control.start();
  client = new RunnerAgentClient(config.controlSocket, config.controlToken);
  const project = await runner.service.registerProject({
    name: 'Pi 1.5 runtime qualification',
    repositoryPath: repository,
    targetBranch: 'main',
    workdir: '.',
    editPaths: ['.'],
    checks: [],
  });
  app = buildApp({
    config: loadServerConfig(),
    version: 'pi15-runtime-qualification',
    loggerLevel: 'silent',
    webRoot: resolve('packages/web/dist'),
    agent: client,
    auth: { mode: 'development', sessions: {}, sessionDays: 1, cookieSecure: false },
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await openBrowser();
  await browser.send('Page.enable');
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "localStorage.setItem('observatory.locale','de');",
  });
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 820,
    height: 1180,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.send('Page.navigate', { url: url + '/#/agent' });
  await until(
    () =>
      browser.evaluate("!!document.querySelector('.task-overview-actions button:not(:disabled)')"),
    'Current workbench did not become ready'
  );
  await browser.evaluate("document.querySelector('.task-overview-actions button').click()");
  await until(
    () => browser.evaluate("!!document.querySelector('#agent-task')"),
    'Task dialog missing'
  );
  const task =
    'Lies README.md. Schreibe das dort genannte Qualifikationswort exakt in proof.txt. Ändere sonst nichts, stelle keine Rückfrage und antworte danach kurz auf Deutsch.';
  await browser.evaluate(`(() => {
    const project = document.querySelector('#agent-project');
    project.value = ${JSON.stringify(project.id)};
    project.dispatchEvent(new Event('change', { bubbles: true }));
    const input = document.querySelector('#agent-task');
    input.value = ${JSON.stringify(task)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await browser.evaluate("document.querySelector('form.agent-form').requestSubmit()");
  let detail;
  await until(
    async () => {
      const task = (await client.listTasks()).items[0];
      if (!task) return false;
      detail = await client.getTask(task.id);
      assert.notEqual(task.latestRun.status, 'failed', detail.latestSnapshot?.reason);
      return task.latestRun.status === 'completed';
    },
    'Local runtime did not finish',
    180_000
  );
  assert.equal(
    detail.task.latestRun.profileId,
    engine === 'pi-durable' ? 'durable-v1' : config.profileId
  );
  assert.deepEqual(detail.latestResult.files, ['proof.txt']);
  assert.match(detail.latestResult.diff, /Prisma58/);
  const telemetry = await client.getTaskTelemetry(detail.task.id);
  assert.ok(telemetry.totals.completedRequests > 0);
  assert.ok(telemetry.totals.usage.inputTokens > 0);
  assert.ok(telemetry.totals.usage.outputTokens > 0);
  assert.ok(telemetry.totals.prefill?.samples > 0, 'Server prefill timing missing');
  assert.ok(telemetry.totals.decode?.samples > 0, 'Server decode timing missing');
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.agent-timeline')?.innerText.includes('proof.txt')"
      ),
    'Committed tool trace missing from workbench'
  );
  await until(
    () => browser.evaluate("!!document.querySelector('.task-context.completed')"),
    'Completed task status missing from workbench'
  );
  await until(
    () =>
      browser.evaluate(
        "!!document.querySelector('.task-metrics-values') && !document.querySelector('.task-metrics-values').innerText.includes('–')"
      ),
    'Measured performance did not reach the current workbench'
  );
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth > innerWidth'), false);
  await browser.capture(join(output, 'completed.png'));
  await browser.send('Page.reload');
  await until(
    () =>
      browser.evaluate("document.querySelector('.agent-timeline')?.innerText.includes('Prisma58')"),
    'Saved trace did not survive browser reload'
  );
  const metricsDb = new DatabaseSync(config.databasePath, { readOnly: true });
  const requestIds = metricsDb
    .prepare('SELECT request_id FROM agent_inference_telemetry WHERE run_id=?')
    .all(detail.task.latestRun.id)
    .map((row) => row.request_id);
  metricsDb.close();
  const result = {
    passed: true,
    engine,
    root,
    taskId: detail.task.id,
    tablet: true,
    reload: true,
    telemetry,
    requestIds,
  };
  writeFileSync(join(output, 'qualification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await app?.close();
  await client?.close();
  await runner?.control.close();
  await runner?.service.close();
  await runner?.relay.close();
}
