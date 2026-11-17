import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import {
  ArchitectureTargetSchema,
  ProjectArchitectureSchema,
  type AgentProject,
  type ArchitectureNode,
  type ArchitectureTarget,
  type ProjectArchitecture,
} from '@observatory/contracts';
import { AgentControlError } from '../agent/manager.js';

const execute = promisify(execFile);
const text = (de: string, en: string) => ({ de, en });
function node(
  id: string,
  parentId: string | undefined,
  de: string,
  en: string,
  descriptionDe: string,
  descriptionEn: string,
  sourcePaths: string[],
  screen?: ArchitectureNode['screen']
): ArchitectureNode {
  return {
    id,
    ...(parentId === undefined ? {} : { parentId }),
    label: text(de, en),
    description: text(descriptionDe, descriptionEn),
    sourcePaths,
    ...(screen === undefined ? {} : { screen }),
  };
}
const web = 'dashboard/packages/web/src/';
const server = 'dashboard/packages/server/src/';
const definitions: ArchitectureNode[] = [
  node(
    'root',
    undefined,
    'Observatory',
    'Observatory',
    'Dein lokaler Entwicklungsarbeitsplatz.',
    'Your local development workspace.',
    ['dashboard/package.json']
  ),
  node(
    'interface',
    'root',
    'Oberfläche',
    'Interface',
    'Screens, Navigation und Bedienung auf dem iPad.',
    'Screens, navigation and interaction on iPad.',
    [web + 'App.vue', web + 'styles.css']
  ),
  node(
    'agents',
    'root',
    'Agentensystem',
    'Agent system',
    'Aufträge ausführen, fortsetzen und gemeinsam bearbeiten.',
    'Run, resume and delegate coding tasks.',
    [server + 'runner/service.ts', server + 'durable/manager.ts']
  ),
  node(
    'models',
    'root',
    'Lokale KI',
    'Local AI',
    'Modellbetrieb, Diktieren und Verbindung zum Agenten.',
    'Model operation, dictation and the agent connection.',
    [server + 'durable/model.ts', server + 'engine/service.ts']
  ),
  node(
    'operations',
    'root',
    'Daten & Betrieb',
    'Data & operations',
    'Gespeicherte Arbeit, Anmeldung und Updates.',
    'Persisted work, sign-in and updates.',
    [server + 'runner/task-store.ts', server + 'auth/routes.ts']
  ),
  node(
    'projects',
    'interface',
    'Projektübersicht',
    'Project overview',
    'Projekte erkennen, auswählen und räumlich erkunden.',
    'Recognize, select and explore projects.',
    [web + 'components/agent/AgentProjectBrowser.vue'],
    'projects'
  ),
  node(
    'task',
    'interface',
    'Aufgabenansicht',
    'Task screen',
    'Die laufende Arbeit lesen und direkt beeinflussen.',
    'Read ongoing work and steer it directly.',
    [web + 'components/AgentCockpit.vue'],
    'task'
  ),
  node(
    'monitoring',
    'interface',
    'Betriebsübersicht',
    'Monitoring screen',
    'Modellstatus und Auslastung im Blick behalten.',
    'Keep model status and utilization in view.',
    [web + 'App.vue', web + 'components/EngineControls.vue'],
    'overview'
  ),
  node(
    'composer',
    'task',
    'Nachrichteneingabe',
    'Message composer',
    'Text, Sprache und Bilder an den Agenten senden.',
    'Send text, speech and images to the agent.',
    [web + 'components/agent/AgentTaskInput.vue', web + 'components/agent/AgentPendingMessages.vue']
  ),
  node(
    'review',
    'task',
    'Änderungsprüfung',
    'Code review',
    'Ergebnisse pro Datei prüfen und übernehmen.',
    'Review and accept results file by file.',
    [web + 'components/agent/AgentResultPanel.vue', web + 'components/agent/AgentDiffView.vue']
  ),
  node(
    'execution',
    'agents',
    'Auftragsausführung',
    'Task execution',
    'Gespräche und Werkzeuge über Neustarts hinweg fortsetzen.',
    'Resume conversations and tools across restarts.',
    [server + 'durable/manager.ts', server + 'durable/tools.ts']
  ),
  node(
    'subagents',
    'execution',
    'Subagenten',
    'Subagents',
    'Teilaufgaben delegieren und Berichte zusammenführen.',
    'Delegate subtasks and integrate their reports.',
    [server + 'durable/subagents.ts', web + 'lib/agent-conversations.ts']
  ),
  node(
    'isolation',
    'agents',
    'Arbeitsumgebung',
    'Work environment',
    'Code und Werkzeuge in der bestehenden Sandbox ausführen.',
    'Run code and tools in the existing sandbox.',
    [server + 'durable/environment.ts', 'dashboard/packages/runner/src/launcher.ts']
  ),
  node(
    'inference',
    'models',
    'Modellverbindung',
    'Model connection',
    'Den lokalen Modellserver verbinden und steuern.',
    'Connect and control the local model server.',
    [server + 'durable/model.ts', server + 'engine/service.ts']
  ),
  node(
    'speech',
    'models',
    'Spracheingabe',
    'Dictation',
    'Aufnahmen über die lokale CPU transkribieren.',
    'Transcribe recordings on the local CPU.',
    [server + 'speech/service.ts', web + 'components/agent/AgentDictation.vue']
  ),
  node(
    'storage',
    'operations',
    'Aufgabenspeicher',
    'Task storage',
    'Aufträge, Ergebnisse und Zustellung dauerhaft speichern.',
    'Persist tasks, results and message delivery.',
    [server + 'runner/task-store.ts']
  ),
  node(
    'releases',
    'operations',
    'Updates',
    'Updates',
    'Geprüfte Ergebnisse bauen und gezielt aktivieren.',
    'Build reviewed results and activate them deliberately.',
    ['dashboard/ops/build-release-artifact.ts', web + 'components/agent/AgentReleasePanel.vue']
  ),
];

/** Only names from one registered repository's committed tree; no file contents or host paths. */
export async function readProjectArchitecture(
  project: AgentProject,
  pinnedRevision?: string
): Promise<ProjectArchitecture> {
  const { stdout: revisionText } = await execute(
    '/usr/bin/git',
    [
      '-C',
      project.repositoryPath,
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${pinnedRevision ?? project.targetBranch}^{commit}`,
    ],
    { timeout: 10_000, maxBuffer: 1024 }
  );
  const revision = revisionText.trim();
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new AgentControlError('unavailable', 'Project revision is unavailable.');
  const { stdout } = await execute(
    '/usr/bin/git',
    ['-C', project.repositoryPath, 'ls-tree', '-r', '-z', '--name-only', revision],
    { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }
  );
  return architectureFromFiles(
    project.id,
    project.name,
    revision,
    stdout.split('\0').filter(Boolean)
  );
}

export function architectureFromFiles(
  projectId: string,
  name: string,
  revision: string,
  files: string[]
): ProjectArchitecture {
  const existing = new Set(files);
  const curated =
    existing.has(web + 'components/AgentCockpit.vue') &&
    existing.has(server + 'durable/manager.ts');
  const nodes = curated
    ? definitions.map((entry) => ({
        ...entry,
        sourcePaths: entry.sourcePaths.filter((path) => existing.has(path)),
      }))
    : directoryNodes(name, files);
  return ProjectArchitectureSchema.parse({
    projectId,
    mapId: curated ? 'observatory-v1' : 'directories-v1',
    revision,
    generatedAt: new Date().toISOString(),
    kind: curated ? 'curated' : 'directories',
    nodes,
  });
}

function directoryNodes(name: string, files: string[]): ArchitectureNode[] {
  const safe = files.filter(
    (path) =>
      path === path.trim() &&
      !path.startsWith('.') &&
      path.length <= 512 &&
      ![...path].some((character) => character.charCodeAt(0) < 32)
  );
  const root = node(
    'root',
    undefined,
    name,
    name,
    'Dateibereiche dieses Projekts. Eine fachliche Zuordnung ist noch offen.',
    'File areas of this project. Functional mapping has not been authored yet.',
    safe.filter((path) => !path.includes('/')).slice(0, 24)
  );
  const directories = [
    ...new Set(safe.filter((path) => path.includes('/')).map((path) => path.split('/')[0]!)),
  ]
    .sort()
    .slice(0, 24);
  return [
    root,
    ...directories.map((directory) =>
      node(
        `directory-${createHash('sha256').update(directory).digest('hex').slice(0, 16)}`,
        'root',
        directory,
        directory,
        'Aus dem Git-Verzeichnis abgeleitet.',
        'Derived from the Git directory.',
        safe.filter((path) => path.startsWith(`${directory}/`)).slice(0, 24)
      )
    ),
  ];
}

/** Resolve client context against the canonical map; it grants no additional tool permissions. */
export function validateArchitectureTarget(
  map: ProjectArchitecture,
  raw: ArchitectureTarget
): ArchitectureTarget {
  const target = ArchitectureTargetSchema.parse(raw);
  const selected = map.nodes.find((entry) => entry.id === target.nodeId);
  if (target.mapId !== map.mapId || target.revision !== map.revision || selected === undefined) {
    throw new AgentControlError(
      'conflict',
      'The project map changed. Refresh it before starting the task.'
    );
  }
  if (JSON.stringify(target.sourcePaths) !== JSON.stringify(selected.sourcePaths)) {
    throw new AgentControlError(
      'conflict',
      'The selected source references no longer match the project map.'
    );
  }
  if (target.point !== undefined && selected.screen === undefined) {
    throw new AgentControlError('protocol', 'This area has no screen to annotate.');
  }
  const trail: ArchitectureNode[] = [selected];
  while (trail[0]?.parentId !== undefined) {
    const parent = map.nodes.find((entry) => entry.id === trail[0]!.parentId);
    if (parent === undefined || trail.some((entry) => entry.id === parent.id)) break;
    trail.unshift(parent);
  }
  // Labels may be displayed in either supported language. Keep only canonical labels.
  const language = target.label === selected.label.de ? 'de' : 'en';
  return {
    ...target,
    label: selected.label[language],
    breadcrumbs: trail.map((entry) => entry.label[language]),
  };
}

export function architectureContext(target: ArchitectureTarget): string {
  const expanded = `[Architecture selection — context, not additional permissions]\nArea: ${target.breadcrumbs.join(' → ')}\nMap: ${target.mapId} / ${target.nodeId}\nSelected Git revision: ${target.revision}\nSource references (relative to the repository root):\n${target.sourcePaths.map((path) => `- ${path}`).join('\n') || '(project level)'}${target.point === undefined ? '' : `\nScreen marker: x=${Math.round(target.point.x * 100)}%, y=${Math.round(target.point.y * 100)}% (top left origin; reference screenshot may be older than the selected revision).`}\nInspect the current files before editing. These references do not restrict necessary related changes and do not expand the existing sandbox or edit-path permissions.`;
  if (expanded.length > 65_536)
    throw new AgentControlError('protocol', 'Task and map context exceed the input limit.');
  return expanded;
}
