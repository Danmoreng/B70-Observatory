import type { FastifyInstance } from 'fastify';
import { SpeechInputSchema } from '@observatory/contracts';
import { SpeechAudioError, SpeechBusyError, type SpeechTranscriber } from './service.js';

export function registerSpeechRoutes(app: FastifyInstance, speech?: SpeechTranscriber): void {
  app.get('/api/speech/status', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { available: speech?.available() ?? false, device: 'cpu', maxSeconds: 120 };
  });
  app.post('/api/speech/transcribe', { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!speech?.available())
      return reply
        .code(503)
        .send({
          error: {
            code: 'service_unavailable',
            message: 'Local speech recognition is unavailable.',
          },
        });
    const parsed = SpeechInputSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: 'Invalid audio recording.' } });
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    request.raw.once('aborted', disconnected);
    reply.raw.once('close', disconnected);
    try {
      return { text: await speech.transcribe(parsed.data, abort.signal) };
    } catch (error) {
      const status =
        error instanceof SpeechBusyError ? 429 : error instanceof SpeechAudioError ? 400 : 503;
      return reply.code(status).send({
        error: {
          code:
            status === 429
              ? 'too_many_requests'
              : status === 400
                ? 'bad_request'
                : 'service_unavailable',
          message:
            status === 429
              ? 'Speech recognition is busy. Try again shortly.'
              : status === 400
                ? 'Recording must contain at most two minutes of audio.'
                : 'Transcription failed. Your typed text is unchanged.',
        },
      });
    } finally {
      request.raw.removeListener('aborted', disconnected);
      reply.raw.removeListener('close', disconnected);
    }
  });
  app.addHook('onClose', async () => speech?.close());
}
