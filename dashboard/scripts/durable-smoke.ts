import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDurableEnvironment } from '../packages/server/src/durable/environment.js';
import { createLocalModels } from '../packages/server/src/durable/model.js';
import { DurableAgentManager } from '../packages/server/src/durable/manager.js';
import type { RunnerConfig } from '../packages/server/src/runner/config.js';
import type { AgentProject } from '@observatory/contracts';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import assert from 'node:assert/strict';

const root = await mkdtemp(join(tmpdir(), 'b70-durable-smoke-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
await writeFile(
  join(workspace, 'README.md'),
  'Durable qualification fixture. Project word: Smaragd71.\n'
);
await writeFile(join(root, 'host-only-secret.txt'), 'This file must stay outside the sandbox.');
const config = {
  supportRoot: resolve('build/durable-smoke-runtime'),
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
  name: 'Durable qualification',
  repositoryPath: workspace,
  targetBranch: 'main',
  workdir: '.',
  editPaths: ['.'],
  checks: [],
} as AgentProject;
const models = await createLocalModels(config);
async function turn(text: string) {
  const runId = randomUUID();
  const sandbox = createDurableEnvironment(config, project, workspace, runId.replaceAll('-', ''));
  const outside = await sandbox.env.readTextFile(
    join(root, 'host-only-secret.txt'),
    BACKGROUND_CONTEXT
  );
  assert.equal(outside.ok, false, 'Host sentinel must not be visible');
  const manager = new DurableAgentManager({
    runId,
    requestId: randomUUID(),
    provider: config.provider,
    model: config.model,
    thinkingLevel: 'low',
    models,
    storagePath: join(root, 'conversation.sqlite'),
    instructions:
      'Arbeite präzise an dieser Testaufgabe. Verwende die bereitgestellten Werkzeuge. Antworte kurz auf Deutsch.',
    env: sandbox.env,
    browser: false,
    closeEnvironment: () => sandbox.close(),
  });
  try {
    await manager.start({ task: text });
    const deadline = Date.now() + 120_000;
    while (!['settled', 'failed'].includes(manager.snapshot().status)) {
      if (Date.now() > deadline) throw new Error('Qualification timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
    const result = manager.snapshot();
    console.log(
      JSON.stringify({
        runId,
        status: result.status,
        reason: result.reason,
        items: result.timeline.map((item) => ({
          kind: item.kind,
          text: item.text,
          output: item.outputText,
          tool: item.toolName,
        })),
      })
    );
    assert.equal(result.status, 'settled', result.reason);
    return result;
  } finally {
    await manager.close();
  }
}
await turn('Lies README.md und schreibe das dort angegebene Projektwort exakt in proof.txt.');
assert.match(await readFile(join(workspace, 'proof.txt'), 'utf8'), /Smaragd71/);
const resumed = await turn(
  'Welches Projektwort hatten wir zuvor verwendet? Antworte aus unserem bisherigen Gespräch, ohne Werkzeuge aufzurufen.'
);
assert.match(
  resumed.timeline.filter((item) => item.kind === 'assistant').at(-1)?.text ?? '',
  /Smaragd71/
);
console.log(
  JSON.stringify({
    passed: true,
    storage: join(root, 'conversation.sqlite'),
    workspace,
    isolated: true,
  })
);
