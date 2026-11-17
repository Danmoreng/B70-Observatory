/** Operator-only real Qwen/Durable acceptance. No production task or service changes. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadRunnerConfig } from '../packages/server/dist/runner/config.js';
import { createLocalModels } from '../packages/server/dist/durable/model.js';
import { createDurableEnvironment } from '../packages/server/dist/durable/environment.js';
import { DurableAgentManager } from '../packages/server/dist/durable/manager.js';
import { RunnerAgentClient } from '../packages/server/dist/agent/runner-client.js';
import { validateAgentImage } from '../packages/runner/dist/index.js';

const dashboard = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[2] ?? join(dashboard, 'build/desktop-agent-acceptance'));
assert(
  !existsSync(join(output, 'conversation.sqlite')),
  'Use a fresh output directory for each trial.'
);
mkdirSync(join(output, 'images'), { recursive: true, mode: 0o700 });
const workspace = join(output, 'workspace');
mkdirSync(workspace, { mode: 0o700 });
cpSync(
  join(dashboard, 'packages/runner/test/fixtures/desktop/canvas.cpp'),
  join(workspace, 'canvas.cpp')
);
const operator = parseEnv(
  readFileSync('data/runner.env', 'utf8')
);
const config = loadRunnerConfig({
  ...operator,
  B70_RUNNER_ENGINE: 'pi-durable',
  B70_RUNNER_SUPPORT_ROOT: join(dashboard, 'build/observatory-release/runtime'),
  B70_RUNNER_BROWSER_RUNTIME_ROOT: undefined,
  B70_RUNNER_DESKTOP_ENABLED: '1',
  B70_RUNNER_NPM_ENABLED: 'false',
});
assert.equal(config.model, 'Qwen3.8-27B', 'Use the qualified default model only.');
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
const runId = randomUUID();
const requestId = randomUUID();
const telemetry = [];
const models = await createLocalModels(config, (sample) => {
  telemetry.push(sample);
  writeFileSync(join(output, 'telemetry.json'), JSON.stringify(telemetry, null, 2));
});
assert(models.getModel(config.provider, config.model).input.includes('image'));
const environment = createDurableEnvironment(
  config,
  { workdir: '.' },
  workspace,
  randomBytes(16).toString('hex')
);
let imageCount = 0;
const manager = new DurableAgentManager({
  runId,
  requestId,
  models,
  provider: config.provider,
  model: config.model,
  thinkingLevel: config.thinkingLevel,
  storagePath: join(output, 'conversation.sqlite'),
  instructions:
    'Arbeite allein ohne Subagenten. Nutze die angebotenen Desktop-Werkzeuge für visuelle Tests nativer Anwendungen. Keine Systemkonfiguration ändern. Die feste Arbeitsgrenze ist 23:00 Europe/Berlin; ab 22:45 keine neuen Arbeiten.',
  env: environment.env,
  browser: false,
  desktop: true,
  closeEnvironment: environment.close,
  onImage({ mimeType, data }) {
    const checked = validateAgentImage(mimeType, data);
    assert(checked.ok, checked.reason);
    const id = randomUUID();
    writeFileSync(join(output, 'images', id + '.png'), data);
    imageCount++;
    return {
      id,
      runId,
      mimeType: checked.mimeType,
      width: checked.width,
      height: checked.height,
      byteLength: checked.byteLength,
    };
  },
});
const started = Date.now();
let last = 0;
manager.subscribe(() => {
  if (Date.now() - last < 10_000) return;
  last = Date.now();
  const state = manager.snapshot();
  console.log(
    JSON.stringify({
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      status: state.status,
      events: state.timeline.length,
      images: imageCount,
      requests: telemetry.length,
    })
  );
});
try {
  await manager.start({
    name: 'Native Desktop-Abnahme mit Qwen 27B',
    task: 'Baue die vorhandene native Anwendung canvas.cpp mit g++ und -lX11 als ./canvas. Verändere den Quellcode nicht. Starte deinen eigenen Desktop und die Anwendung mit den Desktop-Werkzeugen. Sieh dir das Fenster an. Klicke auf die Schaltfläche "Click to turn green", tippe danach Qwen27B ins Fenster und scrolle dort zweimal nach unten (amount 2). Kontrolliere den sichtbaren Endzustand mit einem Screenshot. Beschreibe auf Deutsch, welche Farbe die Schaltfläche vor und nach deinem Klick hatte und welchen eingegebenen Text du siehst. Benutze Screenshots und echte Desktop-Eingaben. Lass die Anwendung für die abschließende Prüfung geöffnet. Arbeite allein ohne Subagenten.',
  });
  while (['starting', 'running'].includes(manager.snapshot().status)) {
    if (Date.now() - started > 12 * 60_000)
      throw new Error('Bounded desktop agent trial timed out.');
    await new Promise((accept) => setTimeout(accept, 1000));
  }
  const state = manager.snapshot();
  writeFileSync(join(output, 'trace.json'), JSON.stringify(state, null, 2));
  assert.equal(state.status, 'settled', state.reason);
  const source = readFileSync(join(dashboard, 'packages/runner/test/fixtures/desktop/canvas.cpp'));
  assert(
    source.equals(readFileSync(join(workspace, 'canvas.cpp'))),
    'Agent modified the test fixture.'
  );
  const actual = readFileSync(join(workspace, 'canvas-state.txt'), 'utf8');
  assert.equal(actual.split('\n')[0], '1', actual);
  assert(Number(actual.split('\n')[1]) >= 2, actual);
  assert(actual.includes('Qwen27B'), actual);
  assert(imageCount >= 4, 'Desktop images did not reach the persisted trace.');
  assert(telemetry.length > 0 && telemetry.every((sample) => sample.outcome === 'completed'));
  const database = new DatabaseSync(
    'data/observatory.db',
    { readOnly: true }
  );
  let central;
  try {
    central = telemetry.map((sample) =>
      database
        .prepare('SELECT id,status,origin,promptTokens,completionTokens FROM requests WHERE id=?')
        .get(sample.requestId)
    );
  } finally {
    database.close();
  }
  assert(
    central.every((row) => row?.status === 'completed' && row.origin === 'pi'),
    'Gateway correlation missing.'
  );
  const answer = state.timeline.filter((item) => item.kind === 'assistant').at(-1)?.text ?? '';
  writeFileSync(join(output, 'answer.txt'), answer);
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        runId,
        model: config.model,
        durationSeconds: (Date.now() - started) / 1000,
        imageCount,
        requestCount: telemetry.length,
        central,
        nativeState: actual,
        answer,
        productionChanged: false,
      },
      null,
      2
    )
  );
} catch (error) {
  writeFileSync(join(output, 'trace.json'), JSON.stringify(manager.snapshot(), null, 2));
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify(
      {
        passed: false,
        error: String(error),
        runId,
        durationSeconds: (Date.now() - started) / 1000,
        imageCount,
        requestCount: telemetry.length,
      },
      null,
      2
    )
  );
  throw error;
} finally {
  await manager.close();
  const state = manager.snapshot();
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );
  const trace = state.timeline
    .map(
      (item) =>
        `<article><h2>${escape(item.kind)} · ${escape(item.title)}</h2><pre>${escape(item.text)}</pre>${(item.images ?? []).map((image) => `<img src="images/${image.id}.png" alt="Desktop Screenshot" width="${image.width}" height="${image.height}">`).join('')}</article>`
    )
    .join('\n');
  writeFileSync(
    join(output, 'trace.html'),
    `<!doctype html><meta charset="utf-8"><title>Qwen 27B Desktop-Abnahme</title><style>body{font:16px system-ui;max-width:1280px;margin:32px auto;padding:16px;background:#172026;color:#e8edf1}article{border-top:1px solid #53616a;padding:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;height:auto}h2{font-size:17px}</style><h1>Qwen 27B · nativer Desktop</h1>${trace}`
  );
}
console.log(readFileSync(join(output, 'report.json'), 'utf8'));
