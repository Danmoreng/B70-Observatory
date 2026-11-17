import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function call(socketPath: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; body: unknown }>((resolvePromise, rejectPromise) => {
    const client = request(
      {
        socketPath,
        method,
        path,
        headers:
          encoded === undefined
            ? undefined
            : { 'content-type': 'application/json', 'content-length': encoded.length },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          })
        );
      }
    );
    client.once('error', rejectPromise);
    if (encoded !== undefined) client.write(encoded);
    client.end();
  });
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('release helper did not reach expected state');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

describe('release helper control boundary', () => {
  it('serves status over a private socket and rejects an unavailable staged release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-release-helper-'));
    roots.push(root);
    const runRoot = join(root, 'run');
    const stagingRoot = join(root, 'staging');
    const activeRoot = join(root, 'active');
    mkdirSync(runRoot);
    mkdirSync(stagingRoot);
    const socketPath = join(runRoot, 'control.sock');
    const child = spawn(
      process.execPath,
      [
        '--import',
        resolve(import.meta.dirname, '../../../../node_modules/tsx/dist/loader.mjs'),
        resolve(import.meta.dirname, '../../../../ops/release-helper.ts'),
      ],
      {
        env: {
          ...process.env,
          B70_RELEASE_HELPER_SOCKET: socketPath,
          B70_RELEASE_STAGING_ROOT: stagingRoot,
          B70_RELEASE_ACTIVE_ROOT: activeRoot,
        },
        stdio: 'ignore',
      }
    );
    children.push(child);
    await eventually(async () => {
      try {
        return (await call(socketPath, 'GET', '/v1/status')).status === 200;
      } catch {
        return false;
      }
    });
    const activation = await call(socketPath, 'POST', '/v1/activate', {
      releaseId: '11111111-1111-4111-8111-111111111111',
      revision: 'a'.repeat(40),
      digest: 'b'.repeat(64),
    });
    expect(activation).toMatchObject({ status: 202, body: { accepted: true } });
    await eventually(async () => {
      const status = await call(socketPath, 'GET', '/v1/status');
      return (status.body as { status?: unknown }).status === 'failed';
    });
    const status = await call(socketPath, 'GET', '/v1/status');
    expect(status.body).toMatchObject({
      status: 'failed',
      pending: { releaseId: '11111111-1111-4111-8111-111111111111' },
    });
  });
});

describe('installed release lifecycle over IPC', () => {
  it.each([false, true])(
    'installs restrictive artifacts and recovers a failed restart: %s',
    async (failCandidate) => {
      const root = mkdtempSync(join(tmpdir(), 'b70-release-ipc-'));
      roots.push(root);
      const staging = join(root, 'staging');
      const active = join(root, 'active');
      const id = '22222222-2222-4222-8222-222222222222';
      const oldId = '11111111-1111-4111-8111-111111111111';
      const revision = 'a'.repeat(40);
      const staged = join(staging, id);
      mkdirSync(join(staged, 'web'), { recursive: true, mode: 0o700 });
      mkdirSync(join(active, 'releases', oldId), { recursive: true });
      symlinkSync(`releases/${oldId}`, join(active, 'current'));
      writeFileSync(
        join(active, 'state.json'),
        JSON.stringify({
          version: 1,
          status: 'active',
          updatedAt: '',
          current: { releaseId: oldId, revision: 'b'.repeat(40), digest: 'b'.repeat(64) },
        })
      );
      const files = ['runner.mjs', 'server.cjs', 'web/index.html'].map((file) => {
        writeFileSync(join(staged, file), 'fixture', { mode: 0o600 });
        return { file, sha256: createHash('sha256').update('fixture').digest('hex') };
      });
      const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
      writeFileSync(
        join(staged, 'manifest.json'),
        JSON.stringify({
          version: 1,
          target: 'observatory',
          compatibility: 1,
          revision,
          artifactDigest: digest,
          files,
        })
      );
      // Mock only systemctl inside this disposable process. Never control host units.
      const shim = join(root, 'systemctl-shim.mjs');
      const calls = join(root, 'calls.jsonl');
      writeFileSync(
        shim,
        String.raw`
      import cp from 'node:child_process';
      import { appendFileSync, readlinkSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const original = cp.execFile;
      cp.execFile = function(file, args, options, callback) {
        if (file !== '/usr/bin/systemctl') return original.apply(this, arguments);
        appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\n');
        const failed = args[0] === 'restart' && process.env.TEST_FAIL === '1'
          && readlinkSync(process.env.TEST_CURRENT).endsWith('${id}');
        queueMicrotask(() => callback(failed ? new Error('candidate failed to start') : null, '', ''));
        return {};
      };
      syncBuiltinESMExports();
    `
      );
      const health = createServer((_req, res) => {
        res.writeHead(200);
        res.end('{}');
      });
      await new Promise<void>((resolvePromise) => health.listen(0, '127.0.0.1', resolvePromise));
      const address = health.address();
      if (address === null || typeof address === 'string') throw new Error('missing health port');
      const socketPath = join(root, 'control.sock');
      const child = spawn(
        process.execPath,
        [
          '--import',
          resolve(import.meta.dirname, '../../../../node_modules/tsx/dist/loader.mjs'),
          resolve(import.meta.dirname, '../../../../ops/release-helper.ts'),
        ],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: `--import=${shim}`,
            TEST_CALLS: calls,
            TEST_FAIL: failCandidate ? '1' : '0',
            TEST_CURRENT: join(active, 'current'),
            B70_RELEASE_HELPER_SOCKET: socketPath,
            B70_RELEASE_STAGING_ROOT: staging,
            B70_RELEASE_ACTIVE_ROOT: active,
            OBSERVATORY_HOST: '127.0.0.1',
            OBSERVATORY_PORT: String(address.port),
          },
          stdio: 'ignore',
        }
      );
      children.push(child);
      try {
        await eventually(async () => {
          try {
            return (await call(socketPath, 'GET', '/v1/status')).status === 200;
          } catch {
            return false;
          }
        });
        expect(
          (await call(socketPath, 'POST', '/v1/activate', { releaseId: id, revision, digest }))
            .status
        ).toBe(202);
        await eventually(async () => {
          const state = (await call(socketPath, 'GET', '/v1/status')).body as { status: string };
          return state.status === (failCandidate ? 'failed' : 'active');
        });
        expect(statSync(join(active, 'releases', id, 'server.cjs')).mode & 0o777).toBe(0o640);
        expect(statSync(join(active, 'releases', id, 'web')).mode & 0o777).toBe(0o750);
        expect(readlinkSync(join(active, 'current'))).toBe(
          `releases/${failCandidate ? oldId : id}`
        );
        const commands = readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
        expect(commands.filter((args) => args[0] === 'reset-failed')).toHaveLength(
          failCandidate ? 2 : 1
        );
        expect(commands.filter((args) => args[0] === 'is-active')).toHaveLength(2);
        if (failCandidate)
          expect((await call(socketPath, 'GET', '/v1/status')).body).toMatchObject({
            message: expect.stringContaining('restored and health checked'),
          });
      } finally {
        child.kill('SIGKILL');
        await new Promise<void>((resolvePromise) => health.close(() => resolvePromise()));
      }
    }
  );
});
