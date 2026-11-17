import { describe, expect, it } from 'vitest';
import { parsePrometheus } from '../../src/telemetry/prometheus.js';
import { prometheusFixture } from './fixtures.js';

describe('parsePrometheus (boundary parser)', () => {
  it('parses gauges, counters and labels from a realistic vLLM fixture', () => {
    const parsed = parsePrometheus(
      prometheusFixture({ running: 3, waiting: 2, promptTokens: 100, successStop: 5 })
    );
    const running = parsed.get('vllm:num_requests_running');
    expect(running).toHaveLength(1);

    expect(running?.[0]).toEqual({
      name: 'vllm:num_requests_running',
      labels: { engine: '0', model_name: 'Qwen3.8-27B' },
      value: 3,
    });
    const success = parsed.get('vllm:request_success_total');
    expect(success?.[0]?.labels['finished_reason']).toBe('stop');
    expect(success?.[0]?.value).toBe(5);
  });

  it('keeps every series per metric name (multiple label sets)', () => {
    const parsed = parsePrometheus(
      [
        'vllm:num_requests_running{engine="0",model_name="a"} 1.0',
        'vllm:num_requests_running{engine="1",model_name="a"} 2.0',
      ].join('\n')
    );
    expect(parsed.get('vllm:num_requests_running')).toHaveLength(2);
  });

  it('unescapes quoted label values', () => {
    const parsed = parsePrometheus('vllm:demo{model_name="Qwen\\"3.8"} 1.0');
    expect(parsed.get('vllm:demo')?.[0]?.labels['model_name']).toBe('Qwen"3.8');
  });

  it('skips non-finite values (NaN, +Inf, -Inf) without breaking other series', () => {
    const parsed = parsePrometheus(
      ['vllm:a 1.0', 'vllm:b NaN', 'vllm:c +Inf', 'vllm:d -Inf'].join('\n')
    );
    expect([...parsed.keys()]).toEqual(['vllm:a']);
  });

  it('ignores an optional UNIX timestamp suffix on the value', () => {
    const parsed = parsePrometheus('vllm:with_ts{engine="0"} 7.5 1735700000');
    expect(parsed.get('vllm:with_ts')?.[0]?.value).toBe(7.5);
  });

  it('skips malformed label blocks but keeps well-formed series on other lines', () => {
    const parsed = parsePrometheus(
      [
        'vllm:ok{engine="0"} 1.0',
        'vllm:broken{engine="0",dangling=" 1.0',
        'vllm:alsonotbroken{engine="0"} 2.0',
      ].join('\n')
    );
    expect(parsed.has('vllm:broken')).toBe(false);
    expect(parsed.get('vllm:ok')).toHaveLength(1);
    expect(parsed.get('vllm:alsonotbroken')).toHaveLength(1);
  });

  it('ignores meta lines and does not create empty series for TYPE-only metrics', () => {
    const parsed = parsePrometheus(
      [
        '# HELP vllm:only_meta A metric without samples in this body.',
        '# TYPE vllm:only_meta gauge',
        'vllm:real 1.0',
        '# some other meta line',
      ].join('\n')
    );
    expect(parsed.has('vllm:only_meta')).toBe(false);
    expect(parsed.get('vllm:real')).toHaveLength(1);
  });

  it('accepts scientific notation and rejects garbage lines', () => {
    const parsed = parsePrometheus(
      [
        'vllm:sci 9.89825024e+09',
        'vllm:negative -3.5',
        'not a metric',
        '{no_name} 1.0',
        'vllm:ok 1.0',
      ].join('\n')
    );
    expect(parsed.get('vllm:sci')?.[0]?.value).toBe(9898250240);
    expect(parsed.get('vllm:negative')?.[0]?.value).toBe(-3.5);
    expect(parsed.has('vllm:ok')).toBe(true);
  });

  it('returns an empty map for empty or meta-only input', () => {
    expect(parsePrometheus('').size).toBe(0);
    expect(parsePrometheus('# HELP x y\n# TYPE x gauge\n').size).toBe(0);
  });
});
