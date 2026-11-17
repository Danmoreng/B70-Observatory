/** Real browser → API → Unix control → sandboxed runner. Use B70_MAP_LIVE=1 for the local Durable model. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../packages/server/dist/app.js';
import { loadServerConfig } from '../packages/server/dist/config.js';
import { loadRunnerConfig } from '../packages/server/dist/runner/config.js';
import { createRunner } from '../packages/server/dist/runner/service.js';
import { RunnerAgentClient } from '../packages/server/dist/agent/runner-client.js';
import { openBrowser, until } from './lib/browser-cdp.mjs';

const root = mkdtempSync(join(tmpdir(), 'b70-map-qa-'));
const repository = join(root, 'source');
const output = resolve('target/architecture-map');
const live = process.env.B70_MAP_LIVE === '1';
const checks = [];
for (const directory of [
  repository,
  output,
  join(root, 'dependencies'),
  join(root, 'state/runs'),
  join(root, 'profile'),
  join(root, 'fixture'),
])
  mkdirSync(directory, { recursive: true });
const paths = execFileSync(
  '/usr/bin/git',
  [
    'ls-files',
    'dashboard/packages/web/src',
    'dashboard/packages/server/src',
    'dashboard/packages/contracts/src',
    'dashboard/ops',
  ],
  { cwd: resolve('..'), encoding: 'utf8' }
)
  .trim()
  .split('\n');
for (const path of paths) {
  mkdirSync(dirname(join(repository, path)), { recursive: true });
  copyFileSync(resolve('..', path), join(repository, path));
}
writeFileSync(join(repository, 'dashboard/README.md'), '# Map qualification\n');
const git = (...args) =>
  execFileSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Map Qualification');
git('config', 'user.email', 'qa@local.invalid');
git('add', '.');
git('commit', '-qm', 'Map source fixture');
const revision = git('rev-parse', 'HEAD');
writeFileSync(join(root, 'profile/models.json'), '{}\n');
writeFileSync(
  join(root, 'fixture/agent.mjs'),
  `
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const c=JSON.parse(line);console.log(JSON.stringify({type:'response',id:c.id,success:true,data:{}}));
 if(c.type==='prompt'){
 console.log(JSON.stringify({type:'agent_start'}));
 appendFileSync('/workspace/dashboard/packages/web/src/components/agent/AgentProjectBrowser.vue','\\n<!-- map-qualification -->\\n');
 console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Kartenauftrag ausgeführt. map-qualification wurde ergänzt.'}],stopReason:'stop'}}));
 console.log(JSON.stringify({type:'agent_settled'})); }
});
`
);
const config = loadRunnerConfig({
  B70_RUNNER_ENGINE: live ? 'pi-durable' : 'pi-rpc',
  B70_RUNNER_CONTROL_TOKEN: randomBytes(32).toString('hex'),
  B70_RUNNER_CONTROL_SOCKET: join(root, 'control.sock'),
  B70_RUNNER_INFERENCE_SOCKET_ROOT: join(root, 'inference'),
  B70_RUNNER_DATABASE_PATH: join(root, 'state/tasks.sqlite'),
  B70_RUNNER_REPOSITORY: repository,
  B70_RUNNER_PROJECT_ROOTS: root,
  B70_RUNNER_STATE_ROOT: join(root, 'state/runs'),
  B70_RUNNER_SUPPORT_ROOT: resolve('build/observatory-release/runtime'),
  B70_RUNNER_AGENT_RUNTIME_ROOT: live ? resolve('node_modules') : join(root, 'fixture'),
  B70_RUNNER_AGENT_EXECUTABLE: live ? 'tsx/dist/cli.mjs' : 'agent.mjs',
  B70_RUNNER_PROFILE_ROOT: live
    ? resolve('data/runner-profile')
    : join(root, 'profile'),
  B70_RUNNER_DEPENDENCY_ROOT: join(root, 'dependencies'),
  B70_RUNNER_REVISION: revision,
  B70_RUNNER_UPSTREAM_URL: live ? 'http://127.0.0.1:8081' : 'http://127.0.0.1:9',
  B70_RUNNER_THINKING_LEVEL: 'low',
  B70_RUNNER_NPM_ENABLED: 'false',
  B70_RUNNER_RELEASE_SOCKET: join(root, 'no-release.sock'),
  B70_RUNNER_APP_HOST: '127.0.0.1',
});
let runner, client, app, browser;
const check = (name, condition = true) => {
  assert.ok(condition, name);
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  runner = await createRunner(config);
  await runner.relay.start();
  await runner.control.start();
  client = new RunnerAgentClient(config.controlSocket, config.controlToken);
  const project = await runner.service.registerProject({
    name: 'Observatory · Kartenprototyp',
    repositoryPath: repository,
    targetBranch: 'main',
    workdir: 'dashboard',
    editPaths: ['dashboard'],
    checks: [],
  });
  app = buildApp({
    config: loadServerConfig(),
    version: 'map-prototype',
    loggerLevel: 'silent',
    webRoot: resolve('packages/web/dist'),
    agent: client,
    auth: { mode: 'development', sessions: {}, sessionDays: 1, cookieSecure: false },
  });
  let startInput;
  app.addHook('preHandler', async (request) => {
    if (request.method === 'POST' && request.url === '/api/agent/runs')
      startInput = structuredClone(request.body);
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await openBrowser();
  await browser.send('Page.enable');
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { localStorage.setItem('observatory.locale','de'); } catch {}",
  });
  const evaluate = browser.evaluate;
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const visible = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
  const viewport = async (width, height) => {
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    );
  };
  const overflow = () => evaluate('document.documentElement.scrollWidth > innerWidth');
  await viewport(1280, 900);
  await browser.send('Page.navigate', { url: url + '/#/projects' });
  await until(() => visible('.project-cover img'), 'Project cover missing');
  check('Repository card shows a real reference capture');
  await browser.capture(join(output, '01-projects.png'));
  await click('.project-tile');
  await until(() => visible('[data-node="interface"]'), 'Functional map missing');
  check(
    'Project opens at functional top level',
    await evaluate("document.querySelectorAll('.map-node').length === 4")
  );
  check('Landscape iPad does not overflow', !(await overflow()));
  await until(
    () => evaluate("document.querySelectorAll('.map-connections path').length === 4"),
    'Map connections missing'
  );
  await browser.capture(join(output, '02-map-landscape.png'));
  await click('.map-layout-switch button:nth-child(2)');
  check('Nested layout preserves hierarchy', await visible('.map-nested-children'));
  await browser.capture(join(output, '03-nested-landscape.png'));
  await click('.map-layout-switch button:first-child');
  await viewport(820, 1180);
  check('Portrait iPad does not overflow', !(await overflow()));
  await until(
    () =>
      evaluate(
        "Math.abs(document.querySelector('.app-sidebar').getBoundingClientRect().width - 72) < 1"
      ),
    'Sidebar rotation did not settle'
  );
  check(
    'Map remains visible after rotating the iPad',
    await evaluate(
      "document.querySelector('.map-canvas').getBoundingClientRect().width > 350 && document.querySelector('.map-canvas').getBoundingClientRect().left >= 72"
    )
  );
  await browser.capture(join(output, '04-map-portrait.png'));
  await click('[data-node="interface"]');
  await click('[data-node="projects"]');
  await until(() => visible('.map-screen img'), 'Screen reference missing');
  await until(
    () =>
      evaluate(
        "document.querySelector('.map-screen img')?.complete && document.querySelector('.map-screen img')?.naturalWidth > 0"
      ),
    'Reference image not loaded'
  );
  await click('.map-screen');
  check('Screen marker is attached to the selected node', await visible('.map-screen-pin'));
  await click('.map-inspector-heading button');
  const prompt =
    'Ergänze genau einmal den HTML-Kommentar <!-- map-qualification --> am Ende von /workspace/dashboard/packages/web/src/components/agent/AgentProjectBrowser.vue. Lies die Datei zuerst. Ändere sonst nichts. Dies ist ein kurzer UI-Integrationstest in einem wegwerfbaren Testrepository. Antworte anschließend kurz auf Deutsch, welcher Kartenbereich ausgewählt war. Keine Rückfragen, kein Commit, kein Deployment.';
  await evaluate(
    `(()=>{const e=document.querySelector('#map-task-message');e.value=${JSON.stringify(prompt)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
  check('Task dialog fits portrait iPad', !(await overflow()));
  await browser.capture(join(output, '05-map-task-dialog.png'));
  await evaluate("document.querySelector('.map-task-form').requestSubmit()");
  await until(() => evaluate("location.hash.startsWith('#/agent/')"), 'Task did not open', 30_000);
  let detail;
  await until(
    async () => {
      const tasks = await client.listTasks();
      const item = tasks.items[0];
      if (!item) return false;
      detail = await client.getTask(item.id);
      if (item.latestRun.status === 'failed')
        throw new Error(detail.latestSnapshot?.reason ?? 'Model task failed');
      return item.latestRun.status === 'completed';
    },
    'Task did not complete',
    live ? 180_000 : 30_000
  );
  check(
    live ? 'Local Durable model completed the map task' : 'Sandboxed fixture completed the map task'
  );
  check(
    'Task retains node, revision and screen marker',
    detail.task.architectureTarget.nodeId === 'projects' &&
      detail.task.architectureTarget.revision === revision &&
      detail.task.architectureTarget.point.x === 0.5
  );
  const instructions = readFileSync(
    join(
      config.stateRoot,
      detail.task.latestRun.id.replaceAll('-', ''),
      'profile/agent-system-prompt-append.txt'
    ),
    'utf8'
  );
  check(
    'Model received architecture context',
    instructions.includes('Architecture selection') && instructions.includes('Projektübersicht')
  );
  check('User conversation preserves the original message', detail.messages[0].text === prompt);
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  check(
    'Exact reference image was persisted with the task',
    database.prepare('SELECT COUNT(*) AS n FROM agent_input_images').get().n === 1
  );
  database.close();
  check(
    'Result contains the targeted source change',
    detail.latestResult.files.length === 1 &&
      detail.latestResult.files.includes(
        'dashboard/packages/web/src/components/agent/AgentProjectBrowser.vue'
      ) &&
      detail.latestResult.diff.includes('map-qualification')
  );
  if (live) check('The task used Pi Durable', detail.task.latestRun.profileId === 'durable-v1');
  await until(() => visible('.task-map-return'), 'Map return link missing');
  await click('.task-map-return');
  await until(() => visible('.map-review-link'), 'Result pin missing');
  check('Result is discoverable at its original map location');
  await browser.capture(join(output, '06-pinned-result.png'));
  await click('.map-review-link');
  await until(() => visible('.agent-diff-view'), 'Review did not open');
  check('Map result links directly to the code review');
  check(
    'File review selects the actual changed file, not the diff stat',
    await evaluate(
      "document.querySelectorAll('.diff-file-list button').length === 1 && document.querySelector('.agent-diff-view').innerText.includes('map-qualification')"
    )
  );
  check('File review fits the iPad viewport', !(await overflow()));
  check(
    'Collapsed sidebar has no horizontal scroll',
    await evaluate(
      "document.querySelector('.app-sidebar').scrollWidth <= document.querySelector('.app-sidebar').clientWidth"
    )
  );
  await browser.capture(join(output, '07-review.png'));
  writeFileSync(
    join(repository, 'dashboard/README.md'),
    readFileSync(join(repository, 'dashboard/README.md'), 'utf8') + '\nAdvanced source revision.\n'
  );
  git('add', 'dashboard/README.md');
  git('commit', '-qm', 'Advance source after completed task');
  const retry = await client.start(startInput);
  check(
    'A lost-response retry still reuses the task after the map advances',
    retry.runId === detail.task.latestRun.id && (await client.listTasks()).items.length === 1
  );
  // A stale browser selection cannot silently start work on a different source revision.
  const target = detail.task.architectureTarget;
  const before = (await client.listTasks()).items.length;
  try {
    await client.start({
      projectId: project.id,
      name: 'Stale map',
      task: 'No operation',
      architectureTarget: { ...target, point: undefined },
      idempotencyKey: randomUUID(),
    });
    throw new Error('Stale map accepted');
  } catch (error) {
    assert.equal(error.code, 'conflict');
  }
  check(
    'Stale map fails before any new task is created',
    (await client.listTasks()).items.length === before
  );
  await browser.close();
  browser = undefined;
  await app.close();
  app = undefined;
  await client.close();
  client = undefined;
  await runner.control.close();
  await runner.service.close();
  await runner.relay.close();
  runner = await createRunner(config);
  await runner.relay.start();
  const restored = await runner.service.getTask(detail.task.id);
  check(
    'Task pin and result survive runner restart',
    restored.task.architectureTarget.nodeId === 'projects' &&
      restored.latestResult.resultRevision === detail.latestResult.resultRevision
  );
  writeFileSync(
    join(output, live ? 'qualification-live.json' : 'qualification-fixture.json'),
    JSON.stringify(
      {
        live,
        root,
        taskId: detail.task.id,
        revision,
        resultRevision: detail.latestResult.resultRevision,
        checks,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`Saved qualification artifacts: ${output}`);
} finally {
  await browser?.close();
  await app?.close();
  await client?.close();
  await runner?.control.close();
  await runner?.service.close();
  await runner?.relay.close();
}
