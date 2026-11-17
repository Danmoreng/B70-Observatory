import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Deterministic vLLM-style Prometheus fixtures. Values are parameterized so
 * tests can advance counters between scrapes. The production vLLM service on
 * 127.0.0.1:8081 is never contacted: the mock below listens on an ephemeral
 * loopback port.
 */
export interface TelemetryFixtureValues {
  model?: string;
  running?: number;
  waiting?: number;
  /** KV-cache usage, 0..1 as reported by vLLM. */
  kv?: number;
  promptTokens?: number;
  generationTokens?: number;
  prefixQueries?: number;
  prefixHits?: number;
  mtpDraft?: number;
  mtpAccepted?: number;
  successStop?: number;
  successLength?: number;
  successAbort?: number;
  successError?: number;
  successRepetition?: number;
  e2eSumSeconds?: number;
  e2eCount?: number;
  ttftSumSeconds?: number;
  ttftCount?: number;
  interTokenSumSeconds?: number;
  interTokenCount?: number;
  /**
   * Per-request prefill histograms (sums over finished requests). vLLM
   * records both in the same finish call; their delta ratio is the prefill
   * throughput the dashboard derives.
   */
  prefillKvComputedSum?: number;
  prefillTimeSumSeconds?: number;
  prefillCount?: number;
  /** Set false to simulate a vLLM build without MTP/spec-decoding metrics. */
  withMtp?: boolean;
  /** Set false to simulate a build without latency histograms. */
  withLatency?: boolean;
  /** Set false to simulate a build without the per-request prefill-phase histograms. */
  withPrefillHistograms?: boolean;
}

export function prometheusFixture(values: TelemetryFixtureValues = {}): string {
  const model = values.model ?? 'Qwen3.8-27B';
  const withMtp = values.withMtp !== false;
  const withLatency = values.withLatency !== false;
  const withPrefillHistograms = values.withPrefillHistograms !== false;
  const labels = `engine="0",model_name="${model}"`;

  const lines: string[] = [];
  const gauge = (name: string, value: number | undefined, type = 'gauge'): void => {
    if (value === undefined) return;
    lines.push(`# HELP vllm:${name} vllm:${name}`);
    lines.push(`# TYPE vllm:${name} ${type}`);
    lines.push(`vllm:${name}{${labels}} ${value}`);
  };
  const counter = (name: string, value: number | undefined, extraLabels = ''): void => {
    if (value === undefined) return;
    lines.push(`# TYPE vllm:${name} counter`);
    lines.push(`vllm:${name}{${labels}${extraLabels}} ${value}`);
  };
  const histogram = (name: string, sum: number | undefined, count: number | undefined): void => {
    if (sum === undefined || count === undefined) return;
    lines.push(`# TYPE vllm:${name} histogram`);
    lines.push(`vllm:${name}_bucket{${labels},le="1.0"} 0.0`);
    lines.push(`vllm:${name}_bucket{${labels},le="+Inf"} ${count}`);
    lines.push(`vllm:${name}_sum{${labels}} ${sum}`);
    lines.push(`vllm:${name}_count{${labels}} ${count}`);
  };

  // Foreign noise that a real exposition contains and must be ignored.
  lines.push('# HELP python_gc_objects_collected_total Objects collected during gc');
  lines.push('# TYPE python_gc_objects_collected_total counter');
  // prettier-ignore
  lines.push('python_gc_objects_collected_total{generation="0"} 17948.0');

  gauge('num_requests_running', values.running);
  gauge('num_requests_waiting', values.waiting);
  gauge('kv_cache_usage_perc', values.kv);

  counter('prompt_tokens_total', values.promptTokens);
  counter('generation_tokens_total', values.generationTokens);
  counter('prefix_cache_queries_total', values.prefixQueries);
  counter('prefix_cache_hits_total', values.prefixHits);

  if (withMtp) {
    counter(
      'spec_decode_num_drafts_total',
      values.mtpDraft !== undefined ? values.mtpDraft + 2 : undefined
    );
    counter('spec_decode_num_draft_tokens_total', values.mtpDraft);
    counter('spec_decode_num_accepted_tokens_total', values.mtpAccepted);
  }

  counter('request_success_total', values.successStop, ',finished_reason="stop"');
  counter('request_success_total', values.successLength, ',finished_reason="length"');
  counter('request_success_total', values.successAbort, ',finished_reason="abort"');
  counter('request_success_total', values.successError, ',finished_reason="error"');
  counter('request_success_total', values.successRepetition, ',finished_reason="repetition"');
  counter('num_preemptions_total', 0);

  if (withLatency) {
    histogram('e2e_request_latency_seconds', values.e2eSumSeconds, values.e2eCount);
    histogram('time_to_first_token_seconds', values.ttftSumSeconds, values.ttftCount);
    histogram('inter_token_latency_seconds', values.interTokenSumSeconds, values.interTokenCount);
  }

  if (withPrefillHistograms) {
    const count = values.prefillCount ?? 0;
    histogram('request_prefill_kv_computed_tokens', values.prefillKvComputedSum, count);
    histogram('request_prefill_time_seconds', values.prefillTimeSumSeconds, count);
  }

  // Hostile lines that must be skipped without breaking the parse.
  lines.push('vllm:broken_nan_gauge{engine="0"} NaN');
  lines.push('vllm:broken_inf_counter{engine="0"} +Inf');
  lines.push('vllm:broken_label_gauge{engine="0",dangling=" 1.0');
  lines.push('this is not a prometheus line');
  lines.push('vllm:with_timestamp_gauge{engine="0"} 7.0 1735700000');

  return `${lines.join('\n')}\n`;
}

/** In-memory vLLM metrics mock on an ephemeral loopback port. */
export interface MockPrometheus {
  url: string;
  port: number;
  setBody(body: string): void;
  setStatus(statusCode: number): void;
  close(): Promise<void>;
}

export async function startMockPrometheus(initialBody: string): Promise<MockPrometheus> {
  let body = initialBody;
  let statusCode = 200;
  const server: Server = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(statusCode, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('listening', () => resolvePromise());
    server.once('error', rejectPromise);
  });
  const address = server.address() as AddressInfo;
  return {
    get url() {
      return `http://127.0.0.1:${address.port}/metrics`;
    },
    port: address.port,
    setBody(next: string) {
      body = next;
    },
    setStatus(code: number) {
      statusCode = code;
    },
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
      }),
  };
}
