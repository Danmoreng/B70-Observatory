import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reduceAgentTimeline,
  type AgentStreamEvent,
  type AgentTimelineImage,
  type AgentTimelineItem,
} from '@observatory/contracts';
import { TaskStoreError } from '../../src/runner/task-store.js';
import {
  AgentControlError,
  buildAgentEnvironment,
  JsonlDecoder,
  PiAgentManager,
} from '../../src/agent/manager.js';

const tempDirs: string[] = [];

function fakePi(): { executable: string; workspace: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'observatory-agent-'));
  tempDirs.push(workspace);
  const executable = join(workspace, 'fake-pi.mjs');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let buffer = '';
process.stdin.setEncoding('utf8');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
    const index = buffer.indexOf('\\n');
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    appendFileSync('commands.jsonl', JSON.stringify(command) + '\\n');
    if (command.type === 'prompt') {
      send({ id: command.id, type: 'response', command: 'prompt', success: true });
      send({ type: 'agent_start' });
      send({ type: 'turn_start' });
      send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Prüfe\\u2028Datei' } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Prüfe\\u2028Datei' } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Ich arbeite.' } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'Ich arbeite.' } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, id: 'call-1', toolName: 'write' } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2, toolCall: { id: 'call-1', name: 'write', arguments: { path: 'src/fix.ts', content: 'fixed' } } } });
      send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args: { path: 'src/fix.ts', content: 'fixed' } });
      send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'write', result: { content: [{ type: 'text', text: 'Wrote src/fix.ts' }], details: { bytes: 5 } }, isError: false });
    } else if (command.type === 'steer') {
      send({ id: command.id, type: 'response', command: 'steer', success: true });
      send({ type: 'queue_update', steering: [command.message], followUp: [] });
      send({ type: 'message_start', message: { role: 'user', content: command.message } });
      send({ type: 'queue_update', steering: [], followUp: [] });
      send({ type: 'agent_settled' });
    } else if (command.type === 'get_state') {
      send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { model: { id: 'Qwen3.8-27B' }, thinkingLevel: 'medium', sessionName: 'Cockpit test' } });
    } else if (command.type === 'clear_queue' || command.type === 'abort') {
      send({ id: command.id, type: 'response', command: command.type, success: true });
    }
  }
});
`,
    { mode: 0o700 }
  );
  chmodSync(executable, 0o700);
  return { executable, workspace };
}

function scriptedPi(events: Array<unknown | string>): { executable: string; workspace: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'observatory-agent-outcome-'));
  tempDirs.push(workspace);
  const executable = join(workspace, 'scripted-pi.mjs');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
let buffer = '';
const events = ${JSON.stringify(events)};
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
    const index = buffer.indexOf('\\n');
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === 'prompt') {
      send({ id: command.id, type: 'response', command: 'prompt', success: true });
      send({ type: 'agent_start' });
      for (const event of events) {
        if (typeof event === 'string' && event.startsWith('STDERR:')) process.stderr.write(event.slice(7) + '\\n');
        else if (typeof event === 'string') process.stdout.write(event + '\\n');
        else send(event);
      }
      setTimeout(() => process.stdout.write('', () => process.exit(0)), 5);
    } else if (command.type === 'get_state') {
      send({ id: command.id, type: 'response', command: 'get_state', success: true, data: {} });
    }
  }
});
`,
    { mode: 0o700 }
  );
  chmodSync(executable, 0o700);
  return { executable, workspace };
}

function rejectingPi(message: string): { executable: string; workspace: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'observatory-agent-rejection-'));
  tempDirs.push(workspace);
  const executable = join(workspace, 'rejecting-pi.mjs');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split('\\n').filter(Boolean)) {
    const command = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: false, error: ${JSON.stringify(message)} }) + '\\n');
  }
});
`,
    { mode: 0o700 }
  );
  chmodSync(executable, 0o700);
  return { executable, workspace };
}

function managerFor(config: { executable: string; workspace: string }): PiAgentManager {
  return new PiAgentManager({
    ...config,
    provider: 'b70-vllm',
    model: 'Qwen3.8-27B',
    thinkingLevel: 'medium',
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not reached');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sub-agent trace forwarding', () => {
  it('persists child thinking, tool arguments/results and text without changing the main run identity', async () => {
    const nested = (event: unknown) => ({
      type: 'extension_ui_request',
      method: 'notify',
      message: JSON.stringify({
        type: 'b70_subagent_event',
        agentId: '1234567890abcdef',
        name: 'Rules',
        event,
      }),
    });
    const fake = scriptedPi([
      'STDERR:{"type":"diagnostic","payload":"internal Pi state"}',
      nested({ type: 'agent_start' }),
      nested({ type: 'turn_start' }),
      nested({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Check rules independently' }],
        },
      }),
      nested({
        type: 'tool_execution_start',
        toolCallId: 'child-call',
        toolName: 'bash',
        args: { command: 'npm test' },
      }),
      nested({
        type: 'tool_execution_end',
        toolCallId: 'child-call',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'Tests passed' }] },
      }),
      nested({ type: 'turn_start' }),
      nested({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Rules completed' }] },
      }),
      nested({ type: 'agent_settled' }),
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Integrated result' }] },
      },
      { type: 'agent_settled' },
    ]);
    const manager = new PiAgentManager({
      ...fake,
      provider: 'test',
      model: 'test',
      thinkingLevel: 'off',
    });
    try {
      await manager.start({ task: 'Use child agents' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const snapshot = manager.snapshot();
      expect(snapshot.status).toBe('settled');
      expect(snapshot.subagents).toEqual([
        { id: '1234567890abcdef', name: 'Rules', status: 'completed' },
      ]);
      expect(snapshot.timeline.some((item) => item.title === 'Pi-Diagnose')).toBe(false);
      expect(snapshot.timeline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'thinking',
            text: 'Check rules independently',
            agent: { id: '1234567890abcdef', name: 'Rules' },
          }),
          expect.objectContaining({
            kind: 'tool',
            argumentsText: expect.stringContaining('npm test'),
            outputText: expect.stringContaining('Tests passed'),
          }),
          expect.objectContaining({
            kind: 'assistant',
            text: expect.stringContaining('Rules completed'),
          }),
        ])
      );
    } finally {
      await manager.close();
    }
  });
});

describe('bounded trace streaming', () => {
  it('evicts live items using small deltas, preserving replay without repeated full snapshots', async () => {
    const fake = scriptedPi([
      ...Array.from({ length: 120 }, (_, index) => [
        { type: 'turn_start' },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `${index}:` + 'x'.repeat(16_000) }],
          },
        },
      ]).flat(),
      { type: 'agent_settled' },
    ]);
    const events: AgentStreamEvent[] = [];
    const manager = new PiAgentManager({
      ...fake,
      provider: 'test',
      model: 'test',
      thinkingLevel: 'off',
      maxTimelineItems: 8,
    });
    manager.subscribe((event) => events.push(event));
    try {
      await manager.start({ task: 'Stream a long task' });
      await eventually(() => manager.snapshot().status === 'settled');
      let timeline: AgentTimelineItem[] = [];
      for (const event of events) timeline = reduceAgentTimeline(timeline, event);
      expect(timeline).toEqual(manager.snapshot().timeline);
      expect(events.filter((event) => event.operation === 'reset')).toHaveLength(1);
      expect(events.some((event) => 'prunedItemIds' in event && event.prunedItemIds?.length)).toBe(
        true
      );
      expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThan(3 * 1024 * 1024);
    } finally {
      await manager.close();
    }
  });
});

describe('PiAgentManager', () => {
  it('requires the durable event sink before spawning or publishing a run', async () => {
    let spawned = false;
    let published = false;
    const manager = new PiAgentManager({
      executable: '/unused',
      workspace: '/unused',
      provider: 'b70-vllm',
      model: 'Qwen3.8-27B',
      thinkingLevel: 'medium',
      beforePublish: () => {
        throw new AgentControlError('unavailable', 'durable storage unavailable');
      },
      spawnProcess: () => {
        spawned = true;
        throw new Error('must not spawn');
      },
    });
    manager.subscribe(() => {
      published = true;
    });

    await expect(manager.start({ task: 'Must persist first' })).rejects.toThrow(
      'durable storage unavailable'
    );
    expect(spawned).toBe(false);
    expect(published).toBe(false);
    await manager.close();
  });

  it('preserves a bounded Pi preflight rejection for operator diagnosis', async () => {
    const manager = managerFor(rejectingPi('configured model is unavailable'));
    await expect(manager.start({ task: 'diagnose' })).rejects.toThrow(
      'Pi rejected the RPC command: configured model is unavailable'
    );
    await manager.close();
  });

  it('does not pass Observatory configuration or credentials to Pi', () => {
    const previous = process.env.OBSERVATORY_PASSWORD_HASH;
    process.env.OBSERVATORY_PASSWORD_HASH = 'sentinel-secret';
    try {
      const environment = buildAgentEnvironment('/safe/profile');
      expect(environment.OBSERVATORY_PASSWORD_HASH).toBeUndefined();
      expect(environment.PI_OFFLINE).toBe('1');
      expect(environment.PI_CODING_AGENT_DIR).toBe('/safe/profile');
    } finally {
      if (previous === undefined) delete process.env.OBSERVATORY_PASSWORD_HASH;
      else process.env.OBSERVATORY_PASSWORD_HASH = previous;
    }
  });

  it('uses strict LF framing and keeps Unicode line separators inside a record', () => {
    const lines: string[] = [];
    const decoder = new JsonlDecoder((line) => lines.push(line));
    decoder.push(Buffer.from('{"text":"a\u2028b"}\r'));
    decoder.push(Buffer.from('\n{"text":"c"}\n'));
    decoder.end();
    expect(lines).toEqual(['{"text":"a\u2028b"}', '{"text":"c"}']);
  });

  it('rejects oversized complete records before delivering them for every chunk layout', () => {
    const limit = 8 * 1024 * 1024;
    for (const chunks of [
      ['x'.repeat(limit + 1) + '\n'],
      ['x'.repeat(limit), 'x\n'],
      [Buffer.from('x'.repeat(limit)), Buffer.from('x\n')],
    ]) {
      const lines: string[] = [];
      const decoder = new JsonlDecoder((line) => lines.push(line));
      expect(() => {
        for (const chunk of chunks) decoder.push(chunk);
      }).toThrowError(/oversized RPC record/);
      expect(lines).toEqual([]);
    }
  });

  it('rejects an oversized final record without LF before delivering it', () => {
    const limit = 8 * 1024 * 1024;
    const lines: string[] = [];
    const decoder = new JsonlDecoder((line) => lines.push(line));
    // StringDecoder retains the incomplete leading byte until end(). The
    // replacement character then makes the final record exceed the byte cap.
    decoder.push(Buffer.concat([Buffer.alloc(limit - 1, 0x78), Buffer.from([0xc3])]));
    expect(() => decoder.end()).toThrowError(/oversized RPC record/);
    expect(lines).toEqual([]);
  });

  it('accepts exact byte limits, CRLF and multiple valid records in one chunk', () => {
    const limit = 8 * 1024 * 1024;
    const exact = 'é'.repeat(limit / 2);
    const lines: string[] = [];
    const decoder = new JsonlDecoder((line) => lines.push(line));
    decoder.push(`${exact}\r\nok\n`);
    decoder.end();
    expect(Buffer.byteLength(lines[0] ?? '', 'utf8')).toBe(limit);
    expect(lines).toEqual([exact, 'ok']);
  });

  it('marks a normal settled run as ended but explicitly unverified', async () => {
    const manager = managerFor(
      scriptedPi([
        {
          type: 'message_end',
          message: { role: 'assistant', content: [], stopReason: 'stop' },
        },
        { type: 'agent_settled' },
      ])
    );
    await manager.start({ task: 'Finish normally' });
    await eventually(() => manager.snapshot().status === 'settled');
    expect(manager.snapshot()).toMatchObject({
      status: 'settled',
      reason: expect.stringContaining('checks'),
    });
    await manager.close();
  });

  it('keeps a final model error failed even when Pi exits with code zero', async () => {
    const manager = managerFor(
      scriptedPi([
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'provider failed',
          },
        },
        { type: 'agent_settled' },
      ])
    );
    await manager.start({ task: 'Expose the final model error' });
    await eventually(() => manager.snapshot().status === 'failed');
    expect(manager.snapshot()).toMatchObject({
      status: 'failed',
      reason: 'Pi ended with a model error.',
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(manager.snapshot().status).toBe('failed');
    await manager.close();
  });

  it('treats a corrected tool error as history rather than a terminal failure', async () => {
    const manager = managerFor(
      scriptedPi([
        {
          type: 'tool_execution_end',
          toolCallId: 'failed-tool',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'first attempt failed' }] },
          isError: true,
        },
        {
          type: 'message_end',
          message: { role: 'assistant', content: [], stopReason: 'stop' },
        },
        { type: 'agent_settled' },
      ])
    );
    await manager.start({ task: 'Recover from a tool error' });
    await eventually(() => manager.snapshot().status === 'settled');
    expect(manager.snapshot().timeline).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'tool', state: 'error' })])
    );
    expect(manager.snapshot().reason).toContain('checks');
    await manager.close();
  });

  it('does not hide invalid terminal protocol data behind agent_settled', async () => {
    const manager = managerFor(scriptedPi(['not-json', { type: 'agent_settled' }]));
    await manager.start({ task: 'Reject invalid RPC' });
    await eventually(() => manager.snapshot().status === 'failed');
    expect(manager.snapshot()).toMatchObject({
      status: 'failed',
      reason: 'Pi sent invalid JSON on the RPC channel.',
    });
    await manager.close();
  });

  it('assembles visible reasoning, assistant text, tool arguments and output in memory', async () => {
    const config = fakePi();
    const manager = new PiAgentManager({
      ...config,
      provider: 'b70-vllm',
      model: 'Qwen3.8-27B',
      thinkingLevel: 'medium',
    });
    const operations: string[] = [];
    manager.subscribe((event) => operations.push(event.operation));

    const started = await manager.start({ task: 'Fix the chart', name: 'Cockpit test' });
    expect(['starting', 'running']).toContain(started.status);
    await eventually(() =>
      manager.snapshot().timeline.some((item) => item.kind === 'tool' && item.state === 'complete')
    );
    const snapshot = manager.snapshot();

    expect(snapshot.task).toBe('Fix the chart');
    expect(snapshot.timeline.find((item) => item.kind === 'thinking')?.text).toBe(
      'Prüfe\u2028Datei'
    );
    expect(snapshot.timeline.find((item) => item.kind === 'assistant')?.text).toBe('Ich arbeite.');
    const tool = snapshot.timeline.find((item) => item.kind === 'tool');
    expect(tool?.title).toContain('src/fix.ts');
    expect(tool?.argumentsText).toContain('"content": "fixed"');
    expect(tool?.outputText).toContain('Wrote src/fix.ts');
    expect(tool?.text).toBeUndefined();
    expect(tool?.state).toBe('complete');
    expect(tool?.durationMs).toEqual(expect.any(Number));
    expect(operations).toContain('append_text');

    await manager.close();
  });

  it('allows only one concurrent start and isolates failing live listeners', async () => {
    const config = fakePi();
    const manager = new PiAgentManager({
      ...config,
      provider: 'b70-vllm',
      model: 'Qwen3.8-27B',
      thinkingLevel: 'medium',
    });
    manager.subscribe(() => {
      throw new Error('disconnected browser');
    });

    const first = manager.start({ task: 'First task' });
    const second = manager.start({ task: 'Second task' });
    await expect(second).rejects.toEqual(expect.any(AgentControlError));
    await expect(first).resolves.toMatchObject({ task: 'First task' });
    await eventually(() => manager.snapshot().timeline.some((item) => item.kind === 'tool'));

    await manager.close();
  });

  it('queues a steering comment and marks it delivered when Pi consumes it', async () => {
    const config = fakePi();
    const manager = new PiAgentManager({
      ...config,
      provider: 'b70-vllm',
      model: 'Qwen3.8-27B',
      thinkingLevel: 'medium',
    });
    await manager.start({ task: 'Review this repository' });
    await eventually(() => manager.snapshot().status === 'running');
    await manager.steer({
      runId: manager.snapshot().runId!,
      expectedRunVersion: 1,
      expectedTaskVersion: 1,
      message: 'Do not change the public API.',
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    });
    await eventually(() => manager.snapshot().status === 'settled');

    const snapshot = manager.snapshot();
    const steering = snapshot.timeline.find((item) => item.kind === 'steering');
    expect(steering).toMatchObject({
      title: 'Dein Kommentar · zugestellt',
      text: 'Do not change the public API.',
      state: 'complete',
    });
    expect(snapshot.pendingSteering).toBe(0);

    await manager.close();
  });

  it('cancels the exact run and escalates to its complete job scope', async () => {
    const config = fakePi();
    let stopped = 0;
    const manager = new PiAgentManager({
      ...config,
      provider: 'b70-vllm',
      model: 'Qwen3.8-27B',
      thinkingLevel: 'medium',
      runId: '25252525-2525-4525-8525-252525252525',
      stopJob: async () => {
        stopped += 1;
      },
    });
    await manager.start({ task: 'Long task' });
    await eventually(() => manager.snapshot().status === 'running');
    const result = await manager.cancel({
      runId: '25252525-2525-4525-8525-252525252525',
      expectedRunVersion: 2,
      expectedTaskVersion: 1,
      idempotencyKey: '26262626-2626-4626-8626-262626262626',
    });
    expect(result.status).toBe('cancelled');
    expect(stopped).toBe(1);
    await manager.close();
  });
});

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('PiAgentManager image results', () => {
  function imageManager(options: {
    onImage?: (input: { mimeType: string; data: Buffer; label?: string }) => AgentTimelineImage;
    payload?: unknown;
  }) {
    const runId = '27272727-2727-4727-8727-272727272727';
    const published: unknown[] = [];
    const manager = new PiAgentManager({
      ...scriptedPi([
        {
          type: 'tool_execution_start',
          toolCallId: 'call-shot',
          toolName: 'browser_screenshot',
          args: { label: 'Vorschau' },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'call-shot',
          toolName: 'browser_screenshot',
          args: { label: 'Vorschau' },
          result: options.payload,
          isError: false,
        },
        { type: 'agent_settled' },
      ]),
      provider: 'b70-vllm',
      model: 'Qwen3.8-27B',
      thinkingLevel: 'medium',
      runId,
      onImage: options.onImage,
      beforePublish: (event) => {
        published.push(event);
      },
    });
    return { manager, published, runId };
  }

  it('attaches strict metadata to the tool item without leaking base64 into any trace event', async () => {
    const stored: Array<{ mimeType: string; data: Buffer; label?: string }> = [];
    const { manager, published, runId } = imageManager({
      onImage: (input) => {
        stored.push(input);
        return {
          id: '30303030-3030-4030-8030-303030303030',
          runId,
          mimeType: 'image/png',
          byteLength: input.data.length,
          width: 1,
          height: 1,
          label: input.label,
        };
      },
      payload: {
        content: [
          { type: 'text', text: 'Screenshot „Vorschau“ · Bild an Agenten zurückgegeben.' },
          { type: 'image', mimeType: 'image/png', data: PNG_1X1 },
        ],
      },
    });
    await manager.start({ task: 'Take a screenshot' });
    await eventually(() => manager.snapshot().status === 'settled');

    const item = manager.snapshot().timeline.find((entry) => entry.toolCallId === 'call-shot');
    expect(item?.images).toEqual([
      {
        id: '30303030-3030-4030-8030-303030303030',
        runId,
        mimeType: 'image/png',
        byteLength: stored[0]!.data.length,
        width: 1,
        height: 1,
        label: 'Vorschau',
      },
    ]);
    expect(stored).toHaveLength(1);
    const traceText = JSON.stringify(published);
    expect(traceText).not.toContain(PNG_1X1);
    expect(item?.outputText).toContain('[Image result]');
    await manager.close();
  });

  it('accepts multi-megabyte image records after raising the RPC framing limit', async () => {
    const { manager, runId } = imageManager({
      onImage: (input) => ({
        id: '31313131-3131-4131-8131-313131313131',
        runId,
        mimeType: 'image/png',
        byteLength: input.data.length,
        width: 1,
        height: 1,
      }),
      payload: {
        content: [
          // 2.5 MiB of base64 exceeds the former RPC bound but decodes to <2 MiB.
          { type: 'image', mimeType: 'image/png', data: 'A'.repeat(5 * 512 * 1024) },
        ],
      },
    });
    await manager.start({ task: 'Large image round trip' });
    await eventually(() => manager.snapshot().status === 'settled');
    const item = manager.snapshot().timeline.find((entry) => entry.toolCallId === 'call-shot');
    expect(item?.images).toHaveLength(1);
    expect(manager.snapshot().status).toBe('settled');
    await manager.close();
  });

  it('stops on a run storage budget failure and retains the precise reason', async () => {
    const reason = 'Speicherbudget des Laufs erreicht: 2048 MiB Budget.';
    const { manager } = imageManager({
      onImage: () => {
        throw new TaskStoreError('storage_budget', reason);
      },
      payload: { content: [{ type: 'image', mimeType: 'image/png', data: PNG_1X1 }] },
    });
    await manager.start({ task: 'Budget case' });
    await eventually(() => manager.snapshot().status === 'failed');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.snapshot().status).toBe('failed');
    expect(manager.snapshot().reason).toBe(reason);
    expect(
      manager.snapshot().timeline.find((item) => item.title === 'Bild nicht gespeichert')?.text
    ).toBe(reason);
    await manager.close();
  });

  it('keeps the run usable when the image sink rejects the content', async () => {
    const { manager, runId } = imageManager({
      onImage: () => {
        throw new Error('quota exceeded');
      },
      payload: {
        content: [
          { type: 'text', text: 'Screenshot' },
          { type: 'image', mimeType: 'image/png', data: PNG_1X1 },
        ],
      },
    });
    await manager.start({ task: 'Quota case' });
    await eventually(() => manager.snapshot().status === 'settled');
    const item = manager.snapshot().timeline.find((entry) => entry.toolCallId === 'call-shot');
    expect(item?.images).toBeUndefined();
    expect(
      manager.snapshot().timeline.some((entry) => entry.title === 'Bild nicht gespeichert')
    ).toBe(true);
    void runId;
    await manager.close();
  });
});

describe('user reference image input', () => {
  it('delivers all four images to Pi and publishes only clickable metadata', async () => {
    const config = fakePi();
    const events: AgentStreamEvent[] = [];
    const runId = '27272727-2727-4727-8727-272727272727';
    const sink = vi.fn(
      (input: { mimeType: string; data: Buffer; label?: string }): AgentTimelineImage => ({
        id: '28282828-2828-4828-8828-282828282828',
        runId,
        mimeType: 'image/png',
        byteLength: input.data.length,
        width: 1,
        height: 1,
        label: input.label,
      })
    );
    const manager = new PiAgentManager({
      ...config,
      provider: 'fixture',
      model: 'fixture',
      thinkingLevel: 'off',
      runId,
      onInputImage: sink,
      beforePublish: (event) => {
        events.push(event);
      },
    });
    const images = Array.from({ length: 4 }, (_, i) => ({
      mimeType: 'image/png' as const,
      data: PNG_1X1,
      label: `Referenz ${i + 1}`,
    }));
    try {
      await manager.start({ task: 'Vergleiche diese Ansichten', images });
      const commands = readFileSync(join(config.workspace, 'commands.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; images?: unknown[] });
      expect(commands.find((command) => command.type === 'prompt')?.images).toEqual(
        images.map(({ mimeType, data }) => ({ type: 'image', mimeType, data }))
      );
      expect(sink).toHaveBeenCalledTimes(4);
      expect(manager.snapshot().timeline.find((item) => item.kind === 'task')?.images).toHaveLength(
        4
      );
      expect(JSON.stringify(events)).not.toContain(PNG_1X1);
    } finally {
      await manager.close();
    }
  });
  it('rejects corrupt or over-budget reference bytes before spawning Pi', async () => {
    const spawnProcess = vi.fn();
    const manager = new PiAgentManager({
      executable: '/usr/bin/false',
      workspace: '/tmp',
      provider: 'fixture',
      model: 'fixture',
      thinkingLevel: 'off',
      spawnProcess,
    });
    for (const data of ['AAAA', Buffer.alloc(1024 * 1024 + 1).toString('base64')]) {
      await expect(
        manager.start({
          task: 'Fail closed',
          images: [{ mimeType: 'image/png', data, label: 'Bad' }],
        })
      ).rejects.toThrow('Invalid model image copy');
    }
    expect(spawnProcess).not.toHaveBeenCalled();
    await manager.close();
  });
});

describe('large repeated turn-end history', () => {
  it.each(['stop', 'error'])(
    'retains the real assistant outcome %s across a large aggregate',
    async (stopReason) => {
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Finaler Bericht bleibt sichtbar.' }],
        stopReason,
        ...(stopReason === 'error' ? { errorMessage: 'Real model failure' } : {}),
      };
      const manager = managerFor(
        scriptedPi([
          { type: 'agent_start' },
          { type: 'message_end', message },
          {
            type: 'agent_end',
            messages: [
              {
                role: 'toolResult',
                content: [{ type: 'image', data: 'A'.repeat(9 * 1024 * 1024) }],
              },
              message,
            ],
            willRetry: false,
          },
          { type: 'agent_settled' },
        ])
      );
      try {
        await manager.start({ task: 'Finish a long visual task' });
        await eventually(() => ['settled', 'failed'].includes(manager.snapshot().status));
        expect(manager.snapshot().status).toBe(stopReason === 'stop' ? 'settled' : 'failed');
        expect(manager.snapshot().reason ?? '').not.toContain('framing');
        expect(
          manager.snapshot().timeline.some((item) => item.text?.includes('Finaler Bericht'))
        ).toBe(true);
      } finally {
        await manager.close();
      }
    }
  );
});
