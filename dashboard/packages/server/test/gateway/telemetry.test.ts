import { describe, expect, it } from 'vitest';
import type { FastifyLoggerInstance } from 'fastify';
import type { RequestRepository } from '../../src/db/index.js';
import { createTelemetry } from '../../src/gateway/routes.js';

describe('gateway telemetry ownership', () => {
  it('binds writes to the request that created the row and releases ownership', () => {
    const rows = new Set<string>();
    const events: unknown[] = [];
    const finishes: unknown[] = [];
    const repository = {
      create(input: unknown) {
        const id = (input as { id: string }).id;
        if (rows.has(id)) throw new Error('duplicate id');
        rows.add(id);
      },
      appendEvent(input: unknown) {
        events.push(input);
      },
      finish(input: unknown) {
        finishes.push(input);
      },
    } as unknown as RequestRepository;
    const logger = { warn() {} } as unknown as FastifyLoggerInstance;
    const telemetry = createTelemetry(repository, logger);
    const id = 'e71b04cf-52aa-4f3b-9c0d-6f8e1d2c3b4a';

    const owner = telemetry.recordStart({ id }, id);
    const collidingOwner = telemetry.recordStart({ id }, id);
    expect(owner).toBeTypeOf('symbol');
    expect(collidingOwner).toBeUndefined();

    telemetry.recordEvent({ requestId: id }, id, collidingOwner);
    telemetry.recordFinish({ requestId: id }, id, collidingOwner);
    expect(events).toHaveLength(0);
    expect(finishes).toHaveLength(0);

    telemetry.recordEvent({ requestId: id }, id, owner);
    telemetry.recordFinish({ requestId: id }, id, owner);
    expect(events).toHaveLength(1);
    expect(finishes).toHaveLength(1);

    telemetry.release(id, owner);
    telemetry.recordEvent({ requestId: id }, id, owner);
    expect(events).toHaveLength(1);
  });
});
