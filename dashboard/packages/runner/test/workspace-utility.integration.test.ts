import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchWorkspaceUtility } from '../src/launcher.js';
import { createWorkspaceSnapshot } from '../src/workspace.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function utility(
  workspacePath: string,
  payload: Record<string, unknown>,
  sourcePath?: string
): Promise<Record<string, unknown>> {
  const job = launchWorkspaceUtility({
    runId:
      payload.mode === 'accept'
        ? 'efefefefefefefefefefefefefefefef'
        : 'abababababababababababababababab',
    workspacePath,
    runtimeRoot: resolve(import.meta.dirname, '../dist'),
    runtimeExecutable: 'workspace-utility.js',
    readOnly: ['changes', 'change_image'].includes(String(payload.mode)),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    args: [Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')],
  });
  const chunks: Buffer[] = [];
  job.child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    job.child.once('error', reject);
    job.child.once('exit', resolvePromise);
  });
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  if (code !== 0) throw new Error(String(value.error ?? 'utility failed'));
  return value;
}

describe.runIf(
  process.env.B70_RELEASE_BUILD !== '1' &&
    process.platform === 'linux' &&
    existsSync('/usr/bin/bwrap')
)('workspace result utility', () => {
  it('renders a portrait image from an immutable revision inside the read-only utility sandbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-image-utility-'));
    roots.push(root);
    const repository = join(root, 'repository');
    mkdirSync(repository);
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@invalid');
    execFileSync('/usr/bin/magick', [
      '-size',
      '1600x2400',
      'xc:red',
      join(repository, 'portrait.png'),
    ]);
    git('add', '.');
    git('commit', '-qm', 'image');
    const revision = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(repository, 'portrait.png'), 'later content');
    const result = await utility(repository, {
      mode: 'change_image',
      baseRevision: revision,
      imageRevision: revision,
      imagePath: 'portrait.png',
    });
    const data = Buffer.from(String(result.dataBase64), 'base64');
    expect(
      execFileSync('/usr/bin/magick', ['webp:-', '-format', '%wx%h', 'info:'], {
        input: data,
        encoding: 'utf8',
      })
    ).toBe('800x1200');
    expect(readFileSync(join(repository, 'portrait.png'), 'utf8')).toBe('later content');
    expect(git('rev-parse', 'HEAD').trim()).toBe(revision);
  });
  it('reads live tracked and untracked diffs in the read-only sandbox without a checkpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-live-utility-'));
    roots.push(root);
    const repository = join(root, 'repository');
    mkdirSync(repository);
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@invalid');
    writeFileSync(join(repository, 'README.md'), '# Before\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const baseRevision = git('rev-parse', 'HEAD').trim();
    const index = readFileSync(join(repository, '.git', 'index'));
    writeFileSync(join(repository, 'README.md'), '# After\n');
    writeFileSync(join(repository, 'new.txt'), 'new file\n');
    const result = await utility(repository, { mode: 'changes', baseRevision });
    expect(result.files).toEqual([
      { path: 'README.md', status: 'modified' },
      { path: 'new.txt', status: 'untracked' },
    ]);
    expect(result.diff).toContain('+# After');
    expect(result.truncated).toBe(false);
    expect(git('rev-parse', 'HEAD').trim()).toBe(baseRevision);
    expect(readFileSync(join(repository, '.git', 'index'))).toEqual(index);
  });
  it('keeps image bytes in the checkpoint and exports only a binary filename notice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-binary-result-'));
    roots.push(root);
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args]);
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@invalid');
    writeFileSync(join(root, 'README.md'), '# Base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const baseRevision = git('rev-parse', 'HEAD').toString().trim();
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 0, 255]);
    writeFileSync(join(root, 'image.png'), bytes);
    const result = await utility(root, {
      mode: 'finalize',
      baseRevision,
      workdir: '.',
      editPaths: ['.'],
      checks: [],
    });
    expect(result.ok).toBe(true);
    expect(result.files).toEqual(['image.png']);
    expect(result.diff).toContain('Binary files');
    expect(result.diff).not.toContain('GIT binary patch');
    expect(git('show', String(result.resultRevision) + ':image.png')).toEqual(bytes);
  });
  it('preserves a resumable checkpoint when its display diff exceeds the output budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-large-result-'));
    roots.push(root);
    const repository = join(root, 'repository');
    mkdirSync(repository);
    execFileSync('/usr/bin/git', ['init', '-q', repository]);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Fixture']);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'fixture@invalid']);
    writeFileSync(join(repository, 'README.md'), '# Base\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'base']);
    const baseRevision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const content = 'A meaningful source line repeated for a large result.\n'.repeat(14_000);
    writeFileSync(join(repository, 'large.txt'), content);
    const result = await utility(repository, {
      mode: 'finalize',
      baseRevision,
      workdir: '.',
      editPaths: ['.'],
      checks: [],
    });
    expect(result.ok).toBe(true);
    expect(result.diffTruncated).toBe(true);
    expect(String(result.diff).length).toBeLessThanOrEqual(512 * 1024);
    expect(result.files).toEqual(['large.txt']);
    expect(
      execFileSync(
        '/usr/bin/git',
        ['-C', repository, 'show', `${String(result.resultRevision)}:large.txt`],
        { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }
      )
    ).toBe(content);
  });

  it('checkpoints, checks and accepts an exact result in a second repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-second-project-'));
    roots.push(root);
    const repository = join(root, 'repository');
    const stateRoot = join(root, 'state');
    mkdirSync(repository);
    mkdirSync(stateRoot);
    execFileSync('/usr/bin/git', ['init', '-q', repository]);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Fixture']);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'fixture@invalid']);
    writeFileSync(join(repository, 'README.md'), '# Before\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'base']);
    const baseRevision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const workspace = await createWorkspaceSnapshot({
      repository,
      revision: baseRevision,
      stateRoot,
      runId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
    });
    writeFileSync(join(workspace.path, 'README.md'), '# After\n');

    const finalized = await utility(workspace.path, {
      mode: 'finalize',
      baseRevision,
      workdir: '.',
      editPaths: ['.'],
      checks: [{ label: 'README exists', argv: ['/usr/bin/test', '-f', 'README.md'] }],
    });
    expect(finalized.checkStatus).toBe('passed');
    expect(finalized.files).toEqual(['README.md']);
    expect(String(finalized.diff)).toContain('+# After');

    const accepted = await utility(
      repository,
      {
        mode: 'accept',
        baseRevision,
        resultRevision: finalized.resultRevision,
        sourceWorkspace: '/result',
      },
      workspace.path
    );
    expect(accepted.acceptedRevision).toBe(finalized.resultRevision);
    expect(accepted.targetHead).toBe(finalized.resultRevision);
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('# After\n');
    expect(
      execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    ).toBe(finalized.resultRevision);
  });

  it('accepts idempotently when the target already points at the exact result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-second-project-'));
    roots.push(root);
    const repository = join(root, 'repository');
    const stateRoot = join(root, 'state');
    mkdirSync(repository);
    mkdirSync(stateRoot);
    execFileSync('/usr/bin/git', ['init', '-q', repository]);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Fixture']);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'fixture@invalid']);
    writeFileSync(join(repository, 'README.md'), '# Before\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'base']);
    const baseRevision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const workspace = await createWorkspaceSnapshot({
      repository,
      revision: baseRevision,
      stateRoot,
      runId: 'dddddddddddddddddddddddddddd',
    });
    writeFileSync(join(workspace.path, 'README.md'), '# After\n');
    const finalized = await utility(workspace.path, {
      mode: 'finalize',
      baseRevision,
      workdir: '.',
      editPaths: ['.'],
      checks: [{ label: 'README exists', argv: ['/usr/bin/test', '-f', 'README.md'] }],
    });
    // Simulate a previously interrupted accept that already fast-forwarded
    // the target branch to the result before it could report success.
    execFileSync('/usr/bin/git', [
      '-C',
      repository,
      'fetch',
      '--no-tags',
      workspace.path,
      String(finalized.resultRevision),
    ]);
    execFileSync('/usr/bin/git', ['-C', repository, 'merge', '-q', '--ff-only', 'FETCH_HEAD']);
    const accepted = await utility(
      repository,
      {
        mode: 'accept',
        baseRevision,
        resultRevision: finalized.resultRevision,
        sourceWorkspace: '/result',
      },
      workspace.path
    );
    expect(accepted.acceptedRevision).toBe(finalized.resultRevision);
    expect(accepted.targetHead).toBe(finalized.resultRevision);
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('# After\n');
  });

  it('merges a result when the target advanced without a conflict and accepts retries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-second-project-'));
    roots.push(root);
    const repository = join(root, 'repository');
    const stateRoot = join(root, 'state');
    mkdirSync(repository);
    mkdirSync(stateRoot);
    execFileSync('/usr/bin/git', ['init', '-q', repository]);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Fixture']);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'fixture@invalid']);
    writeFileSync(join(repository, 'README.md'), '# Before\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'base']);
    const baseRevision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const workspace = await createWorkspaceSnapshot({
      repository,
      revision: baseRevision,
      stateRoot,
      runId: 'ffffffffffffffffffffffffffffffff',
    });
    writeFileSync(join(workspace.path, 'README.md'), '# Agent result\n');
    const finalized = await utility(workspace.path, {
      mode: 'finalize',
      baseRevision,
      workdir: '.',
      editPaths: ['.'],
      checks: [{ label: 'README exists', argv: ['/usr/bin/test', '-f', 'README.md'] }],
    });

    writeFileSync(join(repository, 'TARGET.md'), '# Independent target change\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'target advanced']);

    const payload = {
      mode: 'accept',
      baseRevision,
      resultRevision: finalized.resultRevision,
      sourceWorkspace: '/result',
    };
    const accepted = await utility(repository, payload, workspace.path);
    expect(accepted.acceptedRevision).toBe(finalized.resultRevision);
    expect(accepted.targetHead).not.toBe(finalized.resultRevision);
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('# Agent result\n');
    expect(readFileSync(join(repository, 'TARGET.md'), 'utf8')).toBe(
      '# Independent target change\n'
    );
    const mergedRevision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    expect(mergedRevision).not.toBe(finalized.resultRevision);
    execFileSync('/usr/bin/git', [
      '-C',
      repository,
      'merge-base',
      '--is-ancestor',
      String(finalized.resultRevision),
      'HEAD',
    ]);

    const retried = await utility(repository, payload, workspace.path);
    expect(retried.acceptedRevision).toBe(finalized.resultRevision);
    expect(retried.targetHead).toBe(mergedRevision);
    expect(
      execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    ).toBe(mergedRevision);
  });

  it('prepares a conflicting merge for an agent and finalizes the staged resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-conflict-agent-'));
    roots.push(root);
    const repository = join(root, 'repository');
    const stateRoot = join(root, 'state');
    mkdirSync(repository);
    mkdirSync(stateRoot);
    execFileSync('/usr/bin/git', ['init', '-q', repository]);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Fixture']);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'fixture@invalid']);
    writeFileSync(join(repository, 'README.md'), '# Base\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'base']);
    const sourceBaseRevision = execFileSync(
      '/usr/bin/git',
      ['-C', repository, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' }
    ).trim();
    const source = await createWorkspaceSnapshot({
      repository,
      revision: sourceBaseRevision,
      stateRoot,
      runId: 'acacacacacacacacacacacacacacacac',
    });
    writeFileSync(join(source.path, 'README.md'), '# Agent result\n');
    const sourceResult = await utility(source.path, {
      mode: 'finalize',
      baseRevision: sourceBaseRevision,
      workdir: '.',
      editPaths: ['.'],
      checks: [],
    });

    writeFileSync(join(repository, 'README.md'), '# Target change\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'target advanced']);
    const targetRevision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const resolution = await createWorkspaceSnapshot({
      repository,
      revision: targetRevision,
      stateRoot,
      runId: 'bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc',
    });

    const prepared = await utility(
      resolution.path,
      {
        mode: 'prepare_merge',
        baseRevision: targetRevision,
        sourceBaseRevision,
        resultRevision: sourceResult.resultRevision,
        sourceWorkspace: '/result',
      },
      source.path
    );
    expect(prepared.conflicts).toEqual(['README.md']);
    expect(readFileSync(join(resolution.path, 'README.md'), 'utf8')).toContain('<<<<<<< HEAD');
    await expect(
      utility(resolution.path, {
        mode: 'finalize',
        baseRevision: targetRevision,
        workdir: '.',
        editPaths: ['.'],
        checks: [],
      })
    ).rejects.toThrow('nicht alle Merge-Konflikte aufgelöst');

    writeFileSync(join(resolution.path, 'README.md'), '# Target and agent result\n');
    execFileSync('/usr/bin/git', ['-C', resolution.path, 'add', 'README.md']);
    const finalized = await utility(resolution.path, {
      mode: 'finalize',
      baseRevision: targetRevision,
      workdir: '.',
      editPaths: ['.'],
      checks: [{ label: 'README exists', argv: ['/usr/bin/test', '-f', 'README.md'] }],
    });
    expect(finalized.files).toEqual(['README.md']);
    const parents = execFileSync(
      '/usr/bin/git',
      ['-C', resolution.path, 'show', '-s', '--format=%P', String(finalized.resultRevision)],
      { encoding: 'utf8' }
    )
      .trim()
      .split(' ');
    expect(parents).toEqual([targetRevision, sourceResult.resultRevision]);
  });

  it('refuses a conflicting target change and restores the clean target worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-second-project-'));
    roots.push(root);
    const repository = join(root, 'repository');
    const stateRoot = join(root, 'state');
    mkdirSync(repository);
    mkdirSync(stateRoot);
    execFileSync('/usr/bin/git', ['init', '-q', repository]);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Fixture']);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'fixture@invalid']);
    writeFileSync(join(repository, 'README.md'), '# Before\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'base']);
    const baseRevision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const workspace = await createWorkspaceSnapshot({
      repository,
      revision: baseRevision,
      stateRoot,
      runId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    writeFileSync(join(workspace.path, 'README.md'), '# After\n');
    const finalized = await utility(workspace.path, {
      mode: 'finalize',
      baseRevision,
      workdir: '.',
      editPaths: ['.'],
      checks: [{ label: 'README exists', argv: ['/usr/bin/test', '-f', 'README.md'] }],
    });
    // The target branch moved to a different descendant after task start.
    writeFileSync(join(repository, 'README.md'), '# Before other\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'other work']);
    const targetRevision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    await expect(
      utility(
        repository,
        {
          mode: 'accept',
          baseRevision,
          resultRevision: finalized.resultRevision,
          sourceWorkspace: '/result',
        },
        workspace.path
      )
    ).rejects.toThrow('Ergebnis kollidiert mit Änderungen im Zielbranch');
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('# Before other\n');
    expect(
      execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    ).toBe(targetRevision);
    expect(
      execFileSync('/usr/bin/git', ['-C', repository, 'status', '--porcelain=v1'], {
        encoding: 'utf8',
      })
    ).toBe('');
  });

  it('refuses a merge into a dirty target and leaves HEAD, index and markers untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-second-project-'));
    roots.push(root);
    const repository = join(root, 'repository');
    const stateRoot = join(root, 'state');
    mkdirSync(repository);
    mkdirSync(stateRoot);
    execFileSync('/usr/bin/git', ['init', '-q', repository]);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Fixture']);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'fixture@invalid']);
    writeFileSync(join(repository, 'README.md'), '# Before\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'base']);
    const baseRevision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const workspace = await createWorkspaceSnapshot({
      repository,
      revision: baseRevision,
      stateRoot,
      runId: '90909090909090909090909090909090',
    });
    writeFileSync(join(workspace.path, 'README.md'), '# After\n');
    const finalized = await utility(workspace.path, {
      mode: 'finalize',
      baseRevision,
      workdir: '.',
      editPaths: ['.'],
      checks: [],
    });
    // Foreign uncommitted files and edits in the target worktree.
    writeFileSync(join(repository, 'local-notes.md'), 'uncommitted operator work\n');
    writeFileSync(join(repository, 'README.md'), '# Before with uncommitted edit\n');
    const statusBefore = execFileSync(
      '/usr/bin/git',
      ['-C', repository, 'status', '--porcelain=v1'],
      { encoding: 'utf8' }
    );
    const indexBefore = execFileSync('/usr/bin/git', ['-C', repository, 'ls-files'], {
      encoding: 'utf8',
    });
    await expect(
      utility(
        repository,
        {
          mode: 'accept',
          baseRevision,
          resultRevision: finalized.resultRevision,
          sourceWorkspace: '/result',
        },
        workspace.path
      )
    ).rejects.toThrow('nicht übernommene Änderungen');
    expect(
      execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    ).toBe(baseRevision);
    expect(execFileSync('/usr/bin/git', ['-C', repository, 'ls-files'], { encoding: 'utf8' })).toBe(
      indexBefore
    );
    expect(
      execFileSync('/usr/bin/git', ['-C', repository, 'status', '--porcelain=v1'], {
        encoding: 'utf8',
      })
    ).toBe(statusBefore);
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe(
      '# Before with uncommitted edit\n'
    );
    expect(readFileSync(join(repository, 'local-notes.md'), 'utf8')).toBe(
      'uncommitted operator work\n'
    );
  });
});
