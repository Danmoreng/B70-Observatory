import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadServerConfig } from '../src/config.js';
import { SpeechBusyError, type SpeechTranscriber } from '../src/speech/service.js';

const input = { data: 'UklGRg==', mimeType: 'audio/mp4', language: 'de-DE' };
function setup(speech?: SpeechTranscriber, lan = false) {
  return buildApp({
    version: 'test',
    loggerLevel: 'silent',
    config: loadServerConfig(),
    speech,
    ...(lan
      ? {
          auth: {
            mode: 'lan' as const,
            browserAuthMode: 'none' as const,
            gatewayAuthMode: 'none' as const,
            sessions: {} as never,
            sessionDays: 1,
            cookieSecure: false,
          },
        }
      : {}),
  });
}
function recognizer(): SpeechTranscriber {
  return { available: () => true, transcribe: vi.fn(async () => 'Ein Test.'), close: vi.fn() };
}

describe('local CPU dictation', () => {
  it('reports disabled speech without affecting the dashboard', async () => {
    const app = setup();
    expect((await app.inject('/api/speech/status')).json()).toEqual({
      available: false,
      device: 'cpu',
      maxSeconds: 120,
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/speech/transcribe', payload: input }))
        .statusCode
    ).toBe(503);
    await app.close();
  });
  it('validates the recording and returns only recognized text', async () => {
    const speech = recognizer();
    const app = setup(speech);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/speech/transcribe',
          payload: { ...input, model: '/tmp/arbitrary' },
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/speech/transcribe',
          payload: { ...input, mimeType: 'text/html' },
        })
      ).statusCode
    ).toBe(400);
    expect(speech.transcribe).not.toHaveBeenCalled();
    const response = await app.inject({
      method: 'POST',
      url: '/api/speech/transcribe',
      payload: input,
    });
    expect(response.json()).toEqual({ text: 'Ein Test.' });
    expect(speech.transcribe).toHaveBeenCalledWith(input, expect.any(AbortSignal));
    expect(response.headers['permissions-policy']).toContain('microphone=(self)');
    await app.close();
    expect(speech.close).toHaveBeenCalled();
  });
  it('keeps same-origin protection for audio uploads', async () => {
    const speech = recognizer();
    const app = setup(speech, true);
    const response = await app.inject({
      method: 'POST',
      url: '/api/speech/transcribe',
      headers: { origin: 'https://unrelated.example' },
      payload: input,
    });
    expect(response.statusCode).toBe(403);
    expect(speech.transcribe).not.toHaveBeenCalled();
    await app.close();
  });
  it('bounds concurrency and sanitizes native process failures', async () => {
    const speech = recognizer();
    const app = setup(speech);
    vi.mocked(speech.transcribe).mockRejectedValueOnce(new SpeechBusyError());
    expect(
      (await app.inject({ method: 'POST', url: '/api/speech/transcribe', payload: input }))
        .statusCode
    ).toBe(429);
    vi.mocked(speech.transcribe).mockRejectedValueOnce(
      new Error('private recording text and host path')
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/speech/transcribe',
      payload: input,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private recording');
    await app.close();
  });
  it('requires an absolute executable and model together', () => {
    expect(() =>
      loadServerConfig({ OBSERVATORY_SPEECH_EXECUTABLE: '/usr/bin/nemo-speech' })
    ).toThrow();
    expect(() =>
      loadServerConfig({
        OBSERVATORY_SPEECH_EXECUTABLE: 'relative',
        OBSERVATORY_SPEECH_MODEL: '/model.gguf',
      })
    ).toThrow();
  });
});
