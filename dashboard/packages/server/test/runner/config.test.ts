import { describe, expect, it } from 'vitest';
import { loadRunnerConfig, RunnerConfigError } from '../../src/runner/config.js';

const required = {
  B70_RUNNER_CONTROL_TOKEN: 'b'.repeat(64),
  B70_RUNNER_REPOSITORY: '/srv/source',
  B70_RUNNER_SUPPORT_ROOT: '/opt/b70/runner',
  B70_RUNNER_AGENT_RUNTIME_ROOT: '/opt/b70/pi',
  B70_RUNNER_PROFILE_ROOT: '/var/lib/b70/profile',
  B70_RUNNER_DEPENDENCY_ROOT: '/srv/source/dashboard/node_modules',
  B70_RUNNER_REVISION: 'a'.repeat(40),
};

describe('loadRunnerConfig', () => {
  it('requires a Durable runner and gateway credential before offering image tools', () => {
    expect(loadRunnerConfig(required).imageGenerationEnabled).toBe(false);
    expect(() =>
      loadRunnerConfig({ ...required, B70_RUNNER_IMAGE_GENERATION_ENABLED: '1' })
    ).toThrow('pi-durable');
    expect(
      loadRunnerConfig({
        ...required,
        B70_RUNNER_ENGINE: 'pi-durable',
        B70_RUNNER_GATEWAY_TOKEN: 'fixture-token-123456',
        B70_RUNNER_IMAGE_GENERATION_ENABLED: '1',
      }).imageGenerationEnabled
    ).toBe(true);
  });
  it('requires explicit Durable opt-in for native desktop tools', () => {
    expect(loadRunnerConfig(required).desktopEnabled).toBe(false);
    expect(
      loadRunnerConfig({
        ...required,
        B70_RUNNER_ENGINE: 'pi-durable',
        B70_RUNNER_DESKTOP_ENABLED: '1',
      }).desktopEnabled
    ).toBe(true);
    expect(() => loadRunnerConfig({ ...required, B70_RUNNER_DESKTOP_ENABLED: '1' })).toThrow(
      /pi-durable/
    );
    expect(() => loadRunnerConfig({ ...required, B70_RUNNER_DESKTOP_ENABLED: 'yes' })).toThrow(
      RunnerConfigError
    );
  });
  it('applies a local-only, fixed runner profile', () => {
    expect(loadRunnerConfig(required)).toMatchObject({
      controlSocket: '/run/local-ai-b70-runner/control.sock',
      controlToken: 'b'.repeat(64),
      inferenceSocketRoot: '/run/local-ai-b70-runner/inference',
      databasePath: '/var/lib/local-ai-b70-runner/tasks.sqlite',
      upstreamUrl: 'http://127.0.0.1:8081',
      gatewayUrl: 'http://127.0.0.1:8090',
      inferenceIdleTimeoutMs: 1_800_000,
      provider: 'b70-vllm',
      model: 'Qwen3.8-27B',
      thinkingLevel: 'medium',
      profileId: 'coding-default-v1',
      maxActiveRuns: 2,
      dependencyRoot: '/srv/source/dashboard/node_modules',
    });
  });

  it('defaults to a generous run storage budget and validates overrides', () => {
    expect(loadRunnerConfig(required).runStorageBudgetBytes).toBe(2 * 1024 ** 3);
    expect(
      loadRunnerConfig({ ...required, B70_RUNNER_RUN_STORAGE_BUDGET_BYTES: String(8 * 1024 ** 3) })
        .runStorageBudgetBytes
    ).toBe(8 * 1024 ** 3);
    for (const value of ['0', '-1', 'NaN', String(17 * 1024 ** 3)]) {
      expect(() =>
        loadRunnerConfig({ ...required, B70_RUNNER_RUN_STORAGE_BUDGET_BYTES: value })
      ).toThrowError(/runStorageBudgetBytes/);
    }
  });

  it('validates an independently configured gateway without embedding secrets in its URL', () => {
    expect(
      loadRunnerConfig({ ...required, B70_RUNNER_GATEWAY_URL: 'http://192.168.50.10:8090' })
        .gatewayUrl
    ).toBe('http://192.168.50.10:8090');
    for (const value of [
      'invalid',
      'http://user:secret@127.0.0.1:8090',
      'http://127.0.0.1:8090/?token=secret',
      'file:///tmp/model',
    ]) {
      expect(() => loadRunnerConfig({ ...required, B70_RUNNER_GATEWAY_URL: value })).toThrow(
        RunnerConfigError
      );
    }
  });

  it('enables Durable explicitly while retaining the legacy default', () => {
    expect(loadRunnerConfig(required).agentEngine).toBe('pi-rpc');
    expect(loadRunnerConfig({ ...required, B70_RUNNER_ENGINE: 'pi-durable' }).agentEngine).toBe(
      'pi-durable'
    );
    expect(() => loadRunnerConfig({ ...required, B70_RUNNER_ENGINE: 'other' })).toThrow(
      RunnerConfigError
    );
  });

  it('bounds the model idle timeout while permitting long queued prefills', () => {
    expect(
      loadRunnerConfig({ ...required, B70_RUNNER_INFERENCE_IDLE_TIMEOUT_MS: '2400000' })
        .inferenceIdleTimeoutMs
    ).toBe(2_400_000);
    for (const value of ['0', '-1', 'NaN', '3600001']) {
      expect(() =>
        loadRunnerConfig({ ...required, B70_RUNNER_INFERENCE_IDLE_TIMEOUT_MS: value })
      ).toThrowError(/inferenceIdleTimeoutMs/);
    }
  });

  it('rejects missing roots, remote inference and unsafe executable paths', () => {
    expect(() => loadRunnerConfig()).toThrowError(RunnerConfigError);
    expect(() =>
      loadRunnerConfig({ ...required, B70_RUNNER_UPSTREAM_URL: 'http://192.168.1.2:8081' })
    ).toThrowError(/loopback/);
    expect(() =>
      loadRunnerConfig({ ...required, B70_RUNNER_AGENT_EXECUTABLE: '../pi.js' })
    ).toThrowError(/agentExecutable/);
    expect(() => loadRunnerConfig({ ...required, B70_RUNNER_MAX_ACTIVE_RUNS: '5' })).toThrowError(
      /maxActiveRuns/
    );
  });
});
