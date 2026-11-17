import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerAgentClient } from '../../src/agent/runner-client.js';
import type { RunnerConfig } from '../../src/runner/config.js';
import { createRunner } from '../../src/runner/service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

describe.runIf(
  process.env.B70_RELEASE_BUILD !== '1' &&
    process.platform === 'linux' &&
    existsSync('/usr/bin/bwrap')
)('isolated runner end to end', () => {
  it('carries control over Unix IPC and inference through the sandbox relay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-runner-e2e-'));
    roots.push(root);
    const repository = join(root, 'repository');
    const stateRoot = join(root, 'state');
    const agentRuntimeRoot = join(root, 'agent-runtime');
    const profileRoot = join(root, 'profile');
    const inferenceSocketRoot = join(root, 'inference');
    const controlRoot = join(root, 'control');
    for (const directory of [
      repository,
      stateRoot,
      agentRuntimeRoot,
      profileRoot,
      inferenceSocketRoot,
      controlRoot,
    ]) {
      mkdirSync(directory, { mode: 0o700 });
    }
    execFileSync('/usr/bin/git', ['init', '-q', repository]);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'B70 Test']);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'b70@example.invalid']);
    writeFileSync(join(repository, 'README.md'), '# Isolated fixture\n');
    mkdirSync(join(repository, 'dashboard'));
    writeFileSync(join(repository, 'dashboard', 'package.json'), '{"private":true}\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'fixture']);
    const revision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const dependencyRoot = join(repository, 'dashboard', 'node_modules');
    mkdirSync(dependencyRoot, { recursive: true, mode: 0o755 });
    writeFileSync(join(dependencyRoot, 'fixture.txt'), 'read-only dependency\n');
    writeFileSync(join(profileRoot, 'models.json'), '{}\n', { mode: 0o600 });
    const fakeAgent = join(agentRuntimeRoot, 'fake-agent.mjs');
    writeFileSync(
      fakeAgent,
      `
import readline from 'node:readline';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const input = readline.createInterface({ input: process.stdin });
input.on('line', async (line) => {
  const command = JSON.parse(line);
  if (command.type === 'prompt') {
    const auth = JSON.parse(fs.readFileSync('/profile/auth.json', 'utf8'));
    if (Object.keys(auth).length !== 0) process.exit(4);
    fs.writeFileSync('/profile/auth.json.lock-test', 'sandbox-local');
    if (fs.readFileSync('/workspace/dashboard/node_modules/fixture.txt', 'utf8') !== 'read-only dependency\\n') process.exit(5);
    try {
      fs.writeFileSync('/workspace/dashboard/node_modules/must-not-write', 'bad');
      process.exit(6);
    } catch {}
    if (process.env.B70_RUN_MODE !== 'review') {
      if (process.env.NPM_CONFIG_REGISTRY !== 'http://127.0.0.1:4873/') process.exit(20);
      const npmrc = fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, 'utf8');
      const token = npmrc.match(/_authToken=([a-f0-9]{64})/)[1];
      const denied = await fetch('http://127.0.0.1:4873/-/whoami', { headers: { authorization: 'Bearer ' + token } });
      if (denied.status !== 403) process.exit(21);
    } else if (process.env.NPM_CONFIG_REGISTRY !== undefined) process.exit(22);
    if (process.env.B70_RUN_MODE === 'review') {
      try {
        fs.writeFileSync('/workspace/review-must-not-write', 'bad');
        process.exit(8);
      } catch {}
      fs.writeFileSync('/profile/review.json', JSON.stringify({
        version: 1,
        summary: 'Independent fixture review',
        findings: [{ severity: 'medium', title: 'Fixture finding', file: 'README.md', line: 1, reasoning: 'Verified by the fixture.' }]
      }));
    }
    const branch = execFileSync('/usr/bin/git', ['-C', '/workspace', 'branch', '--show-current'], { encoding: 'utf8' }).trim();
    if (!branch.startsWith('agent/')) process.exit(7);
    const inference = await fetch('http://127.0.0.1:8081/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.B70_INFERENCE_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Qwen3.8-27B', messages: [{ role: 'user', content: command.message }] }),
    });
    if (!inference.ok) process.exit(3);
    await inference.text();
    console.log(JSON.stringify({ type: 'response', id: command.id, success: true }));
    console.log(JSON.stringify({ type: 'agent_start' }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'isolated' }], stopReason: 'stop' } }));
    console.log(JSON.stringify({ type: 'agent_settled' }));
  } else if (command.type === 'get_state') {
    console.log(JSON.stringify({ type: 'response', id: command.id, success: true, data: {} }));
  } else if (command.type === 'steer') {
    console.log(JSON.stringify({ type: 'response', id: command.id, success: true }));
    console.log(JSON.stringify({ type: 'queue_update', steering: [command.message], followUp: [] }));
    console.log(JSON.stringify({ type: 'message_start', message: { role: 'user', content: command.message } }));
    console.log(JSON.stringify({ type: 'message_end', message: { role: 'user', content: command.message } }));
    console.log(JSON.stringify({ type: 'queue_update', steering: [], followUp: [] }));
  } else if (command.type === 'clear_queue' || command.type === 'abort') {
    console.log(JSON.stringify({ type: 'response', id: command.id, success: true }));
  }
  }
);
`
    );
    chmodSync(fakeAgent, 0o600);

    let upstreamRequests = 0;
    let titleRequests = 0;
    const upstream = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200);
        response.end('ok');
        return;
      }
      upstreamRequests += 1;
      expect(request.url).toBe('/v1/chat/completions');
      expect(request.headers.authorization).toBeUndefined();
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.once('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        const isTitle = body.reasoning_effort === 'none';
        if (isTitle) titleRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ choices: isTitle ? [{ message: { content: 'README prüfen' } }] : [] })
        );
      });
    });
    await new Promise<void>((resolvePromise) => upstream.listen(0, '127.0.0.1', resolvePromise));
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('missing upstream port');

    const config: RunnerConfig = {
      controlSocket: join(controlRoot, 'control.sock'),
      controlToken: 'a'.repeat(64),
      inferenceSocketRoot,
      databasePath: join(root, 'tasks.sqlite'),
      repository,
      stateRoot,
      supportRoot: resolve(import.meta.dirname, '../../../runner/dist'),
      supportExecutable: 'sandbox-entry.js',
      agentRuntimeRoot,
      agentExecutable: 'fake-agent.mjs',
      profileRoot,
      dependencyRoot,
      revision,
      upstreamUrl: `http://127.0.0.1:${address.port}`,
      gatewayUrl: `http://127.0.0.1:${address.port}`,
      provider: 'b70-vllm',
      model: 'Qwen3.8-27B',
      thinkingLevel: 'medium',
      profileId: 'coding-default-v1',
      maxActiveRuns: 2,
      releaseSocket: join(root, 'release-helper.sock'),
    };
    const runner = await createRunner(config);
    await runner.relay.start();
    await runner.control.start();
    let client = new RunnerAgentClient(config.controlSocket, config.controlToken);
    try {
      await eventually(() => client.snapshot().enabled);
      try {
        await client.start({ task: 'Inspect the committed README' });
        await client.start({
          task: 'Inspect the committed README in parallel',
          name: 'Parallel README',
        });
        await eventually(async () => (await client.listTasks()).activeTaskIds.length === 2);
        await eventually(async () =>
          (await client.listTasks()).items.some((task) => task.title === 'README prüfen')
        );
        const activeTasks = await client.listTasks();
        expect(activeTasks.activeTaskIds).toHaveLength(2);
        expect(activeTasks.items.map((task) => task.title).sort()).toEqual([
          'Parallel README',
          'README prüfen',
        ]);
        const queued = await client.start({
          task: 'Inspect the committed README after a slot is free',
          name: 'Queued README',
        });
        expect(queued.status).toBe('queued');
        expect((await client.listTasks()).activeTaskIds).toHaveLength(2);
        expect(
          (await client.listTasks()).items.find((task) => task.title === 'Queued README')?.latestRun
            .status
        ).toBe('queued');
        const first = activeTasks.items.find((task) => task.title === 'README prüfen')!;
        const firstSteering = await client.getTask(first.id);
        await client.steer({
          runId: first.latestRun.id,
          expectedRunVersion: firstSteering.task.latestRun.version,
          expectedTaskVersion: firstSteering.task.version,
          message: 'Keep the change small.',
          idempotencyKey: '31313131-3131-4131-8131-313131313131',
        });
        const secondSteering = await client.getTask(first.id);
        await client.steer({
          runId: first.latestRun.id,
          expectedRunVersion: secondSteering.task.latestRun.version,
          expectedTaskVersion: secondSteering.task.version,
          message: 'Keep the change small.',
          idempotencyKey: '32323232-3232-4232-8232-323232323232',
        });
        await client.close();
        client = new RunnerAgentClient(config.controlSocket, config.controlToken);
        await eventually(() => client.snapshot().enabled);
        const beforeCancel = await client.getTask(first.id);
        await client.cancel({
          runId: first.latestRun.id,
          expectedRunVersion: beforeCancel.task.latestRun.version,
          expectedTaskVersion: beforeCancel.task.version,
          idempotencyKey: '33333333-3333-4333-8333-333333333333',
        });
      } catch (error) {
        const diagnostic = runner.service
          .snapshot()
          .timeline.filter((item) => item.kind === 'notice' || item.kind === 'error')
          .map((item) => item.text)
          .filter((text): text is string => text !== undefined)
          .join(' | ');
        throw new Error(
          `${error instanceof Error ? error.message : 'runner start failed'}${diagnostic === '' ? '' : `: ${diagnostic}`}`
        );
      }
      await eventually(async () => {
        const tasks = await client.listTasks();
        return (
          tasks.items.length === 3 &&
          tasks.items.every((task) => ['completed', 'cancelled'].includes(task.latestRun.status))
        );
      });
      const tasks = await client.listTasks();
      expect(tasks.items).toHaveLength(3);
      expect(tasks.items.map((task) => task.latestRun.status).sort()).toEqual([
        'cancelled',
        'completed',
        'completed',
      ]);
      const completedTask = tasks.items.find((task) => task.latestRun.status === 'completed')!;
      const cancelledTask = tasks.items.find((task) => task.latestRun.status === 'cancelled')!;
      const persisted = await client.getTask(completedTask.id);
      const cancelled = await client.getTask(cancelledTask.id);
      expect(cancelled.steering).toHaveLength(2);
      expect(cancelled.steering.every((entry) => entry.confirmedAt !== undefined)).toBe(true);
      expect(cancelled.cancellations[0]?.status).toBe('completed');
      expect(persisted.traceEventCount).toBeGreaterThan(2);
      expect(persisted.latestSnapshot?.timeline).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'assistant', text: 'isolated' })])
      );
      const trace = await client.getRunTrace(tasks.items[0]!.latestRun.id, -1, 250);
      expect(trace.hasMore).toBe(false);
      expect(trace.items).toHaveLength(persisted.traceEventCount);
      expect(trace.items.map((item) => item.sequence)).toEqual(
        [...trace.items.map((item) => item.sequence)].sort((left, right) => left - right)
      );
      await client.startReview({
        taskId: completedTask.id,
        sourceRunId: completedTask.latestRun.id,
        resultRevision: persisted.latestResult!.resultRevision,
        idempotencyKey: '34343434-3434-4434-8434-343434343434',
      });
      await eventually(() => runner.service.snapshot().activeRuns === 0);
      const reviewed = await client.getTask(completedTask.id);
      expect(reviewed.reviews[0]).toMatchObject({
        status: 'completed',
        stale: false,
        summary: 'Independent fixture review',
        findings: [expect.objectContaining({ title: 'Fixture finding' })],
      });
      expect(upstreamRequests).toBe(5);
      expect(titleRequests).toBe(1);
      expect(existsSync(join(profileRoot, 'auth.json'))).toBe(false);
      const runEntries = execFileSync(
        '/usr/bin/find',
        [stateRoot, '-name', 'auth.json.lock-test'],
        {
          encoding: 'utf8',
        }
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      expect(runEntries).toHaveLength(4);
    } finally {
      await client.close();
      await runner.control.close();
      await runner.service.close();
      await runner.relay.close();
      await new Promise<void>((resolvePromise) => upstream.close(() => resolvePromise()));
    }
  }, 20_000);
});
