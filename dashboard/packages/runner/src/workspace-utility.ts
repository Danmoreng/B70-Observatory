import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createChangeImagePreview } from './change-image.js';
import { captureWorkspaceChanges } from './live-changes.js';

interface CheckCommand {
  label: string;
  argv: string[];
}
interface UtilityConfig {
  mode: 'finalize' | 'accept' | 'prepare_merge' | 'changes' | 'change_image';
  baseRevision: string;
  imagePath?: string;
  imageRevision?: string;
  sourceBaseRevision?: string;
  workdir?: string;
  editPaths?: string[];
  checks?: CheckCommand[];
  resultRevision?: string;
  sourceWorkspace?: string;
}

const MAX_OUTPUT = 512 * 1024;
const MAX_CHECK_OUTPUT = 64 * 1024;
const safeRevision = /^[a-f0-9]{40}$/;
const safeRelative = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/;

function fail(message: string, code: 'conflict' | 'merge_conflict' = 'conflict'): never {
  process.stdout.write(JSON.stringify({ ok: false, code, error: message.slice(0, 512) }));
  process.exit(1);
}

function git(args: string[], cwd = '/workspace', timeout = 120_000) {
  return spawnSync(
    '/usr/bin/git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.pager=cat',
      ...args,
    ],
    { cwd, encoding: 'utf8', timeout, maxBuffer: MAX_OUTPUT }
  );
}

function cleanText(value: string | Buffer | null | undefined): string {
  return String(value ?? '').slice(0, MAX_OUTPUT);
}

function decode(): UtilityConfig {
  const encoded = process.argv[2];
  if (encoded === undefined || encoded.length > 16_384) fail('Ungültige Utility-Konfiguration.');
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as UtilityConfig;
    if (!safeRevision.test(value.baseRevision)) fail('Ungültige Basisrevision.');
    return value;
  } catch {
    fail('Ungültige Utility-Konfiguration.');
  }
}

function changedPaths(baseRevision: string): string[] {
  const tracked = git([
    'diff',
    '--name-only',
    '--no-ext-diff',
    '--no-textconv',
    `${baseRevision}..HEAD`,
  ]);
  if (tracked.status !== 0) fail('Geänderte Dateien konnten nicht ermittelt werden.');
  return cleanText(tracked.stdout)
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
}

function pathAllowed(path: string, roots: string[]): boolean {
  return roots.some((root) => root === '.' || path === root || path.startsWith(`${root}/`));
}

function normalizeRegistryLocks(): void {
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const path = `/workspace/${file}`;
    try {
      const original = readFileSync(path, 'utf8');
      if (!original.includes('http://127.0.0.1:4873/')) continue;
      const value: unknown = JSON.parse(original);
      const visit = (item: unknown): void => {
        if (item === null || typeof item !== 'object') return;
        for (const [key, child] of Object.entries(item)) {
          if (
            key === 'resolved' &&
            typeof child === 'string' &&
            child.startsWith('http://127.0.0.1:4873/')
          )
            (item as Record<string, unknown>)[key] = child.replace(
              'http://127.0.0.1:4873/',
              'https://registry.npmjs.org/'
            );
          else visit(child);
        }
      };
      visit(value);
      writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
    } catch {
      /* No lockfile or an invalid one; the configured package checks report failures. */
    }
  }
}

function finalize(config: UtilityConfig): void {
  normalizeRegistryLocks();
  const questionPath = '/workspace/.b70-question.json';
  let question: string | undefined;
  try {
    const value = JSON.parse(readFileSync(questionPath, 'utf8')) as { question?: unknown };
    if (typeof value.question === 'string' && value.question.trim())
      question = value.question.trim().slice(0, 16_384);
  } catch {
    // The normal completion path has no question marker.
  }
  rmSync(questionPath, { force: true });

  const unmerged = git(['diff', '--name-only', '--diff-filter=U']);
  if (unmerged.status !== 0) fail('Merge-Konfliktstatus konnte nicht gelesen werden.');
  if (cleanText(unmerged.stdout).trim()) {
    fail('Der Agent hat nicht alle Merge-Konflikte aufgelöst und mit git add markiert.');
  }
  const status = git(['status', '--porcelain=v1', '-z']);
  if (status.status !== 0) fail('Git-Status konnte nicht gelesen werden.');
  if (cleanText(status.stdout).length > 0) {
    const add = git(['add', '-A']);
    if (add.status !== 0)
      fail(`Arbeitsstand konnte nicht gesichert werden: ${cleanText(add.stderr)}`);
    const commit = git([
      '-c',
      'user.name=Local AI B70',
      '-c',
      'user.email=agent@local.invalid',
      'commit',
      '-m',
      'checkpoint: local agent result',
    ]);
    if (commit.status !== 0)
      fail(`Checkpoint konnte nicht erstellt werden: ${cleanText(commit.stderr)}`);
  }
  const revisionResult = git(['rev-parse', 'HEAD']);
  const resultRevision = cleanText(revisionResult.stdout).trim();
  if (revisionResult.status !== 0 || !safeRevision.test(resultRevision))
    fail('Ergebnisrevision konnte nicht bestimmt werden.');

  const files = changedPaths(config.baseRevision);
  const editPaths = config.editPaths?.length ? config.editPaths : ['.'];
  if (editPaths.some((path) => !safeRelative.test(path))) fail('Ungültiger Bearbeitungsbereich.');
  const forbidden = files.filter((path) => !pathAllowed(path, editPaths));
  if (forbidden.length > 0)
    fail(`Bearbeitungsbereich überschritten: ${forbidden.slice(0, 10).join(', ')}`);

  const diff = git([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--stat',
    '--patch',
    `${config.baseRevision}..${resultRevision}`,
  ]);
  // Git has already checkpointed every file. A display-size limit must not
  // discard that checkpoint or make continuations fall back to an older run.
  const outputLimited =
    (diff.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS' &&
    Buffer.byteLength(String(diff.stdout ?? '')) >= MAX_OUTPUT;
  if (diff.status !== 0 && !outputLimited) fail('Diff konnte nicht erzeugt werden.');
  const diffTruncated = outputLimited || String(diff.stdout ?? '').length > MAX_OUTPUT;
  const cwd = resolve('/workspace', config.workdir ?? '.');
  if (cwd !== '/workspace' && !cwd.startsWith('/workspace/'))
    fail('Ungültiges Arbeitsverzeichnis.');
  const checks = (config.checks ?? []).slice(0, 12).map((check) => {
    const started = Date.now();
    if (!check.label || !Array.isArray(check.argv) || check.argv.length === 0) {
      return {
        label: check.label || 'Check',
        argv: check.argv ?? [],
        status: 'failed',
        exitCode: null,
        durationMs: 0,
        output: 'Ungültiger Check.',
      };
    }
    const result = spawnSync(check.argv[0]!, check.argv.slice(1), {
      cwd,
      encoding: 'utf8',
      timeout: 10 * 60_000,
      maxBuffer: MAX_CHECK_OUTPUT * 2,
      env: { HOME: '/tmp', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', CI: '1' },
    });
    return {
      label: check.label.slice(0, 160),
      argv: check.argv,
      status: result.status === 0 ? 'passed' : 'failed',
      exitCode: result.status,
      durationMs: Date.now() - started,
      output: `${cleanText(result.stdout)}${cleanText(result.stderr)}`.slice(0, MAX_CHECK_OUTPUT),
    };
  });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      resultRevision,
      files,
      diff: cleanText(diff.stdout),
      diffTruncated,
      checks,
      checkStatus:
        checks.length === 0
          ? 'not_run'
          : checks.every((check) => check.status === 'passed')
            ? 'passed'
            : 'failed',
      ...(question === undefined ? {} : { question }),
    })
  );
}

function prepareMerge(config: UtilityConfig): void {
  if (
    !safeRevision.test(config.resultRevision ?? '') ||
    !safeRevision.test(config.sourceBaseRevision ?? '') ||
    !config.sourceWorkspace
  ) {
    fail('Ergebnisrevision, Quellbasis oder Quellworkspace fehlt.');
  }
  const current = cleanText(git(['rev-parse', 'HEAD']).stdout).trim();
  if (current !== config.baseRevision)
    fail('Konflikt-Workspace hat nicht die erwartete Zielbasis.');
  if (cleanText(git(['status', '--porcelain=v1']).stdout).trim())
    fail('Konflikt-Workspace ist vor der Vorbereitung nicht sauber.');
  const fetch = git(['fetch', '--no-tags', config.sourceWorkspace, config.resultRevision!]);
  if (fetch.status !== 0)
    fail(`Ergebnis konnte nicht importiert werden: ${cleanText(fetch.stderr)}`);
  if (git(['merge-base', '--is-ancestor', config.sourceBaseRevision!, 'FETCH_HEAD']).status !== 0) {
    fail('Das Ergebnis basiert nicht auf der gespeicherten Aufgabenbasis.');
  }
  if (git(['merge-base', '--is-ancestor', config.sourceBaseRevision!, 'HEAD']).status !== 0) {
    fail('Der Zielbranch enthält die gespeicherte Aufgabenbasis nicht mehr.');
  }
  const merge = git(['merge', '--no-ff', '--no-commit', '--no-stat', 'FETCH_HEAD']);
  const mergeHead = git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']);
  if (merge.status !== 0 && mergeHead.status !== 0) {
    fail(`Konfliktauflösung konnte nicht vorbereitet werden: ${cleanText(merge.stderr)}`);
  }
  const conflicts = git(['diff', '--name-only', '--diff-filter=U']);
  if (conflicts.status !== 0) fail('Konfliktdateien konnten nicht ermittelt werden.');
  process.stdout.write(
    JSON.stringify({
      ok: true,
      conflicts: cleanText(conflicts.stdout)
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
    })
  );
}

function accept(config: UtilityConfig): void {
  if (!safeRevision.test(config.resultRevision ?? '') || !config.sourceWorkspace)
    fail('Ergebnisrevision oder Quellworkspace fehlt.');
  const current = cleanText(git(['rev-parse', 'HEAD']).stdout).trim();
  if (!safeRevision.test(current)) fail('Zielrevision konnte nicht bestimmt werden.');
  if (cleanText(git(['status', '--porcelain=v1']).stdout).trim())
    fail('Die Zielarbeitskopie enthält nicht übernommene Änderungen.');
  const filters = git([
    'config',
    '--local',
    '--get-regexp',
    '^filter[.].*[.](clean|smudge|process)$',
  ]);
  if (filters.status === 0 && cleanText(filters.stdout).trim()) {
    fail(
      'Die Zielarbeitskopie verwendet ausführbare Git-Filter; automatische Übernahme ist gesperrt.'
    );
  }
  const fetch = git(['fetch', '--no-tags', config.sourceWorkspace, config.resultRevision!]);
  if (fetch.status !== 0)
    fail(`Ergebnis konnte nicht importiert werden: ${cleanText(fetch.stderr)}`);
  const ancestry = git(['merge-base', '--is-ancestor', config.baseRevision, 'FETCH_HEAD']);
  if (ancestry.status !== 0) fail('Das Ergebnis basiert nicht auf der gespeicherten Zielbasis.');

  // Retried merges and manual merges are successful once the exact result
  // is already contained in the checked-out target branch.
  if (git(['merge-base', '--is-ancestor', config.resultRevision!, 'HEAD']).status === 0) {
    process.stdout.write(
      JSON.stringify({ ok: true, acceptedRevision: config.resultRevision, targetHead: current })
    );
    return;
  }

  // The unchanged target and a target already on an intermediate result
  // commit can still move forward without creating a merge commit.
  if (git(['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']).status === 0) {
    const fastForward = git(['merge', '--ff-only', '--no-stat', 'FETCH_HEAD']);
    if (fastForward.status !== 0)
      fail(`Ergebnis konnte nicht übernommen werden: ${cleanText(fastForward.stderr)}`);
    process.stdout.write(
      JSON.stringify({
        ok: true,
        acceptedRevision: config.resultRevision,
        targetHead: config.resultRevision,
      })
    );
    return;
  }

  // A target may legitimately advance while an isolated task is running.
  // Merge that descendant with the result, but never cross a rewritten or
  // unrelated target history and never leave a conflicted worktree behind.
  if (git(['merge-base', '--is-ancestor', config.baseRevision, 'HEAD']).status !== 0)
    fail('Der Zielbranch enthält die gespeicherte Aufgabenbasis nicht mehr.');
  const merge = git([
    '-c',
    'user.name=Local AI B70',
    '-c',
    'user.email=agent@local.invalid',
    'merge',
    '--no-ff',
    '--no-stat',
    '-m',
    `Merge local agent result ${config.resultRevision!.slice(0, 12)}`,
    'FETCH_HEAD',
  ]);
  if (merge.status !== 0) {
    if (git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']).status === 0) {
      git(['merge', '--abort']);
    }
    const restored = cleanText(git(['rev-parse', 'HEAD']).stdout).trim() === current;
    const clean = !cleanText(git(['status', '--porcelain=v1']).stdout).trim();
    if (!restored || !clean)
      fail('Fehlgeschlagene Ergebnisübernahme konnte nicht vollständig zurückgerollt werden.');
    fail(
      `Ergebnis kollidiert mit Änderungen im Zielbranch: ${cleanText(merge.stderr)}`,
      'merge_conflict'
    );
  }
  const mergedHead = git(['rev-parse', 'HEAD']);
  const head = cleanText(mergedHead.stdout).trim();
  if (mergedHead.status !== 0 || !safeRevision.test(head))
    fail('Die übernommene Zielrevision konnte nicht bestimmt werden.');
  process.stdout.write(
    JSON.stringify({ ok: true, acceptedRevision: config.resultRevision, targetHead: head })
  );
}

const config = decode();
if (config.mode === 'finalize') finalize(config);
else if (config.mode === 'accept') accept(config);
else if (config.mode === 'prepare_merge') prepareMerge(config);
else if (config.mode === 'changes') {
  try {
    process.stdout.write(
      JSON.stringify({ ok: true, ...captureWorkspaceChanges('/workspace', config.baseRevision) })
    );
  } catch {
    fail('Live workspace changes are temporarily unavailable.');
  }
} else if (config.mode === 'change_image') {
  try {
    const data = createChangeImagePreview(
      '/workspace',
      config.imagePath ?? '',
      config.imageRevision
    );
    process.stdout.write(JSON.stringify({ ok: true, dataBase64: data.toString('base64') }));
  } catch {
    fail('Image preview is unavailable.');
  }
} else fail('Unbekannter Utility-Modus.');
