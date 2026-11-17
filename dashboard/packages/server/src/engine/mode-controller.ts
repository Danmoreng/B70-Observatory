import type { FastifyInstance } from 'fastify';
import type { AgentController } from '../agent/manager.js';
import { EngineMode, policy, type EnginePolicy } from './mode.js';
import type { GpuScheduler } from './gpu-scheduler.js';
import { setTimeout as delay } from 'node:timers/promises';

export class EngineModes {
  private current: EnginePolicy = policy('text');
  private changing = false;
  constructor(
    private readonly agent: AgentController | undefined,
    private readonly gpu: GpuScheduler
  ) {}
  status() {
    return { ...this.current, changing: this.changing, gpu: this.gpu.status() };
  }
  async load() {
    if (!this.agent?.engineMode) throw new Error('The runner must support engine modes.');
    // Type=simple units can start together before the runner binds its socket.
    // Only transport startup races are retryable; invalid policies/auth fail closed.
    for (let attempt = 0; ; attempt++) {
      try {
        this.current = await this.agent.engineMode();
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 39 || !['ENOENT', 'ECONNREFUSED'].includes(code ?? '')) throw error;
        await delay(250);
      }
    }
    this.gpu.setStudio(this.current.mode === 'studio');
  }
  model() {
    if (!this.current.model) throw new Error('Runner model unavailable.');
    return this.current.model;
  }
  allowsAgentImages() {
    return !this.changing && this.current.imageTools;
  }
  allowsImages() {
    return !this.changing && this.current.mode !== 'text';
  }
  allowsText() {
    return this.current.agentsAllowed;
  }
  async set(mode: EngineMode) {
    if (this.changing)
      throw Object.assign(new Error('An engine mode change is already running.'), {
        statusCode: 409,
      });
    if (!this.agent?.engineMode) throw new Error('Runner engine modes unavailable.');
    this.changing = true;
    try {
      await this.gpu.changeMode(mode === 'studio', async () => {
        // Runner rejects changes while any run is active; paused sessions stay durable.
        this.current = await this.agent!.engineMode!(mode);
      });
      this.changing = false;
      return this.status();
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error('Engine mode failed.'), {
        statusCode: 409,
      });
    } finally {
      this.changing = false;
    }
  }
}
export function registerModeRoutes(app: FastifyInstance, modes?: EngineModes) {
  const get = () => modes?.status() ?? { ...policy('text'), changing: false, available: false };
  app.get('/api/engine/mode', async () => get());
  app.get('/v1/engine-mode', async () => get());
  app.post('/api/engine/mode', async (request, reply) => {
    const input = EngineMode.safeParse((request.body as { mode?: unknown } | null)?.mode);
    if (!input.success) return reply.code(400).send({ error: { message: 'Invalid engine mode.' } });
    if (!modes)
      return reply.code(503).send({ error: { message: 'Image integration is disabled.' } });
    return modes.set(input.data);
  });
}
