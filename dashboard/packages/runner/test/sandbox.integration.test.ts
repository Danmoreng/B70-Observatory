import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { launchSandboxedJob, type SandboxJobOptions } from '../src/launcher.js';

const tempDirs: string[] = [];

function createFixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), 'b70-runner-integration-'));
  tempDirs.push(root);
  const workspace = join(root, 'workspace');
  const runtimeRoot = join(root, 'runtime');
  const profileRoot = join(root, 'profile');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(runtimeRoot, { mode: 0o700 });
  mkdirSync(profileRoot, { mode: 0o700 });
  const executable = join(runtimeRoot, 'probe.mjs');
  writeFileSync(executable, `#!/usr/bin/env node\n${script}\n`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  writeFileSync(join(profileRoot, 'immutable.json'), '{}\n', { mode: 0o600 });
  const runId = randomBytes(12).toString('hex');
  return {
    runId,
    workspace: {
      path: workspace,
      revision: '0'.repeat(40),
      runId,
      branch: `agent/${runId}`,
    },
    runtimeRoot,
    profileRoot,
    runtimeExecutable: 'probe.mjs',
  };
}

async function collect(options: SandboxJobOptions): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const { child } = launchSandboxedJob(options);
  child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('sandbox job did not finish')), 15_000);
    child.once('error', reject);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolvePromise(exitCode);
    });
  });
  return { code, stdout, stderr };
}

afterEach(() => {
  delete process.env.OBSERVATORY_PASSWORD_HASH;
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.runIf(
  process.env.B70_RELEASE_BUILD !== '1' &&
    existsSync('/usr/bin/bwrap') &&
    existsSync('/usr/bin/systemd-run')
)(
  'target-host sandbox',
  () => {
    it('hides host files, sockets, secrets, network and protected host PIDs', async () => {
      process.env.OBSERVATORY_PASSWORD_HASH = 'sentinel-must-not-cross';
      const protectedServer = createServer();
      await new Promise<void>((resolvePromise) =>
        protectedServer.listen(0, '127.0.0.1', resolvePromise)
      );
      const address = protectedServer.address();
      if (address === null || typeof address === 'string') throw new Error('missing test port');
      const options = createFixture(`
import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
const canWrite = (path) => { try { fs.writeFileSync(path, 'changed'); return true; } catch { return false; } };
const signalResult = (() => { try { process.kill(${process.pid}, 'SIGTERM'); return 'sent'; } catch (error) { return error.code; } })();
const networkResult = await new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port: ${address.port} });
  const timer = setTimeout(() => { socket.destroy(); resolve('timeout'); }, 1000);
  socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected'); });
  socket.once('error', (error) => { clearTimeout(timer); resolve(error.code); });
});
fs.writeFileSync('/workspace/result.txt', 'sandbox-owned');
console.log(JSON.stringify({
  uid: process.getuid(),
  pid: process.pid,
  home: process.env.HOME,
  secret: process.env.OBSERVATORY_PASSWORD_HASH,
  operatorHome: fs.existsSync('/home/operator'),
  sourceRepository: fs.existsSync('/srv/projects/observatory'),
  backup: fs.existsSync('/srv/private-backups'),
  dockerSocket: fs.existsSync('/var/run/docker.sock'),
  runtimeWritable: canWrite('/runtime/tamper'),
  profileWritable: canWrite('/profile/immutable.json'),
  nestedUserns: spawnSync('/usr/bin/unshare', ['--user', '/usr/bin/true']).status,
  signalResult,
  networkResult,
}));
`);
      try {
        const result = await collect(options);
        expect(result.code, result.stderr).toBe(0);
        const observation = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
        expect(observation).toMatchObject({
          uid: 65534,
          pid: 2,
          home: '/home/agent',
          operatorHome: false,
          sourceRepository: false,
          backup: false,
          dockerSocket: false,
          runtimeWritable: false,
          profileWritable: false,
          nestedUserns: 1,
          signalResult: 'ESRCH',
        });
        expect(observation.secret).toBeUndefined();
        expect(observation.networkResult).not.toBe('connected');
        expect(readFileSync(join(options.workspace.path, 'result.txt'), 'utf8')).toBe(
          'sandbox-owned'
        );
      } finally {
        await new Promise<void>((resolvePromise) => protectedServer.close(() => resolvePromise()));
      }
    });

    it('kills the complete PID namespace when the fixed runtime limit expires', async () => {
      const options = createFixture(`
import fs from 'node:fs';
import { spawn } from 'node:child_process';
spawn('/usr/bin/node', ['-e', "setTimeout(() => require('node:fs').writeFileSync('/workspace/escaped.txt', 'alive'), 2500)"], { detached: true, stdio: 'ignore' }).unref();
await new Promise((resolve) => setTimeout(resolve, 5000));
fs.writeFileSync('/workspace/parent-finished.txt', 'unexpected');
`);
      const result = await collect({
        ...options,
        limits: {
          memoryBytes: 256 * 1024 * 1024,
          cpuQuotaPercent: 50,
          tasksMax: 16,
          runtimeSeconds: 1,
          tmpBytes: 32 * 1024 * 1024,
        },
      });
      expect(result.code).not.toBe(0);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2800));
      expect(existsSync(join(options.workspace.path, 'escaped.txt'))).toBe(false);
      expect(existsSync(join(options.workspace.path, 'parent-finished.txt'))).toBe(false);
    });

    it('allows a job to end itself without terminating the protected control process', async () => {
      const control = spawn('/usr/bin/node', ['-e', 'setInterval(() => undefined, 1000)'], {
        stdio: 'ignore',
      });
      if (control.pid === undefined) throw new Error('protected control process did not start');
      const options = createFixture(`
import fs from 'node:fs';
let controlSignal;
try {
  process.kill(${control.pid}, 'SIGTERM');
  controlSignal = 'sent';
} catch (error) {
  controlSignal = error.code;
}
fs.writeFileSync('/workspace/self-stop.json', JSON.stringify({ controlSignal, sandboxPid: process.pid }));
process.kill(process.pid, 'SIGTERM');
`);
      try {
        const result = await collect(options);
        expect(result.code).not.toBe(0);
        const attempt = JSON.parse(
          readFileSync(join(options.workspace.path, 'self-stop.json'), 'utf8')
        ) as { controlSignal: string; sandboxPid: number };
        expect(attempt).toEqual({ controlSignal: 'ESRCH', sandboxPid: 2 });
        expect(() => process.kill(control.pid ?? -1, 0)).not.toThrow();
      } finally {
        const exited = new Promise<void>((resolvePromise) =>
          control.once('exit', () => resolvePromise())
        );
        control.kill('SIGTERM');
        await Promise.race([
          exited,
          new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1000)),
        ]);
        if (control.exitCode === null) control.kill('SIGKILL');
      }
    });

    it('reaches only the mounted inference relay through the trusted bridge', async () => {
      const root = mkdtempSync(join(tmpdir(), 'b70-runner-bridge-'));
      tempDirs.push(root);
      const workspace = join(root, 'workspace');
      const profileRoot = join(root, 'profile');
      const agentRuntimeRoot = join(root, 'agent-runtime');
      const inferenceSocketRoot = join(root, 'inference');
      for (const directory of [workspace, profileRoot, agentRuntimeRoot, inferenceSocketRoot]) {
        mkdirSync(directory, { mode: 0o700 });
      }
      const token = randomBytes(32).toString('hex');
      writeFileSync(
        join(agentRuntimeRoot, 'agent.mjs'),
        `
import fs from 'node:fs';
const response = await fetch('http://127.0.0.1:8081/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + process.env.B70_INFERENCE_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'Qwen3.8-27B' }),
});
fs.writeFileSync('/workspace/relay-result.json', JSON.stringify({ status: response.status, body: await response.text(), args: process.argv.slice(2) }));
`
      );
      let authorization: string | undefined;
      const relay = createHttpServer((request, response) => {
        authorization = request.headers.authorization;
        expect(request.url).toBe('/v1/chat/completions');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"isolated":true}');
      });
      const relaySocket = join(inferenceSocketRoot, 'relay.sock');
      await new Promise<void>((resolvePromise) => relay.listen(relaySocket, resolvePromise));
      chmodSync(relaySocket, 0o666);
      try {
        const runId = randomBytes(12).toString('hex');
        const result = await collect({
          runId,
          workspace: {
            path: workspace,
            revision: '0'.repeat(40),
            runId,
            branch: `agent/${runId}`,
          },
          runtimeRoot: join(import.meta.dirname, '../dist'),
          runtimeExecutable: 'sandbox-entry.js',
          runtimeNodeEntrypoint: true,
          profileRoot,
          agentRuntimeRoot,
          agentExecutable: 'agent.mjs',
          inferenceSocketRoot,
          inferenceToken: token,
          args: ['--mode', 'rpc'],
        });
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(join(workspace, 'relay-result.json'), 'utf8'))).toEqual({
          status: 200,
          body: '{"isolated":true}',
          args: ['--mode', 'rpc'],
        });
        expect(authorization).toBe(`Bearer ${token}`);
      } finally {
        await new Promise<void>((resolvePromise) => relay.close(() => resolvePromise()));
      }
    });
  }
);
