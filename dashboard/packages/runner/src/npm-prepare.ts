/** Runs dependency installation/build only inside the existing workspace utility sandbox. */
import { spawn } from 'node:child_process';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { startNpmBridge } from './npm-bridge.js';
import { hasStaleRootDependencies } from './npm-lock.js';

const bridge = await startNpmBridge(process.env.B70_NPM_TOKEN ?? '');
const payload = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8')) as {
  build?: boolean;
};
async function command(argv: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/npm', argv, {
      cwd: '/workspace',
      env: { ...process.env, ...bridge.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data: Buffer) => process.stderr.write(data));
    child.stderr.pipe(process.stderr);
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`npm ${argv.join(' ')} failed (${code})`))
    );
  });
}
try {
  let manifest:
    | {
        dependencies?: object;
        devDependencies?: object;
        optionalDependencies?: object;
        workspaces?: unknown;
        scripts?: Record<string, unknown>;
      }
    | undefined;
  try {
    manifest = JSON.parse(await readFile('/workspace/package.json', 'utf8')) as typeof manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (manifest !== undefined) {
    if (
      Object.keys(manifest.dependencies ?? {}).length ||
      Object.keys(manifest.devDependencies ?? {}).length ||
      Object.keys(manifest.optionalDependencies ?? {}).length ||
      manifest.workspaces !== undefined
    ) {
      const lock = await lstat('/workspace/package-lock.json').catch(() => undefined);
      if (payload.build && lock?.isFile()) {
        const contents: unknown = JSON.parse(
          await readFile('/workspace/package-lock.json', 'utf8')
        );
        if (hasStaleRootDependencies(manifest, contents)) {
          process.stderr.write(
            'App preview: package-lock.json disagrees with package.json. Updating the lockfile in this isolated build snapshot before a clean installation.\n'
          );
          await command([
            'install',
            '--package-lock-only',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--loglevel=error',
          ]);
        }
      }
      await command([
        lock?.isFile() ? 'ci' : 'install',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ]);
    }
    // Upgrade only the generated paragraph; custom repository instructions remain untouched.
    const instructions = await readFile('/workspace/AGENTS.md', 'utf8').catch(() => '');
    if (instructions.startsWith('# Local AI application contract')) {
      await writeFile(
        '/workspace/AGENTS.md',
        instructions
          .replace(
            'Build the requested application in this repository using HTML, CSS, browser JavaScript and Node.js built-in modules. The sandbox has no internet or npm downloads. Do not add dependencies requiring installation.',
            'Build the requested application using the stack requested by the user. Public npm packages may be installed using npm install through the sandbox registry relay. General internet and host-network access remain disabled.'
          )
          .replace(
            'Use node:test for meaningful tests.',
            'Use meaningful tests appropriate to the requested stack.'
          )
      );
    }
    if (payload.build && typeof manifest.scripts?.build === 'string')
      await command(['run', 'build']);
  }
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'npm preparation failed',
    })
  );
  process.exitCode = 1;
} finally {
  bridge.close();
}
