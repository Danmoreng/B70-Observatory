import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashOpaqueToken, createPasswordHash } from '../../src/auth/crypto.js';
import {
  HOST_KEY,
  changePassword,
  parseEnvFile,
  renderEnvFile,
  renderInitialLanConfig,
  rotateCredentials,
  validateHost,
  writeEnvFileAtomic,
} from '../../src/cli/configure-auth-file.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

const OLD_PASSWORD = 'dummy-old-password';
const NEW_PASSWORD = 'dummy-new-password';
const OLD_GATEWAY_TOKEN = 'dummy-old-gateway-token';
const NEW_GATEWAY_TOKEN = 'dummy-new-gateway-token';
const RUNNER_TOKEN = '9f'.repeat(32);
const RELEASE_TOKEN = '2c'.repeat(32);
const OLD_HOST = '192.168.50.10';
const NEW_HOST = '10.9.8.7';

let oldPasswordHash = '';
let newPasswordHash = '';
let oldGatewayHash = '';
let newGatewayHash = '';

/**
 * A realistic configuration after `npm run configure` plus an isolated
 * runner (`ops/configure-runner.ts`) and a release-helper token: fixed LAN
 * block, comments, runner, release-helper and custom/unrelated settings.
 */
let baseline = '';

beforeAll(async () => {
  oldPasswordHash = await createPasswordHash(OLD_PASSWORD);
  newPasswordHash = await createPasswordHash(NEW_PASSWORD);
  oldGatewayHash = hashOpaqueToken(OLD_GATEWAY_TOKEN);
  newGatewayHash = hashOpaqueToken(NEW_GATEWAY_TOKEN);
  baseline = [
    '# Observatory LAN configuration',
    'OBSERVATORY_MODE=lan',
    `OBSERVATORY_HOST=${OLD_HOST}`,
    'OBSERVATORY_PORT=8090',
    'OBSERVATORY_DB_PATH=/var/lib/local-ai-b70/observatory.db',
    'OBSERVATORY_WEB_ROOT=/srv/local-ai-b70/web',
    'OBSERVATORY_SESSION_DAYS=30',
    'OBSERVATORY_COOKIE_SECURE=false',
    `OBSERVATORY_PASSWORD_HASH=${oldPasswordHash}`,
    `OBSERVATORY_GATEWAY_TOKEN_HASH=${oldGatewayHash}`,
    '',
    '# Isolated coding runner (M5D)',
    'OBSERVATORY_AGENT_EXECUTION_MODE=isolated',
    'OBSERVATORY_AGENT_RUNNER_SOCKET=/run/local-ai-b70-runner/control.sock',
    `OBSERVATORY_AGENT_RUNNER_TOKEN=${RUNNER_TOKEN}`,
    '',
    '# Release helper',
    `OBSERVATORY_RELEASE_HEALTH_TOKEN=${RELEASE_TOKEN}`,
    '',
    '# Custom retention for this machine',
    'OBSERVATORY_RETENTION_DAYS=14',
    '',
  ].join('\n');
});

function lineNumbers(content: string, prefix: string): number[] {
  return content
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.startsWith(prefix))
    .map(({ index }) => index);
}

/** 1-based line indexes where the two files differ. */
function changedLines(a: string, b: string): number[] {
  const left = a.split('\n');
  const right = b.split('\n');
  const size = Math.max(left.length, right.length);
  const indexes: number[] = [];
  for (let i = 0; i < size; i += 1) {
    if (left[i] !== right[i]) indexes.push(i + 1);
  }
  return indexes;
}

describe('parseEnvFile (input validation)', () => {
  it('round-trips a well-formed file byte-for-byte', () => {
    expect(renderEnvFile(parseEnvFile(baseline))).toBe(baseline);
  });

  it('treats space-only lines as blank and keeps them intact', () => {
    const content = 'OBSERVATORY_MODE=lan\n   \nOBSERVATORY_PORT=8090\n';
    const parsed = parseEnvFile(content);
    expect(parsed.entries[1]?.kind).toBe('blank');
    expect(renderEnvFile(parsed)).toBe(content);
  });

  it('rejects a line that is neither blank, a comment nor an assignment', () => {
    for (const invalid of [
      `${baseline}\nOBSERVATORY_HOST ${OLD_HOST}\n`,
      `${baseline}\n  OBSERVATORY_PORT=8090\n`,
      `${baseline}\nexport OBSERVATORY_PORT=8090\n`,
      `${baseline}\njust some text\n`,
    ]) {
      expect(() => parseEnvFile(invalid)).toThrow(
        /neither a blank line, a comment nor a KEY=VALUE assignment/
      );
    }
  });

  it('rejects duplicate keys instead of silently choosing one', () => {
    const content = `${baseline}\n${HOST_KEY}=${NEW_HOST}\n`;
    expect(() => parseEnvFile(content)).toThrow(/key OBSERVATORY_HOST is set on multiple lines/);
    const duplicatedHash = baseline.replace(
      `OBSERVATORY_PORT=8090`,
      'OBSERVATORY_PORT=8090\nOBSERVATORY_PASSWORD_HASH=something-else'
    );
    expect(() => parseEnvFile(duplicatedHash)).toThrow(
      /key OBSERVATORY_PASSWORD_HASH is set on multiple lines/
    );
  });

  it('rejects CRLF line endings and NUL bytes', () => {
    expect(() => parseEnvFile('OBSERVATORY_MODE=lan\r\n')).toThrow(/CRLF/);
    expect(() => parseEnvFile('OBSERVATORY_MODE=la\nN\r')).toThrow(/CRLF/);
    expect(() => parseEnvFile('OBSERVATORY_MODE=lan\u0000')).toThrow(/NUL/);
  });
});

describe('rotateCredentials (--force)', () => {
  it('rotates password and gateway token but preserves every other line', () => {
    const rotated = renderEnvFile(
      rotateCredentials(parseEnvFile(baseline), {
        passwordHash: newPasswordHash,
        gatewayTokenHash: newGatewayHash,
      })
    );
    const expectedChanges = [
      ...lineNumbers(baseline, `OBSERVATORY_PASSWORD_HASH=`),
      ...lineNumbers(baseline, `OBSERVATORY_GATEWAY_TOKEN_HASH=`),
    ].sort();
    expect(changedLines(baseline, rotated).sort()).toEqual(expectedChanges);
    // Credential rotation is explicit and complete:
    expect(rotated).toContain(`OBSERVATORY_PASSWORD_HASH=${newPasswordHash}`);
    expect(rotated).toContain(`OBSERVATORY_GATEWAY_TOKEN_HASH=${newGatewayHash}`);
    expect(rotated).not.toContain(oldPasswordHash);
    expect(rotated).not.toContain(oldGatewayHash);
    // Existing non-auth configuration survives byte-for-byte:
    expect(rotated).toContain('OBSERVATORY_HOST=192.168.50.10');
    expect(rotated).toContain('OBSERVATORY_DB_PATH=/var/lib/local-ai-b70/observatory.db');
    expect(rotated).toContain('OBSERVATORY_WEB_ROOT=/srv/local-ai-b70/web');
    expect(rotated).toContain('OBSERVATORY_AGENT_EXECUTION_MODE=isolated');
    expect(rotated).toContain(
      'OBSERVATORY_AGENT_RUNNER_SOCKET=/run/local-ai-b70-runner/control.sock'
    );
    expect(rotated).toContain(`OBSERVATORY_AGENT_RUNNER_TOKEN=${RUNNER_TOKEN}`);
    expect(rotated).toContain(`OBSERVATORY_RELEASE_HEALTH_TOKEN=${RELEASE_TOKEN}`);
    expect(rotated).toContain('OBSERVATORY_RETENTION_DAYS=14');
    expect(rotated).toContain('# Isolated coding runner (M5D)');
  });

  it('keeps the stored host unless --host changes it explicitly', () => {
    const withoutHost = rotateCredentials(parseEnvFile(baseline), {
      passwordHash: newPasswordHash,
      gatewayTokenHash: newGatewayHash,
    });
    expect(renderEnvFile(withoutHost)).toContain(`OBSERVATORY_HOST=${OLD_HOST}`);
    const withHost = renderEnvFile(
      rotateCredentials(parseEnvFile(baseline), {
        passwordHash: newPasswordHash,
        gatewayTokenHash: newGatewayHash,
        host: NEW_HOST,
      })
    );
    expect(changedLines(baseline, withHost).sort()).toEqual(
      [
        ...lineNumbers(baseline, 'OBSERVATORY_HOST='),
        ...lineNumbers(baseline, `OBSERVATORY_PASSWORD_HASH=`),
        ...lineNumbers(baseline, `OBSERVATORY_GATEWAY_TOKEN_HASH=`),
      ].sort()
    );
    expect(withHost).toContain(`OBSERVATORY_HOST=${NEW_HOST}`);
    expect(withHost).not.toContain(`OBSERVATORY_HOST=${OLD_HOST}`);
    expect(withHost).toContain(`OBSERVATORY_GATEWAY_TOKEN_HASH=${newGatewayHash}`);
  });

  it('inserts OBSERVATORY_HOST after OBSERVATORY_MODE when the key is absent', () => {
    const content = baseline.replace(`OBSERVATORY_HOST=${OLD_HOST}\n`, '');
    const result = renderEnvFile(
      rotateCredentials(parseEnvFile(content), {
        passwordHash: newPasswordHash,
        gatewayTokenHash: newGatewayHash,
        host: NEW_HOST,
      })
    );
    expect(result).toContain(
      'OBSERVATORY_MODE=lan\nOBSERVATORY_HOST=10.9.8.7\nOBSERVATORY_PORT=8090'
    );
  });

  it('rejects a file without the credential keys instead of regenerating it', () => {
    const missingPassword = baseline
      .split('\n')
      .filter((line) => !line.startsWith('OBSERVATORY_PASSWORD_HASH='))
      .join('\n');
    expect(() =>
      rotateCredentials(parseEnvFile(missingPassword), {
        passwordHash: newPasswordHash,
        gatewayTokenHash: newGatewayHash,
      })
    ).toThrow(/OBSERVATORY_PASSWORD_HASH is missing/);
    const missingGateway = baseline
      .split('\n')
      .filter((line) => !line.startsWith('OBSERVATORY_GATEWAY_TOKEN_HASH='))
      .join('\n');
    expect(() =>
      rotateCredentials(parseEnvFile(missingGateway), {
        passwordHash: newPasswordHash,
        gatewayTokenHash: newGatewayHash,
      })
    ).toThrow(/OBSERVATORY_GATEWAY_TOKEN_HASH is missing/);
  });

  it('rejects malformed hashes and malformed hosts', () => {
    expect(() =>
      rotateCredentials(parseEnvFile(baseline), {
        passwordHash: 'not-a-hash',
        gatewayTokenHash: newGatewayHash,
      })
    ).toThrow(/invalid password hash/);
    expect(() =>
      rotateCredentials(parseEnvFile(baseline), {
        passwordHash: newPasswordHash,
        gatewayTokenHash: 'XYZ'.repeat(21) + 'x',
      })
    ).toThrow(/invalid gateway token hash/);
    expect(() =>
      rotateCredentials(parseEnvFile(baseline), {
        passwordHash: newPasswordHash,
        gatewayTokenHash: newGatewayHash,
        host: 'bad host',
      })
    ).toThrow(/not a valid host/);
  });
});

describe('changePassword (--password-only)', () => {
  it('changes exactly the password hash line and nothing else', () => {
    const result = renderEnvFile(changePassword(parseEnvFile(baseline), newPasswordHash));
    expect(changedLines(baseline, result)).toEqual(
      lineNumbers(baseline, 'OBSERVATORY_PASSWORD_HASH=')
    );
    expect(result).toContain(`OBSERVATORY_PASSWORD_HASH=${newPasswordHash}`);
    expect(result).toContain(`OBSERVATORY_GATEWAY_TOKEN_HASH=${oldGatewayHash}`);
    expect(result).toContain(`OBSERVATORY_AGENT_RUNNER_TOKEN=${RUNNER_TOKEN}`);
    expect(result).toContain(`OBSERVATORY_RELEASE_HEALTH_TOKEN=${RELEASE_TOKEN}`);
  });

  it('rejects a file without a password hash', () => {
    const content = baseline
      .split('\n')
      .filter((line) => !line.startsWith('OBSERVATORY_PASSWORD_HASH='))
      .join('\n');
    expect(() => changePassword(parseEnvFile(content), newPasswordHash)).toThrow(
      /OBSERVATORY_PASSWORD_HASH is missing/
    );
  });

  it('rejects a malformed hash', () => {
    expect(() => changePassword(parseEnvFile(baseline), 'insecure')).toThrow(
      /invalid password hash/
    );
  });
});

describe('renderInitialLanConfig (first run)', () => {
  it('writes the fixed LAN block and stores only the gateway token hash', () => {
    const content = renderInitialLanConfig({
      host: NEW_HOST,
      dbPath: '/var/lib/local-ai-b70/observatory.db',
      webRoot: '/srv/local-ai-b70/web',
      passwordHash: newPasswordHash,
      gatewayTokenHash: newGatewayHash,
    });
    expect(content.split('\n')).toEqual([
      'OBSERVATORY_MODE=lan',
      `OBSERVATORY_HOST=${NEW_HOST}`,
      'OBSERVATORY_PORT=8090',
      'OBSERVATORY_DB_PATH=/var/lib/local-ai-b70/observatory.db',
      'OBSERVATORY_WEB_ROOT=/srv/local-ai-b70/web',
      'OBSERVATORY_SESSION_DAYS=30',
      'OBSERVATORY_COOKIE_SECURE=false',
      `OBSERVATORY_PASSWORD_HASH=${newPasswordHash}`,
      `OBSERVATORY_GATEWAY_TOKEN_HASH=${newGatewayHash}`,
      '',
    ]);
  });

  it('verifies the persisted hash matches the token the CLI prints once', () => {
    const token = 'shown-once-gateway-token';
    const content = renderInitialLanConfig({
      host: NEW_HOST,
      dbPath: '/x/y.db',
      webRoot: '/z/web',
      passwordHash: newPasswordHash,
      gatewayTokenHash: hashOpaqueToken(token),
    });
    expect(content).toContain(`OBSERVATORY_GATEWAY_TOKEN_HASH=${hashOpaqueToken(token)}`);
    expect(content).not.toContain(token);
  });

  it('rejects invalid hosts and hashes', () => {
    for (const host of ['', 'bad host', 'a '.repeat(256)]) {
      expect(() =>
        renderInitialLanConfig({
          host,
          dbPath: '/x',
          webRoot: '/y',
          passwordHash: newPasswordHash,
          gatewayTokenHash: newGatewayHash,
        })
      ).toThrow();
    }
    expect(() =>
      renderInitialLanConfig({
        host: NEW_HOST,
        dbPath: '/x',
        webRoot: '/y',
        passwordHash: 'nope',
        gatewayTokenHash: newGatewayHash,
      })
    ).toThrow(/invalid password hash/);
  });
});

describe('validateHost', () => {
  it('accepts host names, IPv4 and IPv6 addresses', () => {
    for (const host of ['192.168.1.10', 'gateway.local', '::1', '0.0.0.0']) {
      expect(() => validateHost(host)).not.toThrow();
    }
  });

  it('rejects empty, oversized and malformed hosts', () => {
    expect(() => validateHost('')).toThrow(/non-empty/);
    expect(() => validateHost('a'.repeat(256))).toThrow(/non-empty/);
    expect(() => validateHost('bad host')).toThrow(/not a valid host/);
    expect(() => validateHost('host=8090')).toThrow(/not a valid host/);
  });
});

describe('writeEnvFileAtomic', () => {
  let root: string;

  beforeAll(() => {
    root = `${tmpdir()}/b70-configure-auth-${process.pid}`;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true, mode: 0o700 });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the file with mode 0600 and creates missing parent directories', () => {
    const target = join(root, 'fresh', 'nested', 'observatory.env');
    writeEnvFileAtomic(target, baseline);
    expect(readFileSync(target, 'utf8')).toBe(baseline);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('re-locks an existing 0644 file to 0600 on rotation', () => {
    const target = join(root, 'loose.env');
    writeFileSync(target, baseline, { mode: 0o644 });
    writeEnvFileAtomic(target, `${baseline}OBSERVATORY_RETENTION_DAYS=21\n`);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('leaves the original file intact and cleans up the temporary file on failure', () => {
    const untouched = join(root, 'sibling.env');
    writeFileSync(untouched, baseline);
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'a regular file, not a directory');
    expect(() => writeEnvFileAtomic(join(blocker, 'child.env'), baseline)).toThrow();
    expect(readFileSync(untouched, 'utf8')).toBe(baseline);
    expect(readFileSync(blocker, 'utf8')).toBe('a regular file, not a directory');
    const leftovers = readdirSync(root).filter((entry) => entry.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('CLI process behavior (no TTY, dummy credentials)', () => {
  const entry = resolve(here, '..', '..', 'src', 'cli', 'configure-auth.ts');
  const tsx = join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
  let root: string;

  interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
  }

  function runCli(flags: string[], file: string): Promise<RunResult> {
    return new Promise((resolveRun) => {
      const child = spawn(process.execPath, [tsx, entry, ...flags, '--output', file], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: repoRoot,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.on('close', (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
    });
  }

  beforeAll(() => {
    root = `${tmpdir()}/b70-configure-auth-cli-${process.pid}`;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true, mode: 0o700 });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('aborts initial setup without a TTY and creates no file', async () => {
    const file = join(root, 'fresh.env');
    const result = await runCli(['--host', NEW_HOST], file);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('interactive terminal required');
    expect(existsSync(file)).toBe(false);
  });

  it('aborts --password-only without a TTY and leaves the file intact', async () => {
    const file = join(root, 'password-only.env');
    writeFileSync(file, baseline, { mode: 0o600 });
    const result = await runCli(['--password-only'], file);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('interactive terminal required');
    expect(readFileSync(file, 'utf8')).toBe(baseline);
  });

  it('refuses to combine --force and --password-only', async () => {
    const file = join(root, 'combined.env');
    writeFileSync(file, baseline, { mode: 0o600 });
    const result = await runCli(['--force', '--password-only'], file);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot be combined');
    expect(readFileSync(file, 'utf8')).toBe(baseline);
  });

  it('refuses a host change together with --password-only', async () => {
    const file = join(root, 'host.env');
    writeFileSync(file, baseline, { mode: 0o600 });
    const result = await runCli(['--password-only', '--host', NEW_HOST], file);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('changes only the password hash');
    expect(readFileSync(file, 'utf8')).toBe(baseline);
  });

  it('aborts on malformed input before prompting and never prints existing secrets', async () => {
    const file = join(root, 'malformed.env');
    const malformed = `${baseline}\nthis line is not an assignment\n`;
    writeFileSync(file, malformed, { mode: 0o600 });
    const result = await runCli(['--force'], file);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('neither a blank line, a comment nor a KEY=VALUE assignment');
    expect(readFileSync(file, 'utf8')).toBe(malformed);
    // Existing secrets must never be echoed on failure:
    expect(result.stdout + result.stderr).not.toContain(oldPasswordHash);
    expect(result.stdout + result.stderr).not.toContain(oldGatewayHash);
    expect(result.stdout + result.stderr).not.toContain(RUNNER_TOKEN);
    expect(result.stdout + result.stderr).not.toContain(NEW_PASSWORD);
  });

  it('aborts on duplicate keys before prompting and leaves the file intact', async () => {
    const file = join(root, 'duplicate.env');
    const duplicate = `${baseline}\nOBSERVATORY_RELEASE_HEALTH_TOKEN=${'4d'.repeat(32)}\n`;
    writeFileSync(file, duplicate, { mode: 0o600 });
    const result = await runCli(['--force'], file);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('set on multiple lines');
    expect(readFileSync(file, 'utf8')).toBe(duplicate);
  });
});
