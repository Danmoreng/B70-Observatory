import { RunnerAgentClient } from '../packages/server/src/agent/runner-client.js';
import { readFileSync } from 'node:fs';
import type {
  AgentRunSnapshot,
  AgentStreamEvent,
  AgentTimelineItem,
  DurableTraceEvent,
} from '@observatory/contracts';

const socketIndex = process.argv.indexOf('--socket');
const requestedSocket =
  socketIndex >= 0 ? process.argv[socketIndex + 1] : '/run/local-ai-b70-runner/control.sock';
if (
  requestedSocket === undefined ||
  !requestedSocket.startsWith('/') ||
  requestedSocket.includes('\0')
) {
  throw new Error('runner socket must be an absolute path');
}
const socketPath: string = requestedSocket;
const tokenIndex = process.argv.indexOf('--token');
const envFileIndex = process.argv.indexOf('--env-file');
const envFile = envFileIndex >= 0 ? process.argv[envFileIndex + 1] : 'data/runner.env';
const controlToken = (() => {
  if (tokenIndex >= 0) return process.argv[tokenIndex + 1];
  if (process.env.B70_RUNNER_CONTROL_TOKEN !== undefined) {
    return process.env.B70_RUNNER_CONTROL_TOKEN;
  }
  try {
    return readFileSync(envFile!, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('B70_RUNNER_CONTROL_TOKEN='))
      ?.slice('B70_RUNNER_CONTROL_TOKEN='.length);
  } catch {
    return undefined;
  }
})();
if (!/^[a-f0-9]{64}$/.test(controlToken ?? '')) {
  throw new Error('runner control token is missing; run configure:runner first');
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function latestDiagnostic(snapshot: AgentRunSnapshot): string | undefined {
  return [...snapshot.timeline]
    .reverse()
    .find((item) => item.kind === 'notice' || item.kind === 'error')?.text;
}

function eventItems(event: AgentStreamEvent): AgentTimelineItem[] {
  if (event.operation === 'append' || event.operation === 'replace') return [event.item];
  if (event.operation === 'reset') return event.snapshot.timeline;
  return [];
}

async function main(): Promise<void> {
  const client = new RunnerAgentClient(socketPath, controlToken!);
  try {
    const deadline = Date.now() + 5_000;
    while (!client.snapshot().enabled && Date.now() < deadline) await wait(100);
    const initial = client.snapshot();
    if (!initial.enabled) throw new Error(initial.reason ?? 'isolated runner unavailable');
    process.stdout.write(
      `Runner ready: ${initial.provider ?? 'unknown'}/${initial.model ?? 'unknown'} (${initial.status})\n`
    );
    if (!process.argv.includes('--run')) return;

    let started;
    try {
      started = await client.start({
        name: 'Installationsprüfung',
        task: 'Lies die README-Datei im Arbeitsverzeichnis. Verändere keine Datei. Antworte mit genau einem kurzen deutschen Satz, der den Zweck des Repositorys beschreibt.',
      });
    } catch (error) {
      await wait(100);
      const diagnostic = latestDiagnostic(client.snapshot());
      throw new Error(
        `${error instanceof Error ? error.message : 'runner start failed'}${diagnostic === undefined ? '' : ` Diagnostic: ${diagnostic.slice(0, 512)}`}`
      );
    }
    process.stdout.write(`Sandboxed run accepted: ${started.runId ?? 'pending'}\n`);
    const runDeadline = Date.now() + 10 * 60_000;
    while (['starting', 'running'].includes(client.snapshot().status) && Date.now() < runDeadline) {
      await wait(500);
    }
    const finished = client.snapshot();
    if (['starting', 'running'].includes(finished.status))
      throw new Error('runner smoke test timed out');
    if (finished.status === 'failed') {
      const diagnostic = latestDiagnostic(finished);
      throw new Error(
        `${finished.reason ?? 'runner smoke test failed'}${diagnostic === undefined ? '' : ` Diagnostic: ${diagnostic.slice(0, 512)}`}`
      );
    }
    const runId = started.runId;
    if (runId === undefined) throw new Error('runner did not return a durable run ID');
    const tasks = await client.listTasks();
    const task = tasks.items.find((item) => item.latestRun.id === runId);
    if (task === undefined) throw new Error('completed run is missing from durable task history');
    let detail = await client.getTask(task.id);
    // The model settles before the runner has stored its Git/check result.
    while (
      ['queued', 'starting', 'running', 'cancelling'].includes(detail.task.latestRun.status) &&
      Date.now() < runDeadline
    ) {
      await wait(100);
      detail = await client.getTask(task.id);
    }
    if (detail.task.latestRun.status !== 'completed') {
      throw new Error(`durable run did not complete (${detail.task.latestRun.status})`);
    }
    const trace: DurableTraceEvent[] = [];
    let afterSequence = -1;
    while (true) {
      const page = await client.getRunTrace(runId, afterSequence, 250);
      trace.push(...page.items);
      if (!page.hasMore) break;
      if (page.nextAfterSequence === undefined || page.nextAfterSequence <= afterSequence) {
        throw new Error('durable trace cursor did not advance');
      }
      afterSequence = page.nextAfterSequence;
    }
    if (trace.length !== detail.traceEventCount) {
      throw new Error(
        `durable trace count mismatch (detail ${detail.traceEventCount}, export ${trace.length})`
      );
    }
    for (let index = 1; index < trace.length; index += 1) {
      if (trace[index]!.sequence <= trace[index - 1]!.sequence) {
        throw new Error('durable trace sequence is not strictly increasing');
      }
    }
    const persistedKinds = new Set(
      trace.flatMap((item) => eventItems(item.event).map((entry) => entry.kind))
    );
    for (const kind of ['task', 'assistant'] as const) {
      if (!persistedKinds.has(kind)) throw new Error(`durable trace is missing ${kind} content`);
    }
    for (const kind of ['thinking', 'tool'] as const) {
      if (finished.timeline.some((item) => item.kind === kind) && !persistedKinds.has(kind)) {
        throw new Error(`visible ${kind} content is missing from the durable trace`);
      }
    }
    process.stdout.write(
      `Sandboxed run ended: ${finished.status}\nDurable trace verified: ${trace.length} events (${[...persistedKinds].join(', ')})\n`
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[b70-runner-smoke] ${error instanceof Error ? error.message : 'test failed'}\n`
  );
  process.exitCode = 1;
});
