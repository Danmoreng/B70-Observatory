import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import type { Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RunnerConfig } from '../runner/config.js';
import type { InferenceRequestTelemetry } from '@observatory/contracts';
import { createInferenceFetch } from '../runner/inference-fetch.js';
import { createEngineRecovery, ENGINE_RECOVERY_MS } from './model-recovery.js';
import { createInferenceTransport } from '../gateway/inference-transport.js';

// One pool for the runner process, with the same lifetime as the native fetch pool.
const modelTransport = createInferenceTransport(ENGINE_RECOVERY_MS, ENGINE_RECOVERY_MS);
const imageQueueTransport = createInferenceTransport(45 * 60_000, 45 * 60_000);

const Profile = z.object({
  providers: z.record(
    z.string(),
    z
      .object({
        models: z.array(
          z
            .object({
              id: z.string(),
              name: z.string().optional(),
              contextWindow: z.number().int().positive(),
              maxTokens: z.number().int().positive(),
              reasoning: z.boolean().optional(),
              samplingParams: z.record(z.string(), z.unknown()).optional(),
              input: z.array(z.enum(['text', 'image'])).optional(),
            })
            .passthrough()
        ),
      })
      .passthrough()
  ),
});
export async function createLocalModels(
  config: RunnerConfig,
  onTelemetry?: (sample: InferenceRequestTelemetry) => void
) {
  const profile = Profile.parse(
    JSON.parse(await readFile(join(config.profileRoot, 'models.json'), 'utf8'))
  );
  const source = profile.providers[config.provider]?.models.find(
    (model) => model.id === config.model
  );
  if (!source) throw new Error('Local model is missing from the approved profile.');
  if (config.imageGenerationEnabled && !source.input?.includes('image'))
    throw new Error('Image generation tools require a vision-capable approved model profile.');
  const model: Model<'openai-completions'> = {
    id: config.model,
    name: source.name ?? config.model,
    provider: config.provider,
    api: 'openai-completions',
    baseUrl: (config.gatewayUrl ?? 'http://127.0.0.1:8090').replace(/\/$/, '') + '/v1',
    reasoning: source.reasoning ?? true,
    ...(config.model === 'inkling2-mini-exl3-b70' && source.samplingParams
      ? { samplingParams: source.samplingParams }
      : {}),
    input: source.input ?? ['text'],
    contextWindow: source.contextWindow,
    maxTokens: source.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: true,
      maxTokensField: 'max_tokens',
      ...(config.model === 'inkling2-mini-exl3-b70'
        ? {
            thinkingFormat: 'openai' as const,
            thinkingTokenBudgetField: 'thinking_token_budget' as const,
          }
        : { thinkingFormat: 'qwen-chat-template' as const }),
    },
  };
  const models = createModels({ identity: { attribution: null } });
  const api = openAICompletionsApi();
  const recovery = createEngineRecovery(model);
  const transport = config.imageGenerationEnabled ? imageQueueTransport : modelTransport;
  const observedFetch = onTelemetry
    ? createInferenceFetch(onTelemetry, transport.fetch)
    : transport.fetch;
  models.setProvider(
    createProvider({
      id: config.provider,
      baseUrl: model.baseUrl,
      models: [model],
      api: {
        stream: (model, context, options) =>
          recovery((attempt) => api.stream(model, context, attempt), {
            ...options,
            fetch: observedFetch,
          }),
        streamSimple: (model, context, options) =>
          recovery((attempt) => api.streamSimple(model, context, attempt), {
            ...options,
            fetch: observedFetch,
          }),
      },
      auth: {
        apiKey: {
          name: 'Local inference gateway',
          resolve: async () => ({ auth: { apiKey: config.gatewayToken ?? 'local-b70-gateway' } }),
        },
      },
    })
  );
  return models;
}
