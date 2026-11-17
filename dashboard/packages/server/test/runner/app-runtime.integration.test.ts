import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NewProjectFactory } from '../../src/runner/new-project.js';
import { AppPreviewManager } from '../../src/runner/app-preview.js';
import { AgentTaskStore } from '../../src/runner/task-store.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe.runIf(
  process.env.B70_RELEASE_BUILD !== '1' &&
    process.platform === 'linux' &&
    existsSync('/usr/bin/bwrap')
)('managed app real sandbox', () => {
  it('serves a committed app through its bridge, protects source and keeps data after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bar-'));
    roots.push(root);
    const store = new AgentTaskStore(join(root, 'tasks.sqlite'));
    const manager = new AppPreviewManager(join(root, 'a'), resolve('../runner/dist'), '127.0.0.1');
    try {
      const project = await new NewProjectFactory(join(root, 'p'), store).create({
        name: 'Runtime fixture',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        source: { kind: 'app' },
      });
      writeFileSync(
        join(project.repositoryPath, 'server.mjs'),
        `
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const path = join(process.env.B70_APP_DATA, 'counter');
createServer(async (_request, response) => {
 let writable = true;
 let socketWritable = true;
 try { await writeFile('/app-socket/should-not-exist', 'bad'); } catch { socketWritable = false; }
 try { await writeFile('/workspace/should-not-exist', 'bad'); } catch { writable = false; }
 let n = Number(await readFile(path, 'utf8').catch(() => '0')) + 1;
 await writeFile(path, String(n));
 response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ n, writable, socketWritable }));
}).listen(Number(process.env.PORT), '127.0.0.1');
`
      );
      execFileSync('/usr/bin/git', ['-C', project.repositoryPath, 'add', '.']);
      execFileSync('/usr/bin/git', [
        '-C',
        project.repositoryPath,
        'commit',
        '-qm',
        'Runtime fixture',
      ]);
      const revision = execFileSync(
        '/usr/bin/git',
        ['-C', project.repositoryPath, 'rev-parse', 'HEAD'],
        { encoding: 'utf8' }
      ).trim();
      const open = async (): Promise<{ n: number; writable: boolean; socketWritable: boolean }> => {
        const state = await manager.start(project.id, project.repositoryPath, revision);
        expect(state.status).toBe('running');
        expect(state.revision).toBe(revision);
        const url = `http://127.0.0.1:${state.port}`;
        const entry = await fetch(url + state.accessPath, { redirect: 'manual' });
        const cookie = entry.headers.get('set-cookie')!.split(';')[0]!;
        const response = await fetch(url, { headers: { cookie } });
        expect(response.status).toBe(200);
        return (await response.json()) as { n: number; writable: boolean; socketWritable: boolean };
      };
      const first = await open();
      expect(first.writable).toBe(false);
      expect(first.socketWritable).toBe(false);
      expect(manager.status(project.id).status).toBe('running');
      expect((await manager.stop(project.id)).status).toBe('stopped');
      const stored = Number(readFileSync(join(root, 'a', project.id, 'data', 'counter'), 'utf8'));
      const second = await open();
      expect(second.n).toBeGreaterThan(stored);
      expect(second.writable).toBe(false);
      expect(existsSync(join(project.repositoryPath, 'should-not-exist'))).toBe(false);
      const others = [
        manager.start('22222222-2222-4222-8222-222222222222', project.repositoryPath, revision),
        manager.start('33333333-3333-4333-8333-333333333333', project.repositoryPath, revision),
      ];
      await expect(
        manager.start('44444444-4444-4444-8444-444444444444', project.repositoryPath, revision)
      ).rejects.toThrow('at most three');
      await Promise.all(others);
    } finally {
      await manager.close();
      store.close();
    }
  }, 30_000);
});
