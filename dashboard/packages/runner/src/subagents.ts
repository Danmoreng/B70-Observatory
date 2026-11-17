import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RpcJsonlDecoder } from './rpc-jsonl.js';

interface ChildAgent {
  id: string;
  name: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'stopped';
  child: ChildProcessWithoutNullStreams;
  result: string;
  error?: string;
}
export interface SubagentOptions {
  executable: string;
  profileRoot: string;
  temporaryRoot: string;
  workspace: string;
  provider: string;
  model: string;
  thinking: string;
  browser: boolean;
  onEvent(agentId: string, name: string, event: Record<string, unknown>): void;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Child processes share the parent's mount/network/cgroup namespaces; no host launcher exists here. */
export class SubagentPool {
  private readonly agents = new Map<string, ChildAgent>();
  private spawning = 0;
  private closed = false;
  constructor(private readonly options: SubagentOptions) {}

  list() {
    return [...this.agents.values()].map(({ id, name, status, result, error }) => ({
      id,
      name,
      status,
      result,
      ...(error ? { error } : {}),
    }));
  }
  async start(name: string, task: string) {
    if (this.closed || this.agents.size + this.spawning >= 2)
      throw new Error(
        'At most two sub-agents are available per task. Reuse an existing agent with send_agent.'
      );
    if (!name.trim() || name.length > 80 || !task.trim() || task.length > 32768)
      throw new Error('Invalid sub-agent name or task size.');
    this.spawning++;
    try {
      const id = randomBytes(8).toString('hex');
      const profile = join(this.options.temporaryRoot, id);
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await copyFile(join(this.options.profileRoot, 'models.json'), join(profile, 'models.json'));
      await writeFile(join(profile, 'auth.json'), '{}\n', { mode: 0o600 });
      const inherited = await readFile(
        join(this.options.profileRoot, 'agent-system-prompt-append.txt'),
        'utf8'
      ).catch(() => '');
      const instructions = `${inherited}\nYou are sub-agent ${name}. Work only on your assigned task in the shared workspace. Other agents work concurrently: respect their files and coordinate conflicts through your final report. Do not commit, reset, clean, spawn more agents, or alter AGENTS.md/package-lock.json/package.json unless explicitly assigned. Delegate package changes to the main agent by default. Report concrete changes, checks and remaining issues. Never ask the user directly.\n`;
      const promptPath = join(profile, 'instructions.txt');
      await writeFile(promptPath, instructions, { mode: 0o600 });
      if (this.closed) throw new Error('Sub-agent pool is shutting down.');
      const args = [
        '--mode',
        'rpc',
        '--no-session',
        '--offline',
        '--provider',
        this.options.provider,
        '--model',
        this.options.model,
        '--thinking',
        this.options.thinking,
        '--name',
        name,
        '--append-system-prompt',
        promptPath,
        '--extension',
        '/runtime/cockpit-extension.js',
        ...(this.options.browser ? ['--extension', '/runtime/browser-extension.js'] : []),
      ];
      const child = spawn('/usr/bin/node', [this.options.executable, ...args], {
        cwd: this.options.workspace,
        env: { ...process.env, PI_CODING_AGENT_DIR: profile, B70_SUBAGENT_CHILD: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const agent: ChildAgent = { id, name: name.trim(), status: 'starting', child, result: '' };
      this.agents.set(id, agent);
      const decoder = new RpcJsonlDecoder((line) => {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (!record(event)) return;
        if (event.type !== 'response')
          this.options.onEvent(
            id,
            agent.name,
            event.type === 'agent_end'
              ? { type: 'agent_end', willRetry: event.willRetry === true }
              : event
          );
        if (event.type === 'agent_start') {
          agent.status = 'running';
          agent.result = '';
          delete agent.error;
        }
        if (
          event.type === 'message_end' &&
          record(event.message) &&
          event.message.role === 'assistant'
        ) {
          const content = Array.isArray(event.message.content) ? event.message.content : [];
          const text = content
            .filter(record)
            .filter((block) => block.type === 'text')
            .map((block) => String(block.text ?? ''))
            .join('\n');
          if (text) agent.result = text.slice(-32768);
          if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
            agent.error = String(event.message.errorMessage ?? 'Sub-agent model error').slice(
              0,
              512
            );
            agent.status = 'failed';
          }
        }
        if (event.type === 'agent_settled' && agent.status !== 'failed') agent.status = 'completed';
        if (event.type === 'response' && event.success === false) {
          agent.status = 'failed';
          agent.error = String(event.error ?? 'RPC rejected').slice(0, 512);
        }
      });
      const framingFailure = (): void => {
        agent.error = 'Sub-agent RPC output violated its framing limit.';
        agent.status = 'failed';
        child.kill();
      };
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          decoder.push(chunk);
        } catch {
          framingFailure();
        }
      });
      child.stdout.once('end', () => {
        try {
          decoder.end();
        } catch {
          framingFailure();
        }
      });
      // Internal Pi diagnostics are not conversation events.
      child.stderr.resume();
      child.stdin.on('error', (error) => {
        agent.status = 'failed';
        agent.error = error.message;
      });
      child.once('error', (error) => {
        agent.status = 'failed';
        agent.error = error.message;
      });
      child.once('close', () => {
        if (!['completed', 'stopped', 'failed'].includes(agent.status)) {
          agent.status = 'failed';
          agent.error = 'Sub-agent process exited before completion.';
        }
        this.options.onEvent(id, agent.name, { type: 'b70_subagent_status', status: agent.status });
      });
      this.send(id, task);
      return { id, name: agent.name, status: agent.status };
    } finally {
      this.spawning--;
    }
  }
  send(id: string, message: string) {
    const agent = this.agents.get(id);
    if (!agent || !message.trim() || message.length > 32768)
      throw new Error('Unknown agent or invalid message.');
    if (agent.child.exitCode !== null || agent.child.signalCode !== null)
      throw new Error('Sub-agent process is no longer running.');
    const running = ['starting', 'running'].includes(agent.status);
    agent.child.stdin.write(
      JSON.stringify({
        id: randomBytes(8).toString('hex'),
        type: running && agent.status !== 'starting' ? 'steer' : 'prompt',
        message,
      }) + '\n'
    );
    agent.status = running ? 'running' : 'starting';
    this.options.onEvent(id, agent.name, { type: 'b70_subagent_status', status: agent.status });
    this.options.onEvent(id, agent.name, { type: 'b70_subagent_assignment', message });
  }
  async wait(ids: string[], milliseconds: number, signal?: AbortSignal) {
    if (ids.length === 0 || ids.some((id) => !this.agents.has(id)))
      throw new Error('Select existing sub-agent IDs.');
    const deadline = Date.now() + Math.min(60_000, Math.max(1, milliseconds));
    while (Date.now() < deadline && !signal?.aborted) {
      if (ids.every((id) => !['starting', 'running'].includes(this.agents.get(id)!.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (signal?.aborted) throw new Error('Sub-agent wait cancelled.');
    return this.list().filter((agent) => ids.includes(agent.id));
  }
  close() {
    this.closed = true;
    for (const agent of this.agents.values()) {
      agent.status = 'stopped';
      agent.child.kill('SIGTERM');
    }
  }
}

type ExtensionApi = {
  registerTool(tool: Record<string, unknown>): void;
  on?(event: string, handler: (event: unknown, context?: unknown) => unknown): unknown;
};
export function registerSubagentTools(pi: ExtensionApi): void {
  if (
    process.env.B70_SUBAGENT_CHILD === '1' ||
    process.env.B70_RUN_MODE === 'review' ||
    !process.env.B70_AGENT_EXECUTABLE
  )
    return;
  const argument = (name: string, fallback: string) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
  };
  let notify: ((message: string) => void) | undefined;
  pi.on?.('session_start', (_event, context) => {
    if (!record(context) || !record(context.ui) || typeof context.ui.notify !== 'function') return;
    const ui = context.ui;
    notify = (message) =>
      (ui.notify as (message: string, type: string) => void).call(ui, message, 'info');
  });
  const pool = new SubagentPool({
    executable: process.env.B70_AGENT_EXECUTABLE,
    profileRoot: process.env.PI_CODING_AGENT_DIR ?? '/profile',
    temporaryRoot: '/tmp/b70-subagents',
    workspace: '/workspace',
    provider: argument('--provider', 'b70-vllm'),
    model: argument('--model', 'Qwen3.8-27B'),
    thinking: argument('--thinking', 'medium'),
    browser: process.env.B70_BROWSER_ROOT === '/browser',
    // RPC notifications use Pi's ordered raw-output writer. Extension stdout
    // is redirected to diagnostics and cannot transport conversation events.
    onEvent: (agentId, name, event) =>
      notify?.(JSON.stringify({ type: 'b70_subagent_event', agentId, name, event })),
  });
  const consumed = new Set<string>();
  pi.on?.('agent_before_settle', (event) => {
    if (record(event) && event.outcome !== 'completed') return undefined;
    const unread = pool
      .list()
      .filter((agent) => !consumed.has(agent.id) || ['starting', 'running'].includes(agent.status));
    if (unread.length === 0) return undefined;
    for (const agent of unread)
      if (!['starting', 'running'].includes(agent.status)) consumed.add(agent.id);
    return {
      continue: true,
      entries: [
        {
          type: 'custom_message',
          customType: 'b70-subagents',
          display: true,
          content: `Sub-agent work must be integrated before finishing. Use wait_agents for running agents; inspect and test completed work.\n${JSON.stringify(unread)}`,
        },
      ],
    };
  });
  pi.on?.('session_shutdown', () => pool.close());
  const string = { '~kind': 'String', type: 'string' };
  const wrap = async (action: () => unknown) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await action(), null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  };
  pi.registerTool({
    name: 'spawn_agent',
    label: 'Sub-Agent starten',
    description:
      'Starte bis zu zwei Sub-Agenten parallel im selben Workspace und derselben Sandbox. Gib eine klar begrenzte Teilaufgabe und getrennte Dateien vor. npm/package.json/package-lock.json koordiniert der Hauptagent. Sub-Agenten dürfen nicht weiter delegieren. Warte vor dem Abschluss auf alle Ergebnisse.',
    parameters: {
      '~kind': 'Object',
      type: 'object',
      properties: { name: { ...string, maxLength: 80 }, task: { ...string, maxLength: 32768 } },
      required: ['name', 'task'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    execute: async (_id: string, params: { name: string; task: string }) =>
      wrap(() => pool.start(params.name, params.task)),
  });
  pi.registerTool({
    name: 'list_agents',
    label: 'Sub-Agenten anzeigen',
    description: 'Zeige Status und letzte Ergebnisse der bis zu zwei Sub-Agenten.',
    parameters: { '~kind': 'Object', type: 'object', properties: {}, additionalProperties: false },
    execute: async () => wrap(() => pool.list()),
  });
  pi.registerTool({
    name: 'send_agent',
    label: 'Sub-Agent steuern',
    description:
      'Schicke einem laufenden Sub-Agenten eine Korrektur oder einem fertigen Sub-Agenten eine neue Aufgabe. Gleicher Workspace, kein zusätzlicher Agent.',
    parameters: {
      '~kind': 'Object',
      type: 'object',
      properties: { agentId: string, message: { ...string, maxLength: 32768 } },
      required: ['agentId', 'message'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    execute: async (_id: string, params: { agentId: string; message: string }) =>
      wrap(() => {
        consumed.delete(params.agentId);
        pool.send(params.agentId, params.message);
        return { sent: true };
      }),
  });
  pi.registerTool({
    name: 'wait_agents',
    label: 'Auf Sub-Agenten warten',
    description:
      'Warte maximal 60 Sekunden auf diese Sub-Agenten und lies ihre Ergebnisse. Wiederhole bei Bedarf. Du integrierst und prüfst ihre Änderungen vor dem Abschluss.',
    parameters: {
      '~kind': 'Object',
      type: 'object',
      properties: {
        agentIds: { '~kind': 'Array', type: 'array', items: string, minItems: 1, maxItems: 2 },
        timeoutSeconds: { '~kind': 'Number', type: 'integer', minimum: 1, maximum: 60 },
      },
      required: ['agentIds'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    execute: async (
      _id: string,
      params: { agentIds: string[]; timeoutSeconds?: number },
      signal?: AbortSignal
    ) =>
      wrap(async () => {
        const results = await pool.wait(
          params.agentIds,
          (params.timeoutSeconds ?? 30) * 1000,
          signal
        );
        for (const agent of results)
          if (!['starting', 'running'].includes(agent.status)) consumed.add(agent.id);
        return results;
      }),
  });
}
