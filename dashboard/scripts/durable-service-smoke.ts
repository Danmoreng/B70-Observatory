/** Explicit local qualification against the configured vLLM, using disposable source/state. */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRunner } from '../packages/server/src/runner/service.js';
import { RunnerAgentClient } from '../packages/server/src/agent/runner-client.js';
import { loadRunnerConfig } from '../packages/server/src/runner/config.js';

const root = await mkdtemp(join(tmpdir(), 'b70-durable-service-'));
const repository = join(root, 'source');
const state = join(root, 'state');
for (const path of [repository, state, join(state, 'runs'), join(root, 'dependencies')])
  await mkdir(path, { recursive: true });
await mkdir(join(repository, 'dashboard'));
await writeFile(join(repository, 'README.md'), 'Project word: Bernstein42\n');
await writeFile(join(repository, 'dashboard', 'README.md'), 'Default seed project.\n');
function git(...args: string[]) {
  return execFileSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
}
git('init', '-b', 'main');
git('config', 'user.name', 'Durable Qualification');
git('config', 'user.email', 'test@local.invalid');
git('add', '.');
git('commit', '-m', 'fixture');
const revision = git('rev-parse', 'HEAD');
const seedRepository = join(root, 'seed');
execFileSync('/usr/bin/git', ['clone', repository, seedRepository]);
const runnerEnv = {
  B70_RUNNER_ENGINE: 'pi-durable',
  B70_RUNNER_GATEWAY_URL: process.env.B70_RUNNER_GATEWAY_URL ?? 'http://127.0.0.1:8090',
  B70_RUNNER_GATEWAY_TOKEN: process.env.B70_RUNNER_GATEWAY_TOKEN,
  B70_RUNNER_CONTROL_TOKEN: randomBytes(32).toString('hex'),
  B70_RUNNER_CONTROL_SOCKET: join(root, 'control.sock'),
  B70_RUNNER_INFERENCE_SOCKET_ROOT: join(root, 'inference'),
  B70_RUNNER_DATABASE_PATH: join(state, 'tasks.sqlite'),
  B70_RUNNER_REPOSITORY: seedRepository,
  B70_RUNNER_PROJECT_ROOTS: root,
  B70_RUNNER_STATE_ROOT: join(state, 'runs'),
  B70_RUNNER_SUPPORT_ROOT: resolve('build/observatory-release/runtime'),
  B70_RUNNER_AGENT_RUNTIME_ROOT: resolve('node_modules'),
  B70_RUNNER_AGENT_EXECUTABLE: 'tsx/dist/cli.mjs',
  B70_RUNNER_PROFILE_ROOT: 'data/runner-profile',
  B70_RUNNER_DEPENDENCY_ROOT: join(root, 'dependencies'),
  B70_RUNNER_REVISION: revision,
  B70_RUNNER_THINKING_LEVEL: 'low',
  B70_RUNNER_NPM_ENABLED: 'false',
  B70_RUNNER_RELEASE_SOCKET: join(root, 'no-release.sock'),
};
const config = loadRunnerConfig(runnerEnv);
let crashNextClose = false;
async function newRunner() {
  if (process.env.B70_SMOKE_BUNDLED !== '1') return await createRunner(config);
  const child = spawn(process.execPath, [resolve('build/observatory-release/runner.mjs')], {
    env: { ...process.env, ...runnerEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk.toString()));
  child.stderr.on('data', (chunk) => (log += chunk.toString()));
  const deadline = Date.now() + 20_000;
  while (!log.includes('[b70-runner] ready')) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error('Bundled runner startup failed: ' + log);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const client = new RunnerAgentClient(config.controlSocket, config.controlToken);
  const originalClose = client.close.bind(client);
  client.close = async () => {
    await originalClose();
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill(crashNextClose ? 'SIGKILL' : 'SIGTERM');
    crashNextClose = false;
    await exited;
  };
  return {
    service: Object.assign(client, { async resumeDurableWork() {} }),
    relay: { async start() {}, async close() {} },
  };
}
let runner = await newRunner();
await runner.relay.start();
async function waitFor(taskId: string, statuses: string[], timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const detail = await runner.service.getTask(taskId);
    if (statuses.includes(detail.task.latestRun.status)) return detail;
    if (detail.task.latestRun.status === 'failed') throw new Error(JSON.stringify(detail));
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    'Task timed out: ' +
      JSON.stringify({
        detail: await runner.service.getTask(taskId),
        snapshot: runner.service.snapshot(),
      })
  );
}
try {
  const project = await runner.service.registerProject({
    name: 'Durable test',
    repositoryPath: repository,
    targetBranch: 'main',
    workdir: '.',
    editPaths: ['.'],
    checks: [],
  });
  const first = await runner.service.start({
    projectId: project.id,
    name: 'Dauerhaftes Gespräch prüfen',
    task: 'Lies README.md. Stelle danach mit ask_user die Frage: Welches Suffix soll ich an das Projektwort anhängen?',
  });
  const taskId = (await runner.service.listTasks()).items.find(
    (task) => task.latestRun.id === first.runId
  )!.id;
  const question = await waitFor(taskId, ['yielded']);
  assert.ok(question.openQuestion);
  await runner.service.answerQuestion({
    taskId,
    questionId: question.openQuestion.id,
    answer:
      'Hänge -OK an und schreibe das Ergebnis in proof.txt. Das Projektwort sollst du aus unserem Gespräch kennen.',
    expectedTaskVersion: question.task.version,
    idempotencyKey: randomUUID(),
  });
  const done = await waitFor(taskId, ['completed']);
  assert.ok(done.latestResult);
  assert.equal(done.task.latestRun.profileId, 'durable-v1');
  const bindingPath = join(state, 'durable', taskId, 'workspace.json');
  const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as { path: string };
  assert.match(await readFile(join(binding.path, 'proof.txt'), 'utf8'), /Bernstein42-OK/);
  console.log(
    JSON.stringify({
      questionAndAnswer: true,
      taskId,
      workspace: binding.path,
      result: done.latestResult.resultRevision,
    })
  );
  // An unsafe command may already have effects when the runner stops.
  const next = await runner.service.continueTask({
    taskId,
    idempotencyKey: randomUUID(),
    message:
      'Führe genau einmal mit bash aus: printf "einmal\\n" >> counter.txt; sleep 20. Wiederhole diesen Befehl auch nach einer Unterbrechung niemals. Danach prüfe counter.txt und melde die Zeilenanzahl.',
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(join(binding.path, 'counter.txt'), 'utf8')).trim()) break;
    } catch {
      /* File is created by the running tool. */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await readFile(join(binding.path, 'counter.txt'), 'utf8')).trim(), 'einmal');
  crashNextClose = process.env.B70_SMOKE_BUNDLED === '1';
  await runner.service.close();
  await runner.relay.close();
  runner = await newRunner();
  await runner.relay.start();
  await runner.service.resumeDurableWork();
  const recovered = await waitFor(taskId, ['completed']);
  assert.equal(recovered.task.latestRun.id, next.runId, 'Recovery must retain the same run');
  assert.equal(
    (await readFile(join(binding.path, 'counter.txt'), 'utf8')).trim(),
    'einmal',
    'Interrupted unsafe command must not replay'
  );
  const afterBinding = JSON.parse(await readFile(bindingPath, 'utf8')) as { path: string };
  assert.equal(afterBinding.path, binding.path);
  // Pending steering stays beside the composer until the next model boundary.
  await runner.service.continueTask({
    taskId,
    idempotencyKey: randomUUID(),
    message:
      'Führe mit bash aus: touch steering-ready; sleep 10. Danach warte auf neue Anweisungen.',
  });
  const steeringDeadline = Date.now() + 60_000;
  while (Date.now() < steeringDeadline) {
    try {
      await readFile(join(binding.path, 'steering-ready'));
      break;
    } catch {
      /* The running tool has not created the file yet. */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const active = await runner.service.getTask(taskId);
  const steeringText =
    'Neue Anweisung: Schreibe Steuerung77 in steering.txt und beende dann den Auftrag.';
  const steered = await runner.service.steer({
    runId: active.task.latestRun.id,
    expectedRunVersion: active.task.latestRun.version,
    expectedTaskVersion: active.task.version,
    idempotencyKey: randomUUID(),
    message: steeringText,
  });
  assert.ok(
    !steered.timeline.some((item) => item.kind === 'steering' && item.text === steeringText),
    'Undelivered message must not be inserted early'
  );
  const steeringDone = await waitFor(taskId, ['completed']);
  assert.match(await readFile(join(binding.path, 'steering.txt'), 'utf8'), /Steuerung77/);
  assert.ok(
    steeringDone.steering.at(-1)?.confirmedAt,
    'Steering delivery must be confirmed at the committed input'
  );
  const timeline = steeringDone.latestSnapshot!.timeline;
  const deliveredIndex = timeline.findIndex(
    (item) => item.kind === 'steering' && item.text === steeringText
  );
  assert.ok(
    deliveredIndex >
      timeline.findIndex(
        (item) => item.kind === 'tool' && item.argumentsText?.includes('steering-ready')
      )
  );
  // Manual pause is retained across runner restarts and continues on user input.
  await runner.service.continueTask({
    taskId,
    idempotencyKey: randomUUID(),
    message:
      'Führe genau einmal mit bash aus: printf "einmal\\n" >> paused-counter.txt; sleep 20. Wiederhole den Schreibbefehl niemals.',
  });
  const pauseDeadline = Date.now() + 60_000;
  while (Date.now() < pauseDeadline) {
    try {
      if ((await readFile(join(binding.path, 'paused-counter.txt'), 'utf8')).trim()) break;
    } catch {
      /* The running tool has not created the file yet. */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const pausing = await runner.service.getTask(taskId);
  await runner.service.pause({
    runId: pausing.task.latestRun.id,
    expectedRunVersion: pausing.task.latestRun.version,
    expectedTaskVersion: pausing.task.version,
    idempotencyKey: randomUUID(),
  });
  assert.equal((await runner.service.getTask(taskId)).task.latestRun.status, 'interrupted');
  assert.equal((await runner.service.getTask(taskId)).latestSnapshot?.status, 'paused');
  await runner.service.close();
  await runner.relay.close();
  runner = await newRunner();
  await runner.relay.start();
  await runner.service.resumeDurableWork();
  assert.equal(
    (await runner.service.listTasks()).activeTaskIds.length,
    0,
    'Manual pause must not auto-resume'
  );
  await runner.service.continueTask({
    taskId,
    idempotencyKey: randomUUID(),
    message:
      'Setze fort. Lies nur paused-counter.txt, bestätige die Zeilenanzahl und beende den Auftrag. Führe den alten Schreibbefehl nicht erneut aus.',
  });
  await waitFor(taskId, ['completed']);
  assert.equal((await readFile(join(binding.path, 'paused-counter.txt'), 'utf8')).trim(), 'einmal');
  console.log(
    JSON.stringify({
      passed: true,
      steeringPlacement: true,
      manualPause: true,
      runnerRestart: true,
      unsafeCommandNotReplayed: true,
      sameWorkspace: true,
      root,
      runId: next.runId,
    })
  );
} finally {
  await runner.service.close();
  await runner.relay.close();
}
