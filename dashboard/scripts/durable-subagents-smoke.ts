/** Explicit qualification with the approved local model and the existing bwrap boundary. */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createDurableEnvironment } from '../packages/server/src/durable/environment.js';
import { createLocalModels } from '../packages/server/src/durable/model.js';
import { DurableAgentManager } from '../packages/server/src/durable/manager.js';
import type { RunnerConfig } from '../packages/server/src/runner/config.js';
import type { AgentProject } from '@observatory/contracts';

const root = await mkdtemp(join(tmpdir(), 'b70-subagents-smoke-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
await writeFile(join(workspace, 'README.md'), 'Qualification word: Achat29\n');
await writeFile(join(root, 'host-only.txt'), 'Keep outside sandbox');
const config = {
  supportRoot: resolve('build/observatory-release/runtime'),
  profileRoot: 'data/runner-profile',
  provider: 'b70-vllm',
  model: 'Qwen3.8-27B',
  upstreamUrl: 'http://127.0.0.1:8081',
  gatewayUrl: process.env.B70_RUNNER_GATEWAY_URL ?? 'http://127.0.0.1:8090',
  gatewayToken: process.env.B70_RUNNER_GATEWAY_TOKEN,
  inferenceSocketRoot: '/run/local-ai-b70-runner/inference',
} as RunnerConfig;
const project = {
  id: randomUUID(),
  name: 'Subagent qualification',
  repositoryPath: workspace,
  targetBranch: 'main',
  workdir: '.',
  editPaths: ['.'],
  checks: [],
} as AgentProject;
const runId = randomUUID();
const sandbox = createDurableEnvironment(config, project, workspace, runId.replaceAll('-', ''));
const manager = new DurableAgentManager({
  runId,
  requestId: randomUUID(),
  provider: config.provider,
  model: config.model,
  thinkingLevel: 'low',
  models: await createLocalModels(config),
  storagePath: join(root, 'conversation.sqlite'),
  env: sandbox.env,
  browser: false,
  instructions:
    'Qualification: use precisely the requested tools, do not change other files. Return a brief report.',
  closeEnvironment: () => sandbox.close(),
});
process.once('SIGTERM', () => void manager.close().finally(() => process.exit(124)));
try {
  assert.equal(
    (await sandbox.env.readTextFile(join(root, 'host-only.txt'), BACKGROUND_CONTEXT)).ok,
    false
  );
  await manager.start({
    task: 'Call delegate_tasks exactly once with two assignments: Alpha must read README.md and write its qualification word to alpha.txt; Beta must independently read README.md and write its qualification word to beta.txt. Give each child only its file. After receiving both reports, read both files yourself, verify them and answer briefly. Do not do their work yourself.',
  });
  const deadline = Date.now() + 150_000;
  while (!['settled', 'failed'].includes(manager.snapshot().status)) {
    if (Date.now() > deadline) throw new Error('Local subagent qualification timed out.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const snapshot = manager.snapshot();
  assert.equal(snapshot.status, 'settled', snapshot.reason);
  assert.equal(snapshot.subagents?.length, 2);
  assert(snapshot.subagents.every((child) => child.status === 'completed'));
  assert.match(await readFile(join(workspace, 'alpha.txt'), 'utf8'), /Achat29/);
  assert.match(await readFile(join(workspace, 'beta.txt'), 'utf8'), /Achat29/);
  for (const child of snapshot.subagents) {
    const trace = snapshot.timeline.filter((item) => item.agent?.id === child.id);
    assert(trace.some((item) => item.toolName === 'write' && item.state === 'complete'));
    assert(trace.some((item) => item.kind === 'assistant'));
  }
  console.log(
    JSON.stringify({
      passed: true,
      isolated: true,
      root,
      subagents: snapshot.subagents,
      mainTools: snapshot.timeline
        .filter((item) => !item.agent && item.kind === 'tool')
        .map((item) => item.toolName),
    })
  );
} finally {
  await manager.close();
}
