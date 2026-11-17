import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Pure, testable logic for the Observatory LAN configuration file
 * (`data/observatory.env`).
 *
 * The file is consumed by systemd (`EnvironmentFile=`) and by Node's
 * `--env-file`, so the accepted line grammar is the strict common subset:
 *
 * - blank lines (including lines that contain only spaces)
 * - comment lines whose first non-space character is `#`
 * - assignment lines `KEY=VALUE` starting in the first column
 *
 * Any other line, CRLF line endings, NUL bytes and duplicate keys are
 * rejected. All transforms operate on the parsed file and return new
 * content without ever reading values back to the console, so existing
 * secrets are never printed. The file is only replaced through
 * {@link writeEnvFileAtomic} after the complete new content is valid, so a
 * failing rotation always leaves the original file intact.
 */

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_PATTERN = /^[A-Za-z0-9:.][A-Za-z0-9.:_-]{0,254}$/;

/** Must stay in sync with the pattern `config.ts` validates at startup. */
export const PASSWORD_HASH_PATTERN = /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/;
/** Must stay in sync with the pattern `config.ts` validates at startup. */
export const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;

export const PASSWORD_HASH_KEY = 'OBSERVATORY_PASSWORD_HASH';
export const GATEWAY_TOKEN_HASH_KEY = 'OBSERVATORY_GATEWAY_TOKEN_HASH';
export const HOST_KEY = 'OBSERVATORY_HOST';
const MODE_KEY = 'OBSERVATORY_MODE';

export interface EnvEntry {
  kind: 'blank' | 'comment' | 'assignment';
  /** Verbatim line text; transforms only rewrite whole assignment lines. */
  text: string;
  key?: string;
}

export interface ParsedEnvFile {
  entries: EnvEntry[];
  /** Assignment key -> indexes of the entries that define it. */
  assignmentIndexes: Map<string, number[]>;
}

function indexAssignments(entries: EnvEntry[]): Map<string, number[]> {
  const assignmentIndexes = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    if (entry.kind !== 'assignment' || entry.key === undefined) return;
    const indexes = assignmentIndexes.get(entry.key) ?? [];
    indexes.push(index);
    assignmentIndexes.set(entry.key, indexes);
  });
  return assignmentIndexes;
}

/**
 * Parse the configuration file. Throws on the first malformed or ambiguous
 * line; callers must treat any thrown error as "do not write, keep the
 * original file".
 */
export function parseEnvFile(content: string): ParsedEnvFile {
  if (content.includes('\u0000')) {
    throw new Error('contains a NUL byte; the existing file was not modified');
  }
  if (content.includes('\r')) {
    throw new Error('uses CRLF line endings; only LF line endings are supported');
  }
  const entries: EnvEntry[] = content.split('\n').map((line, index) => {
    if (line === '' || /^[ \t]+$/.test(line)) {
      return { kind: 'blank' as const, text: line };
    }
    if (line.trimStart().startsWith('#')) {
      return { kind: 'comment' as const, text: line };
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    const key = match?.[1];
    if (match === undefined || key === undefined || !ENV_KEY_PATTERN.test(key)) {
      throw new Error(
        `line ${index + 1} is neither a blank line, a comment nor a KEY=VALUE assignment; ` +
          'the existing file was not modified'
      );
    }
    return { kind: 'assignment' as const, text: line, key };
  });
  const assignmentIndexes = indexAssignments(entries);
  for (const [key, indexes] of assignmentIndexes) {
    if (indexes.length > 1) {
      throw new Error(
        `key ${key} is set on multiple lines (${indexes.map((i) => i + 1).join(', ')}); ` +
          'remove the duplicates before rotating credentials'
      );
    }
  }
  return { entries, assignmentIndexes };
}

/** Re-render parsed entries byte-for-byte (including untouched lines). */
export function renderEnvFile(parsed: ParsedEnvFile): string {
  return parsed.entries.map((entry) => entry.text).join('\n');
}

export function validateHost(host: string): void {
  if (host.length === 0 || host.length > 255) {
    throw new Error('--host must be a non-empty host name or IP address of at most 255 characters');
  }
  if (!HOST_PATTERN.test(host)) {
    throw new Error(`--host "${host}" is not a valid host name or IP address`);
  }
}

function requireHash(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`invalid ${label}`);
}

function assignmentIndex(parsed: ParsedEnvFile, key: string): number | undefined {
  return parsed.assignmentIndexes.get(key)?.[0];
}

/**
 * Rotate both credentials of an existing configuration.
 *
 * Only `OBSERVATORY_PASSWORD_HASH` and `OBSERVATORY_GATEWAY_TOKEN_HASH` are
 * replaced in place; every other line (runner, release helper, custom paths,
 * unrelated settings, comments) is preserved byte-for-byte. The gateway
 * token is rotated on purpose: it is the only way to revoke an already
 * stored token hash, and the new token is shown exactly once by the CLI.
 * `host` is applied only when the caller passes it explicitly; otherwise
 * the stored `OBSERVATORY_HOST` is left untouched.
 */
export interface RotationChanges {
  passwordHash: string;
  gatewayTokenHash: string;
  host?: string;
}

export function rotateCredentials(parsed: ParsedEnvFile, changes: RotationChanges): ParsedEnvFile {
  requireHash(changes.passwordHash, PASSWORD_HASH_PATTERN, 'password hash');
  requireHash(changes.gatewayTokenHash, TOKEN_HASH_PATTERN, 'gateway token hash');
  if (changes.host !== undefined) validateHost(changes.host);
  const entries = parsed.entries.map((entry) => ({ ...entry }));
  for (const [key, value] of [
    [PASSWORD_HASH_KEY, changes.passwordHash],
    [GATEWAY_TOKEN_HASH_KEY, changes.gatewayTokenHash],
  ] as const) {
    const index = assignmentIndex(parsed, key);
    if (index === undefined) {
      throw new Error(
        `${key} is missing, so there is nothing to rotate; the existing file was not modified`
      );
    }
    entries[index] = { kind: 'assignment', key, text: `${key}=${value}` };
  }
  if (changes.host !== undefined) {
    const index = assignmentIndex(parsed, HOST_KEY);
    if (index === undefined) {
      const modeIndex = assignmentIndex(parsed, MODE_KEY);
      entries.splice(modeIndex === undefined ? 0 : modeIndex + 1, 0, {
        kind: 'assignment',
        key: HOST_KEY,
        text: `${HOST_KEY}=${changes.host}`,
      });
    } else {
      entries[index] = { kind: 'assignment', key: HOST_KEY, text: `${HOST_KEY}=${changes.host}` };
    }
  }
  return { entries, assignmentIndexes: indexAssignments(entries) };
}

/**
 * Replace the password hash of an existing configuration. This is the
 * narrowest supported change: exactly the `OBSERVATORY_PASSWORD_HASH` value
 * is rewritten; the gateway token hash, the host, the runner configuration
 * and every other line stay untouched, so no other credential is rotated.
 */
export function changePassword(parsed: ParsedEnvFile, passwordHash: string): ParsedEnvFile {
  requireHash(passwordHash, PASSWORD_HASH_PATTERN, 'password hash');
  const entries = parsed.entries.map((entry) => ({ ...entry }));
  const index = assignmentIndex(parsed, PASSWORD_HASH_KEY);
  if (index === undefined) {
    throw new Error(
      `${PASSWORD_HASH_KEY} is missing; run a full rotation with --force instead ` +
        'of a password-only change'
    );
  }
  entries[index] = {
    kind: 'assignment',
    key: PASSWORD_HASH_KEY,
    text: `${PASSWORD_HASH_KEY}=${passwordHash}`,
  };
  return { entries, assignmentIndexes: indexAssignments(entries) };
}

/**
 * The fixed layout used when the configuration file does not exist yet.
 * Only values the caller supplies are written; the gateway token itself is
 * shown once by the CLI, only its hash is stored.
 */
export interface InitialLanConfig {
  host: string;
  dbPath: string;
  webRoot: string;
  passwordHash: string;
  gatewayTokenHash: string;
}

export function renderInitialLanConfig(config: InitialLanConfig): string {
  validateHost(config.host);
  requireHash(config.passwordHash, PASSWORD_HASH_PATTERN, 'password hash');
  requireHash(config.gatewayTokenHash, TOKEN_HASH_PATTERN, 'gateway token hash');
  return [
    'OBSERVATORY_MODE=lan',
    `${HOST_KEY}=${config.host}`,
    'OBSERVATORY_PORT=8090',
    `OBSERVATORY_DB_PATH=${config.dbPath}`,
    `OBSERVATORY_WEB_ROOT=${config.webRoot}`,
    'OBSERVATORY_SESSION_DAYS=30',
    'OBSERVATORY_COOKIE_SECURE=false',
    `${PASSWORD_HASH_KEY}=${config.passwordHash}`,
    `${GATEWAY_TOKEN_HASH_KEY}=${config.gatewayTokenHash}`,
    '',
  ].join('\n');
}

/**
 * Atomically install the new configuration: write to a same-directory
 * temporary file with mode 0600, then rename it over the target. If any
 * step fails the temporary file is removed and the existing file (as well
 * as its permissions) is left exactly as it was.
 */
export function writeEnvFileAtomic(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    closeSync(descriptor);
    descriptor = undefined;
    // Enforce 0600 independently of the process umask.
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}
