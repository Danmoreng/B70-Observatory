import type { FastifyInstance } from 'fastify';
import { EngineServiceActionSchema } from '@observatory/contracts';
import { EngineServiceBusyError, type EngineServiceController } from './service.js';

export function registerEngineRoutes(
  app: FastifyInstance,
  controller?: EngineServiceController
): void {
  app.get('/api/engine/service', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!controller)
      return reply.code(503).send({
        error: { code: 'service_unavailable', message: 'Engine control is unavailable.' },
      });
    try {
      return await controller.status();
    } catch (error) {
      app.log.error({ err: error }, 'engine status failed');
      return reply
        .code(503)
        .send({ error: { code: 'service_unavailable', message: 'Engine status is unavailable.' } });
    }
  });
  app.post('/api/engine/service', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!controller)
      return reply.code(503).send({
        error: { code: 'service_unavailable', message: 'Engine control is unavailable.' },
      });
    const parsed = EngineServiceActionSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: 'Invalid engine action.' } });
    try {
      return await controller.action(parsed.data.action);
    } catch (error) {
      if (error instanceof EngineServiceBusyError)
        return reply.code(409).send({
          error: { code: 'bad_request', message: 'An engine action is already running.' },
        });
      app.log.error({ err: error }, 'engine action failed');
      return reply.code(503).send({
        error: {
          code: 'service_unavailable',
          message: 'Engine action failed. Check the service status.',
        },
      });
    }
  });
}
