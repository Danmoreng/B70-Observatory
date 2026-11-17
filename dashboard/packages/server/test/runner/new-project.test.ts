import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateAgentProjectRequestSchema } from '@observatory/contracts';
import { NewProjectFactory } from '../../src/runner/new-project.js';
import { AgentTaskStore } from '../../src/runner/task-store.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('managed project creation', () => {
  it('creates an independent committed app and reuses concurrent retries without losing changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bnp-'));
    roots.push(root);
    const store = new AgentTaskStore(join(root, 'tasks.sqlite'));
    try {
      const factory = new NewProjectFactory(join(root, 'projects'), store);
      const input = CreateAgentProjectRequestSchema.parse({
        name: 'My app',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        source: { kind: 'app' },
      });
      const [one, two] = await Promise.all([factory.create(input), factory.create(input)]);
      expect(one.id).toBe(two.id);
      expect(one.repositoryPath).toContain(input.idempotencyKey);
      expect(readFileSync(join(one.repositoryPath, 'server.mjs'), 'utf8')).toContain(
        'process.env.PORT'
      );
      expect(
        execFileSync('/usr/bin/git', ['-C', one.repositoryPath, 'status', '--porcelain'], {
          encoding: 'utf8',
        })
      ).toBe('');
      expect(
        execFileSync('/usr/bin/git', ['-C', one.repositoryPath, 'branch', '--show-current'], {
          encoding: 'utf8',
        }).trim()
      ).toBe('main');
      expect(store.listProjects()).toHaveLength(1);
      await expect(factory.create({ ...input, name: 'Different' })).rejects.toThrow(
        'different content'
      );
      execFileSync('/usr/bin/node', ['--check', join(one.repositoryPath, 'server.mjs')]);
    } finally {
      store.close();
    }
  });
  it.each([
    'http://github.com/owner/repo',
    'https://github.com/owner/repo?token=secret',
    'https://user:pass@github.com/owner/repo',
    'https://evil.example/owner/repo',
    'file:///tmp/repo',
    'git@github.com:owner/repo.git',
    'https://github.com/owner/..',
    'https://github.com/owner/repo/tree/main',
  ])('rejects unsupported URL %s before git', (url) => {
    expect(
      CreateAgentProjectRequestSchema.safeParse({
        name: 'repo',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        source: { kind: 'github', url },
      }).success
    ).toBe(false);
  });
  it.runIf(process.env.B70_GITHUB_SMOKE === '1')(
    'clones a real public GitHub repository without credentials',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'bgh-'));
      roots.push(root);
      const store = new AgentTaskStore(join(root, 'tasks.sqlite'));
      try {
        const project = await new NewProjectFactory(join(root, 'projects'), store).create({
          name: 'GitHub smoke',
          idempotencyKey: '22222222-2222-4222-8222-222222222222',
          source: { kind: 'github', url: 'https://github.com/octocat/Hello-World.git' },
        });
        expect(readFileSync(join(project.repositoryPath, 'README'), 'utf8')).toContain(
          'Hello World'
        );
        expect(
          execFileSync('/usr/bin/git', ['-C', project.repositoryPath, 'branch', '--show-current'], {
            encoding: 'utf8',
          }).trim()
        ).toBe('main');
      } finally {
        store.close();
      }
    },
    125_000
  );

  it('accepts a public GitHub HTTPS URL', () => {
    expect(
      CreateAgentProjectRequestSchema.safeParse({
        name: 'repo',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        source: { kind: 'github', url: 'https://github.com/octocat/Hello-World.git' },
      }).success
    ).toBe(true);
  });
});
