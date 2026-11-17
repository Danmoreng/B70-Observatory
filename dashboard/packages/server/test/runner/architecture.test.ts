import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentProjectSchema } from '@observatory/contracts';
import {
  architectureFromFiles,
  architectureContext,
  readProjectArchitecture,
  validateArchitectureTarget,
} from '../../src/runner/architecture.js';
const id = '10000000-0000-4000-8000-000000000001';
const revision = 'a'.repeat(40);
const files = [
  'dashboard/packages/web/src/components/AgentCockpit.vue',
  'dashboard/packages/server/src/durable/manager.ts',
  'dashboard/packages/web/src/components/agent/AgentProjectBrowser.vue',
];
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('project architecture', () => {
  it('offers functional areas and includes only references actually present in the Git tree', () => {
    const map = architectureFromFiles(id, 'Observatory', revision, files);
    expect(map.kind).toBe('curated');
    expect(map.nodes.filter((entry) => entry.parentId === 'root').map((entry) => entry.id)).toEqual(
      ['interface', 'agents', 'models', 'operations']
    );
    expect(
      map.nodes.flatMap((entry) => entry.sourcePaths).every((path) => files.includes(path))
    ).toBe(true);
    const selected = map.nodes.find((entry) => entry.id === 'projects')!;
    const target = validateArchitectureTarget(map, {
      mapId: map.mapId,
      nodeId: selected.id,
      revision,
      label: 'untrusted label',
      breadcrumbs: ['untrusted breadcrumb'],
      sourcePaths: selected.sourcePaths,
      point: { x: 0.25, y: 0.5 },
    });
    expect(target.label).toBe('Project overview');
    expect(target.breadcrumbs).toEqual(['Observatory', 'Interface', 'Project overview']);
    expect(architectureContext(target)).toContain('x=25%, y=50%');
    expect(() => validateArchitectureTarget(map, { ...target, revision: 'b'.repeat(40) })).toThrow(
      'map changed'
    );
    expect(() =>
      validateArchitectureTarget(map, { ...target, sourcePaths: ['../../private'] })
    ).toThrow();
    expect(() =>
      validateArchitectureTarget(map, { ...target, sourcePaths: ['secrets.txt'] })
    ).toThrow('source references');
    expect(() =>
      validateArchitectureTarget(map, { ...target, nodeId: 'root', sourcePaths: [] })
    ).toThrow('no screen');
  });
  it('labels a generic directory view honestly', () => {
    const map = architectureFromFiles(id, 'Example', revision, [
      'README.md',
      'src/index.ts',
      'test/app.ts',
      '.env',
    ]);
    expect(map.kind).toBe('directories');
    expect(map.nodes[0]?.sourcePaths).toEqual(['README.md']);
    expect(map.nodes.map((entry) => entry.label.en)).toEqual(['Example', 'src', 'test']);
  });
  it('reads the selected commit, ignoring modified and untracked host files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-map-source-'));
    roots.push(root);
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Map QA');
    git('config', 'user.email', 'qa@local.invalid');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/app.ts'), 'initial');
    git('add', '.');
    git('commit', '-qm', 'source');
    writeFileSync(join(root, 'src/untracked.ts'), 'not committed');
    const project = AgentProjectSchema.parse({
      id,
      name: 'Example',
      repositoryPath: root,
      targetBranch: 'main',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const map = await readProjectArchitecture(project);
    expect(map.revision).toBe(git('rev-parse', 'HEAD'));
    expect(map.nodes.flatMap((entry) => entry.sourcePaths)).toEqual(['src/app.ts']);
  });
});
