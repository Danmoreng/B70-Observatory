import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import {
  createReleaseLifecycle,
  normalizeReleasePermissions,
  restartReleaseServices,
  type ReleaseRef,
  type HelperState,
} from './release-lifecycle.js';

const socketPath =
  process.env.B70_RELEASE_HELPER_SOCKET ?? '/run/local-ai-b70-release-helper/control.sock';
const stagingRoot = process.env.B70_RELEASE_STAGING_ROOT ?? '/var/lib/local-ai-b70-runner/releases';
const activeRoot = process.env.B70_RELEASE_ACTIVE_ROOT ?? '/var/lib/local-ai-b70-releases';
const statePath = join(activeRoot, 'state.json');
const currentLink = join(activeRoot, 'current');
const MAX_BODY = 16 * 1024;
const HASH40 = /^[a-f0-9]{40}$/;
const HASH64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9@._+/-]+$/;

interface Manifest {
  version: 1;
  target: 'observatory';
  revision: string;
  compatibility: 1;
  artifactDigest: string;
  files: Array<{ file: string; sha256: string }>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readState(): HelperState {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as HelperState;
  } catch {
    return { version: 1, status: 'idle', updatedAt: new Date().toISOString() };
  }
}

function writeState(state: Omit<HelperState, 'version' | 'updatedAt'>): HelperState {
  const value: HelperState = { version: 1, ...state, updatedAt: new Date().toISOString() };
  const pending = `${statePath}.new`;
  writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(pending, statePath);
  return value;
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_BODY) throw new Error('request body is too large');
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function exactRequest(value: unknown): ReleaseRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid request');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'digest,releaseId,revision')
    throw new Error('invalid request');
  if (typeof record.releaseId !== 'string' || !UUID.test(record.releaseId))
    throw new Error('invalid release id');
  if (typeof record.revision !== 'string' || !HASH40.test(record.revision))
    throw new Error('invalid revision');
  if (typeof record.digest !== 'string' || !HASH64.test(record.digest))
    throw new Error('invalid digest');
  return { releaseId: record.releaseId, revision: record.revision, digest: record.digest };
}

function filesBelow(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('release contains a symbolic link');
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) result.push(relative(root, path));
      else throw new Error('release contains an unsupported file type');
    }
  };
  visit(root);
  return result;
}

function verifyRelease(input: ReleaseRef, parent = stagingRoot): string {
  const root = resolve(parent, input.releaseId);
  if (dirname(root) !== resolve(parent)) throw new Error('release escaped staging root');
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error('invalid release directory');
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Manifest;
  if (
    manifest.version !== 1 ||
    manifest.target !== 'observatory' ||
    manifest.compatibility !== 1 ||
    manifest.revision !== input.revision ||
    manifest.artifactDigest !== input.digest ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 3
  )
    throw new Error('release manifest does not match the activation request');
  const listed = manifest.files.map((entry) => {
    if (!SAFE_FILE.test(entry.file) || !HASH64.test(entry.sha256))
      throw new Error('invalid release manifest entry');
    const path = resolve(root, entry.file);
    if (!path.startsWith(`${root}/`) || !lstatSync(path).isFile())
      throw new Error('invalid release file');
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (digest !== entry.sha256) throw new Error(`release file checksum mismatch: ${entry.file}`);
    return { file: entry.file, sha256: entry.sha256 };
  });
  const actual = filesBelow(root)
    .filter((file) => file !== 'manifest.json')
    .sort();
  const expected = listed.map((entry) => entry.file).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('release contains unlisted files');
  const digest = createHash('sha256').update(JSON.stringify(listed)).digest('hex');
  if (digest !== input.digest) throw new Error('release aggregate checksum mismatch');
  return root;
}

function runSystemctl(args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('/usr/bin/systemctl', args, { timeout: 60_000 }, (error) =>
      error === null ? resolvePromise() : rejectPromise(error)
    );
  });
}

function healthProbe(): Promise<boolean> {
  const configured = process.env.OBSERVATORY_HOST ?? '127.0.0.1';
  const host = configured === '0.0.0.0' || configured === '::' ? '127.0.0.1' : configured;
  const port = Number(process.env.OBSERVATORY_PORT ?? '8090');
  const token = process.env.OBSERVATORY_RELEASE_HEALTH_TOKEN ?? '';
  return new Promise((resolvePromise) => {
    const request = httpRequest(
      {
        host,
        port,
        path: '/api/health',
        method: 'GET',
        timeout: 2_000,
        headers: { authorization: `Bearer ${token}` },
      },
      (response) => {
        response.resume();
        resolvePromise(response.statusCode === 200);
      }
    );
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolvePromise(false));
    request.end();
  });
}

async function waitHealthy(): Promise<boolean> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await healthProbe()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  return false;
}

function switchCurrent(target: string): void {
  const pending = `${currentLink}.new`;
  rmSync(pending, { force: true });
  symlinkSync(target, pending);
  renameSync(pending, currentLink);
}

function currentTarget(): string | undefined {
  try {
    return readlinkSync(currentLink);
  } catch {
    return undefined;
  }
}

function prepareRelease(input: ReleaseRef): void {
  const source = verifyRelease(input);
  const parent = join(activeRoot, 'releases');
  const destination = join(parent, input.releaseId);
  if (!existsSync(destination)) {
    const pendingRoot = join(activeRoot, '.installing');
    const pending = join(pendingRoot, input.releaseId);
    mkdirSync(pendingRoot, { recursive: true, mode: 0o700 });
    rmSync(pending, { recursive: true, force: true });
    try {
      cpSync(source, pending, { recursive: true, errorOnExist: true, force: false });
      // Check the copied snapshot, not just the mutable staging directory.
      verifyRelease(input, pendingRoot);
      normalizeReleasePermissions(pending);
      renameSync(pending, destination);
    } finally {
      rmSync(pending, { recursive: true, force: true });
    }
  } else {
    verifyRelease(input, parent);
    normalizeReleasePermissions(destination);
  }
}

const lifecycle = createReleaseLifecycle({
  readState,
  writeState,
  currentTarget,
  switchCurrent,
  prepare: prepareRelease,
  hasRelease: (input) => existsSync(join(activeRoot, 'releases', input.releaseId)),
  restartAndCheck: () => restartReleaseServices(runSystemctl, waitHealthy),
});

mkdirSync(join(activeRoot, 'releases'), { recursive: true, mode: 0o750 });
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o750 });
rmSync(socketPath, { force: true });
const startupState = readState();
let busy = startupState.status === 'activating';
if (busy) {
  void lifecycle.recoverInterrupted().finally(() => {
    busy = false;
  });
}
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/v1/status')
      return json(response, 200, readState());
    if (request.method === 'POST' && request.url === '/v1/activate') {
      if (busy) return json(response, 409, { error: 'another release operation is running' });
      const input = exactRequest(await body(request));
      busy = true;
      const previous = readState();
      writeState({
        status: 'activating',
        current: previous.current,
        previous: previous.previous,
        pending: input,
        message: `activating ${input.revision.slice(0, 12)}`,
      });
      json(response, 202, { accepted: true });
      setImmediate(
        () =>
          void lifecycle.activate(input).finally(() => {
            busy = false;
          })
      );
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/rollback') {
      if (busy) return json(response, 409, { error: 'another release operation is running' });
      busy = true;
      const previous = readState();
      writeState({
        status: 'activating',
        current: previous.current,
        previous: previous.previous,
        pending: previous.previous,
        message: 'rolling back to the previous release',
      });
      json(response, 202, { accepted: true });
      setImmediate(
        () =>
          void lifecycle.rollback().finally(() => {
            busy = false;
          })
      );
      return;
    }
    json(response, 404, { error: 'unknown endpoint' });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : 'invalid request' });
  }
});
server.listen(socketPath, () => chmodSync(socketPath, 0o660));
