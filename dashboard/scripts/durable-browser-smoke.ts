/** Native browser/vision qualification; everything visible is a disposable fixture. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { createDurableEnvironment } from '../packages/server/src/durable/environment.js';
import { createLocalModels } from '../packages/server/src/durable/model.js';
import { DurableAgentManager } from '../packages/server/src/durable/manager.js';
import { loadRunnerConfig } from '../packages/server/src/runner/config.js';
import { RunnerAgentClient } from '../packages/server/src/agent/runner-client.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { validateAgentImage } from '../packages/runner/src/image-validation.js';
import type { AgentProject } from '@observatory/contracts';
const visible = process.argv.includes('--desktop');
const root = await mkdtemp(join(tmpdir(), 'b70-durable-browser-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
await writeFile(
  join(workspace, 'preview.cjs'),
  `require('http').createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><title>Durable vision fixture</title><body style="background:white"><h1>Vision proof</h1><div style="width:300px;height:300px;background:magenta"></div></body></html>')}).listen(8123,'127.0.0.1');`
);
const config = loadRunnerConfig({
  ...parseEnv(
    readFileSync('data/runner.env', 'utf8')
  ),
  B70_RUNNER_ENGINE: 'pi-durable',
  B70_RUNNER_SUPPORT_ROOT: resolve('build/observatory-release/runtime'),
  B70_RUNNER_DESKTOP_ENABLED: visible ? '1' : '0',
  B70_RUNNER_NPM_ENABLED: 'false',
});
assert.equal(config.model, 'Qwen3.8-27B');
const client = new RunnerAgentClient(config.controlSocket, config.controlToken);
try {
  assert.equal(
    (await client.listTasks()).activeTaskIds.length,
    0,
    'Another production agent is active.'
  );
} finally {
  await client.close();
}
const telemetry: Array<{ requestId: string; outcome: string }> = [];
const project = { id: randomUUID(), workdir: '.' } as AgentProject;
const runId = randomUUID();
const sandbox = createDurableEnvironment(config, project, workspace, runId.replaceAll('-', ''));
let screenshots = 0;
const manager = new DurableAgentManager({
  runId,
  requestId: randomUUID(),
  provider: config.provider,
  model: config.model,
  thinkingLevel: 'low',
  models: await createLocalModels(config, (sample) => telemetry.push(sample)),
  storagePath: join(root, 'conversation.sqlite'),
  instructions:
    'Nutze für diese Prüfung nur browser_open, nicht read oder bash. Schau den erhaltenen Screenshot an und antworte kurz auf Deutsch.',
  env: sandbox.env,
  browser: true,
  desktop: visible,
  closeEnvironment: () => sandbox.close(),
  onImage(input) {
    screenshots++;
    writeFileSync(join(root, 'image-' + screenshots + '.png'), input.data);
    const image = validateAgentImage(input.mimeType, input.data);
    assert(image.ok, image.reason);
    assert.ok(input.data.byteLength > 1000);
    return {
      id: randomUUID(),
      runId,
      mimeType: input.mimeType,
      byteLength: input.data.byteLength,
      width: image.width,
      height: image.height,
    };
  },
});
try {
  const server = getOrThrow(
    await sandbox.env.exec(
      ['/usr/bin/bash', '-lc', '/usr/bin/node /workspace/preview.cjs >/tmp/preview.log 2>&1 &'],
      { timeout: 5 },
      BACKGROUND_CONTEXT
    )
  );
  assert.equal(server.exitCode, 0);
  await manager.start({
    task: visible
      ? 'Öffne http://127.0.0.1:8123 zuerst mit browser_open ohne browser-Parameter (Standard Chromium) und danach mit browser_open browser=firefox. Welche Farbe hat das große Quadrat auf beiden Screenshots? Nutze beide Browser und die Bildansicht, keinen Quellcode. Arbeite allein ohne Subagenten.'
      : 'Öffne http://127.0.0.1:8123 mit browser_open. Welche Farbe hat das große Quadrat auf dem Screenshot? Nutze die Bildansicht und keinen Quellcode.',
  });
  const deadline = Date.now() + 120_000;
  while (!['settled', 'failed'].includes(manager.snapshot().status)) {
    if (Date.now() > deadline) throw new Error('Browser qualification timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
  const result = manager.snapshot();
  assert.equal(result.status, 'settled', result.reason);
  assert.ok(screenshots >= (visible ? 2 : 1), JSON.stringify(result));
  if (visible) {
    const opens = result.timeline.filter((item) => item.toolName === 'browser_open');
    assert(
      opens.some((item) => item.argumentsText?.includes('firefox')),
      'Firefox was not used.'
    );
    assert(
      opens.some((item) => !item.argumentsText?.includes('firefox')),
      'Default Chromium was not used.'
    );
  }
  assert(telemetry.length > 0 && telemetry.every((sample) => sample.outcome === 'completed'));
  await writeFile(join(root, 'trace.json'), JSON.stringify(result, null, 2));
  await writeFile(join(root, 'telemetry.json'), JSON.stringify(telemetry, null, 2));
  const answer = result.timeline.filter((item) => item.kind === 'assistant').at(-1)?.text ?? '';
  assert.match(answer, /magenta|pink|rosa|violett|fuchsia|lila/i);
  console.log(
    JSON.stringify({
      passed: true,
      screenshots,
      answer,
      root,
      isolatedBrowser: true,
      visible,
      requestIds: telemetry.map((sample) => sample.requestId),
    })
  );
} finally {
  await manager.close();
}
