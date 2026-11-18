/** Real built UI + real durable queue admission/cancellation. No model or sandbox work. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { buildApp } from '../packages/server/dist/app.js';
import { loadServerConfig } from '../packages/server/dist/config.js';
import { loadRunnerConfig } from '../packages/server/dist/runner/config.js';
import { IsolatedAgentService } from '../packages/server/dist/runner/service.js';
import { AgentTaskStore } from '../packages/server/dist/runner/task-store.js';
import { openBrowser, until } from './lib/browser-cdp.mjs';

const output = resolve(process.argv[2] ?? 'build/task-queue-acceptance');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'b70-queue-browser-'));
const repository = join(root, 'repository');
const stateRoot = join(root, 'runs');
mkdirSync(repository);
mkdirSync(stateRoot);
execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', repository]);
writeFileSync(join(repository, 'README.md'), 'Disposable queue fixture\n');
execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
execFileSync('/usr/bin/git', [
  '-C',
  repository,
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@invalid',
  '-c',
  'commit.gpgSign=false',
  'commit',
  '-qm',
  'fixture',
]);
let modelRequests = 0;
const engine = createServer((request, response) => {
  if (request.method === 'POST' && request.url?.startsWith('/v1/')) modelRequests++;
  response.writeHead(503);
  response.end('Disposable offline engine');
});
let app, browser;
const checks = [];
try {
  await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve));
  const engineUrl = 'http://127.0.0.1:' + engine.address().port;
  const config = loadRunnerConfig({
    B70_RUNNER_CONTROL_TOKEN: 'a'.repeat(64),
    B70_RUNNER_REPOSITORY: repository,
    B70_RUNNER_STATE_ROOT: stateRoot,
    B70_RUNNER_SUPPORT_ROOT: root,
    B70_RUNNER_AGENT_RUNTIME_ROOT: root,
    B70_RUNNER_PROFILE_ROOT: root,
    B70_RUNNER_DEPENDENCY_ROOT: root,
    B70_RUNNER_REVISION: 'a'.repeat(40),
    B70_RUNNER_MAX_ACTIVE_RUNS: '2',
    B70_RUNNER_ENGINE: 'pi-durable',
    B70_RUNNER_UPSTREAM_URL: engineUrl,
    B70_RUNNER_GATEWAY_URL: engineUrl,
  });
  const store = new AgentTaskStore(join(root, 'tasks.sqlite'));
  const project = store.registerProject({
    name: 'Queue browser fixture',
    repositoryPath: repository,
    targetBranch: 'main',
    workdir: '.',
    editPaths: ['.'],
    checks: [],
  });
  for (let i = 1; i <= 2; i++) {
    const accepted = store.acceptRun(
      { task: 'Active fixture ' + i },
      {
        projectId: project.id,
        profileId: 'fixture',
        baseRevision: 'a'.repeat(40),
        maxActiveRuns: 2,
      }
    );
    store.markStarting(accepted, 'fixture');
    store.updateRunStatus(accepted.runId, 'running', undefined, new Date(), 'fixture');
  }
  const relay = { register() {}, revoke() {}, async start() {}, async close() {} };
  const service = new IsolatedAgentService(config, relay, store);
  app = buildApp({
    config: loadServerConfig({ OBSERVATORY_UPSTREAM_URL: engineUrl }),
    version: 'queue-acceptance',
    loggerLevel: 'silent',
    webRoot: resolve('packages/web/dist'),
    agent: service,
    auth: { mode: 'development', sessions: {}, sessionDays: 1, cookieSecure: false },
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await openBrowser();
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  for (const locale of ['de', 'en']) {
    const snapshot = await service.start({
      projectId: project.id,
      name: 'Waiting browser task ' + locale,
      task: 'Verify this queued task without starting any model.',
      images: [
        {
          mimeType: 'image/png',
          label: 'Saved reference',
          data: readFileSync('packages/runner/test/fixtures/desktop/blank.png').toString('base64'),
        },
      ],
    });
    const queued = store.queuedRun(snapshot.runId);
    assert.equal(snapshot.status, 'queued');
    assert.equal(snapshot.activeRuns, 2);
    for (const width of [1280, 834]) {
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.send('Page.navigate', { url: url + '/#/agent/' + queued.accepted.taskId });
      await until(
        () => browser.evaluate("document.querySelector('.cockpit') !== null"),
        'Cockpit missing'
      );
      await browser.evaluate(
        `localStorage.setItem('observatory.locale', ${JSON.stringify(locale)})`
      );
      await browser.send('Page.reload');
      const label = locale === 'de' ? 'Wartenden Task abbrechen' : 'Cancel waiting task';
      await until(
        () => browser.evaluate(`document.body.innerText.includes(${JSON.stringify(label)})`),
        'Queued cancellation missing'
      );
      assert.equal(await browser.evaluate("document.querySelector('.task-input') !== null"), false);
      assert.equal(
        await browser.evaluate(
          "document.querySelector('.timeline-item strong').textContent.trim()"
        ),
        locale === 'de' ? 'Aufgabe' : 'Task'
      );
      await until(
        () =>
          browser.evaluate(
            "Array.from(document.querySelectorAll('.agent-timeline img')).some(image => image.complete && image.naturalWidth > 0)"
          ),
        'Queued reference image did not load inline'
      );
      assert.equal(
        await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'),
        true
      );
      await until(
        () => browser.evaluate(`document.querySelector('.workbench-task-title')?.textContent.trim() === ${JSON.stringify('Waiting browser task ' + locale)}`),
        'Current queued task missing from the breadcrumb'
      );
      await browser.capture(join(output, `queue-${locale}-${width}.png`));
      await browser.send('Page.navigate', { url: url + '/#/overview' });
      await until(
        () => browser.evaluate("document.querySelectorAll('.system-home .kpi').length === 4"),
        'System overview missing'
      );
      assert.equal(
        await browser.evaluate(
          "document.querySelector('.system-home .task-table-row, .system-home .shared-project-card') !== null"
        ),
        false
      );
      const taskShortcut = '.recent-work a[href="#/agent/' + queued.accepted.taskId + '"]';
      const projectShortcut = '.recent-work a[href="#/projects/' + project.id + '"]';
      await until(
        () =>
          browser.evaluate(
            `Boolean(document.querySelector(${JSON.stringify(taskShortcut)}) && document.querySelector(${JSON.stringify(projectShortcut)}))`
          ),
        'Recent task and project shortcuts missing'
      );
      await browser.capture(join(output, `home-${locale}-${width}.png`));
      await browser.evaluate(`document.querySelector(${JSON.stringify(taskShortcut)}).click()`);
      await until(
        () =>
          browser.evaluate(
            `location.hash === ${JSON.stringify('#/agent/' + queued.accepted.taskId)}`
          ),
        'Task row did not navigate to the queued task'
      );
      await browser.send('Page.navigate', { url: url + '/#/projects' });
      await until(
        () => browser.evaluate("document.querySelector('.project-card-link') !== null"),
        'Project list missing'
      );
      assert.equal(
        await browser.evaluate("document.querySelector('.workbench-preview') !== null"),
        false
      );
      await browser.evaluate("document.querySelector('.project-card-pin').click()");
      await until(
        () =>
          browser.evaluate(
            "document.querySelector('.project-card-pin').getAttribute('aria-pressed') === 'true'"
          ),
        'Pin did not toggle independently'
      );
      assert.equal(await browser.evaluate('location.hash'), '#/projects');
      await browser.evaluate("document.querySelector('.project-card-pin').click()");
      await browser.capture(join(output, `projects-${locale}-${width}.png`));
      await browser.evaluate("document.querySelector('.project-card-link').click()");
      await until(
        () =>
          browser.evaluate(
            `location.hash === ${JSON.stringify('#/projects/')} + ${JSON.stringify(project.id)}`
          ),
        'Project row did not navigate directly'
      );
      await until(
        () => browser.evaluate("document.querySelectorAll('.task-table-row').length >= 3"),
        'Project task list missing'
      );
      assert.equal(
        await browser.evaluate("document.querySelector('.workbench-task-context') !== null"),
        false
      );
      await browser.capture(join(output, `project-${locale}-${width}.png`));
      await browser.evaluate(
        `Array.from(document.querySelectorAll('.task-table-row')).find(row => row.textContent.includes(${JSON.stringify('Waiting browser task ')} + ${JSON.stringify(locale)})).click()`
      );
      await until(
        () => browser.evaluate(`document.body.innerText.includes(${JSON.stringify(label)})`),
        'Project task row did not navigate directly'
      );
      checks.push(
        `direct home/project/task navigation and independent pins at ${locale}/${width}px`
      );
      checks.push(
        `queued status and cancellation at ${locale}/${width}px, no live composer or horizontal overflow`
      );
    }
    const label = locale === 'de' ? 'Wartenden Task abbrechen' : 'Cancel waiting task';
    await browser.evaluate(
      `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`
    );
    await until(
      () => store.getTask(queued.accepted.taskId).task.latestRun.status === 'cancelled',
      'Cancellation did not reach durable storage'
    );
    checks.push(`${locale}: browser cancellation persisted without a manager`);
    await browser.send('Page.navigate', { url: url + '/#/agent' });
    await until(
      () => browser.evaluate("document.querySelector('.task-overview-actions button') !== null"),
      'Task list missing'
    );
    assert.equal(
      await browser.evaluate("document.querySelector('.task-overview-actions button').disabled"),
      false
    );
    assert.equal(
      await browser.evaluate("document.querySelectorAll('.workbench-topbar > button').length"),
      0
    );
    checks.push(`${locale}: new task remains available with both agent slots occupied`);
  }
  assert.equal(modelRequests, 0);
  writeFileSync(
    join(output, 'checks.json'),
    JSON.stringify({ checks, modelRequests }, null, 2) + '\n'
  );
  console.log(JSON.stringify({ checks, modelRequests, output }, null, 2));
} finally {
  await browser?.close();
  await app?.close();
  await new Promise((resolve) => engine.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
