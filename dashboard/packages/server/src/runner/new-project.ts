import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentProject, CreateAgentProjectRequest } from '@observatory/contracts';
import { AgentControlError } from '../agent/manager.js';
import type { AgentTaskStore } from './task-store.js';

/** No inherited git config, credentials, filters, hooks or interactive prompts. */
function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...args],
      {
        timeout: 120_000,
        maxBuffer: 256 * 1024,
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '/bin/false',
        },
      },
      (error, stdout) => {
        if (error !== null)
          reject(
            new AgentControlError(
              'protocol',
              'Repository creation failed. For GitHub, use an accessible public HTTPS repository.'
            )
          );
        else resolve(stdout.trim());
      }
    );
  });
}

export const MANAGED_APP_CHECKS = [
  { label: 'Check', argv: ['/usr/bin/npm', 'run', 'check', '--if-present'] },
  { label: 'Typecheck', argv: ['/usr/bin/npm', 'run', 'typecheck', '--if-present'] },
  { label: 'Tests', argv: ['/usr/bin/npm', 'run', 'test', '--if-present'] },
  { label: 'Build', argv: ['/usr/bin/npm', 'run', 'build', '--if-present'] },
];

export const APP_INSTRUCTIONS = `# Local AI application contract

Build the requested application using the stack requested by the user. Public npm packages may be installed using npm install through the sandbox registry relay. General internet and host-network access remain disabled.

- Hosting entry point: server.mjs (a small loader importing your built Node server is fine). npm start must also launch the built application.
- Build step: npm run build, if present, must produce all frontend/server output locally.
- Listening: Listen on process.env.PORT (default 3000), host 127.0.0.1.
- Serve the frontend and backend from that one HTTP server; use relative same-origin URLs.
- Store durable user data ONLY in process.env.B70_APP_DATA, falling back to ./data for local use. The hosted source directory is read-only.
- Never put credentials, model access or dashboard integration in the application.
- Keep npm start, npm test and npm run check working. Use meaningful tests appropriate to the requested stack.
- The user starts the result using the dashboard App panel. Do not claim it is deployed yourself.
- For browser testing during implementation, start your own localhost server in this sandbox.
`;

const SERVER = `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const page = fileURLToPath(new URL('./index.html', import.meta.url));
createServer(async (request, response) => {
  if (request.url === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.url !== '/') { response.writeHead(404); response.end('Not found'); return; }
  try {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(page));
  } catch { response.writeHead(500); response.end('Page unavailable'); }
}).listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => console.log('App ready'));
`;

export class NewProjectFactory {
  private readonly pending = new Map<string, Promise<AgentProject>>();
  constructor(
    private readonly root: string,
    private readonly tasks: AgentTaskStore
  ) {}

  create(input: CreateAgentProjectRequest): Promise<AgentProject> {
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    // Serialize by key; differing concurrent payloads are checked on disk.
    const pendingKey = input.idempotencyKey;
    const previous = this.pending.get(pendingKey);
    const operation = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.prepare(input, digest));
    this.pending.set(pendingKey, operation);
    void operation
      .finally(() => {
        if (this.pending.get(pendingKey) === operation) this.pending.delete(pendingKey);
      })
      .catch(() => undefined);
    return operation;
  }

  private async prepare(input: CreateAgentProjectRequest, digest: string): Promise<AgentProject> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = join(this.root, input.idempotencyKey);
    const repositoryPath = join(directory, 'repository');
    const marker = join(directory, 'request.sha256');
    const existing = await readFile(marker, 'utf8').catch(() => undefined);
    if (existing !== undefined && existing !== digest) {
      throw new AgentControlError(
        'conflict',
        'Project creation key already has different content.'
      );
    }
    const ready = await readFile(join(directory, 'ready'), 'utf8').catch(() => undefined);
    if (existing === undefined || ready !== digest) {
      // Recover an interrupted clone/initialization inside this runner-owned directory.
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { mode: 0o700 });
      await writeFile(marker, digest, { flag: 'wx', mode: 0o600 });
      try {
        if (input.source.kind === 'github') {
          await git([
            'clone',
            '--depth=1',
            '--single-branch',
            '--no-checkout',
            '--',
            input.source.url,
            repositoryPath,
          ]);
          await git(['-C', repositoryPath, 'checkout', '-q', '-B', 'main', 'HEAD']);
        } else {
          await mkdir(repositoryPath, { mode: 0o700 });
          await git(['init', '-q', '-b', 'main', repositoryPath]);
          for (const [name, value] of Object.entries({
            'package.json':
              JSON.stringify(
                {
                  name: 'local-app',
                  private: true,
                  type: 'module',
                  scripts: {
                    start: 'node server.mjs',
                    check: 'node --check server.mjs',
                    test: 'node --test',
                  },
                },
                null,
                2
              ) + '\n',
            'server.mjs': SERVER,
            'index.html':
              '<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Neue App</title><body><main><h1>Dein App-Projekt ist bereit.</h1><p>Die lokale KI setzt hier deinen Auftrag um.</p></main></body></html>\n',
            'AGENTS.md': APP_INSTRUCTIONS,
            'README.md':
              '# Local app\n\nStart: `npm start`. Checks: `npm run check` and `npm test`.\n\nHosting and persistent data: see AGENTS.md.\n',
            '.gitignore': 'node_modules/\ndata/\n*.log\n',
          }))
            await writeFile(join(repositoryPath, name), value, { flag: 'wx', mode: 0o600 });
        }
        await git(['-C', repositoryPath, 'config', 'user.name', 'Local B70 Agent']);
        await git(['-C', repositoryPath, 'config', 'user.email', 'local-agent@b70.invalid']);
        await git(['-C', repositoryPath, 'config', 'core.hooksPath', '/dev/null']);
        await git(['-C', repositoryPath, 'config', 'commit.gpgSign', 'false']);
        if (input.source.kind === 'app') {
          await git(['-C', repositoryPath, 'add', '.']);
          await git(['-C', repositoryPath, 'commit', '-qm', 'Initialize local application']);
        }
        await writeFile(join(directory, 'source-kind'), input.source.kind, {
          flag: 'wx',
          mode: 0o600,
        });
        await writeFile(join(directory, 'ready'), digest, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    }
    return this.tasks.registerProject({
      name: input.name,
      repositoryPath,
      targetBranch: 'main',
      workdir: '.',
      editPaths: ['.'],
      checks: input.source.kind === 'app' ? MANAGED_APP_CHECKS : [],
    });
  }
}
