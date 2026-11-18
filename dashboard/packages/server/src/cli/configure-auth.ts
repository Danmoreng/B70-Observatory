import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createOpaqueToken, createPasswordHash, hashOpaqueToken } from '../auth/crypto.js';
import type { ParsedEnvFile } from './configure-auth-file.js';
import {
  changePassword,
  parseEnvFile,
  renderEnvFile,
  renderInitialLanConfig,
  rotateCredentials,
  validateHost,
  writeEnvFileAtomic,
} from './configure-auth-file.js';

/**
 * Interactive credential setup for the Observatory LAN configuration
 * (`data/observatory.env`):
 *
 * - first run (file does not exist): writes the fixed LAN block with a new
 *   password and a new gateway token; the token is shown exactly once
 * - `--force` on an existing file: rotates the password hash AND the
 *   gateway token hash, preserving every other line (runner, release
 *   helper, custom paths, unrelated settings, comments) exactly; only an
 *   explicit `--host HOST` additionally changes `OBSERVATORY_HOST`
 * - `--password-only` on an existing file: rewrites exactly the
 *   `OBSERVATORY_PASSWORD_HASH` value and nothing else
 *
 * Malformed or ambiguous input (invalid lines, duplicate keys, missing
 * credential keys) aborts before any write, so the original file is always
 * left intact. Existing secrets are never printed.
 */

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdin.setRawMode === undefined) {
    throw new Error('interactive terminal required');
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolveInput, reject) => {
    let value = '';
    const decoder = new StringDecoder('utf8');
    const cleanup = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
    };
    const finish = (): void => {
      value += decoder.end();
      cleanup();
      resolveInput(value);
    };
    const onData = (data: Buffer): void => {
      let start = 0;
      for (let index = 0; index < data.length; index += 1) {
        const byte = data[index];
        if (byte !== 3 && byte !== 8 && byte !== 10 && byte !== 13 && byte !== 127) continue;
        if (index > start) value += decoder.write(data.subarray(start, index));
        start = index + 1;
        if (byte === 3) {
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (byte === 8 || byte === 127) {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        finish();
        return;
      }
      if (start < data.length) value += decoder.write(data.subarray(start));
    };
    process.stdin.on('data', onData);
  });
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function defaultLanHost(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (
        address.family === 'IPv4' &&
        !address.internal &&
        (/^10\./.test(address.address) ||
          /^192\.168\./.test(address.address) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(address.address))
      ) {
        return address.address;
      }
    }
  }
  return '0.0.0.0';
}

async function main(): Promise<void> {
  const output = resolve(argument('--output') ?? 'data/observatory.env');
  const force = process.argv.includes('--force');
  const passwordOnly = process.argv.includes('--password-only');
  if (force && passwordOnly) {
    throw new Error('--force and --password-only cannot be combined');
  }
  const hostArgument = argument('--host');
  if (hostArgument !== undefined) validateHost(hostArgument);
  if (passwordOnly && hostArgument !== undefined) {
    throw new Error(
      '--password-only changes only the password hash; to change OBSERVATORY_HOST ' +
        'use --force --host HOST (that also rotates the gateway token)'
    );
  }
  const exists = existsSync(output);
  // Validate the existing file before asking for a new password: malformed
  // or ambiguous input must abort without prompting and without writing.
  let existing: ParsedEnvFile | undefined;
  if (exists) existing = safeParse(output, readFileSync(output, 'utf8'));
  if (passwordOnly && !exists) {
    throw new Error(`${output} does not exist; create the LAN configuration first`);
  }
  if (exists && !force && !passwordOnly) {
    throw new Error(`${output} already exists; use --force to rotate credentials`);
  }

  const password = await readHidden('Neues Observatory-Passwort: ');
  const confirmation = await readHidden('Passwort wiederholen: ');
  if (password !== confirmation) throw new Error('passwords do not match');
  if (password.length < 8) throw new Error('password must contain at least 8 characters');

  const passwordHash = await createPasswordHash(password);
  const projectRoot = resolve('.');
  let gatewayToken: string | undefined;
  let content: string;
  if (existing === undefined) {
    gatewayToken = createOpaqueToken();
    content = renderInitialLanConfig({
      host: hostArgument ?? defaultLanHost(),
      dbPath: resolve(projectRoot, argument('--db-path') ?? 'data/observatory.db'),
      webRoot: resolve(projectRoot, 'packages/web/dist'),
      passwordHash,
      gatewayTokenHash: hashOpaqueToken(gatewayToken),
    });
  } else {
    if (passwordOnly) {
      content = renderEnvFile(changePassword(existing, passwordHash));
    } else {
      // Intentional: --force rotates the gateway token as well so a
      // leaked token hash can be revoked; only the hash is persisted.
      gatewayToken = createOpaqueToken();
      content = renderEnvFile(
        rotateCredentials(existing, {
          passwordHash,
          gatewayTokenHash: hashOpaqueToken(gatewayToken),
          host: hostArgument,
        })
      );
    }
  }
  writeEnvFileAtomic(output, content);
  console.log(`\nKonfiguration geschrieben: ${output}`);
  if (gatewayToken !== undefined) {
    console.log('Gateway-Token (wird nur dieses eine Mal angezeigt):');
    console.log(gatewayToken);
  } else {
    console.log(
      'Nur das Observatory-Passwort wurde geändert; übrige Einstellungen bleiben gleich.'
    );
  }
  console.log('\nEine Passwortrotation macht bestehende Browser-Sitzungen automatisch ungültig.');
}

/** Parse an existing file, prefixing diagnostics with the file path. */
function safeParse(output: string, current: string): ParsedEnvFile {
  try {
    return parseEnvFile(current);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unparseable content';
    throw new Error(`${output}: ${message}`);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'configuration failed';
  console.error(`[observatory] ${message}`);
  process.exitCode = 1;
});
