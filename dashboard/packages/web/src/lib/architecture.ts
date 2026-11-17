import type {
  ArchitectureNode,
  ArchitectureTarget,
  DurableTaskSummary,
  ProjectArchitecture,
} from '@observatory/contracts';
import type { Locale } from './i18n.js';

export function architectureTrail(
  map: ProjectArchitecture,
  node: ArchitectureNode
): ArchitectureNode[] {
  const trail = [node];
  while (trail[0]?.parentId !== undefined) {
    const parent = map.nodes.find((entry) => entry.id === trail[0]!.parentId);
    if (!parent || trail.some((entry) => entry.id === parent.id)) break;
    trail.unshift(parent);
  }
  return trail;
}
export function targetForNode(
  map: ProjectArchitecture,
  node: ArchitectureNode,
  language: Locale,
  point?: ArchitectureTarget['point']
): ArchitectureTarget {
  return {
    mapId: map.mapId,
    nodeId: node.id,
    revision: map.revision,
    label: node.label[language],
    breadcrumbs: architectureTrail(map, node).map((entry) => entry.label[language]),
    sourcePaths: node.sourcePaths,
    ...(point === undefined ? {} : { point }),
  };
}
export function tasksAtNode(
  map: ProjectArchitecture,
  selected: ArchitectureNode,
  tasks: DurableTaskSummary[]
): DurableTaskSummary[] {
  const descendants = new Set([selected.id]);
  for (let i = 0; i < map.nodes.length; i++) {
    for (const entry of map.nodes)
      if (entry.parentId && descendants.has(entry.parentId)) descendants.add(entry.id);
  }
  return tasks.filter(
    (task) =>
      task.projectId === map.projectId &&
      task.architectureTarget?.mapId === map.mapId &&
      descendants.has(task.architectureTarget.nodeId)
  );
}
export function mapTaskHref(taskId: string, view?: 'changes'): string {
  return `#/agent/${encodeURIComponent(taskId)}${view === undefined ? '' : '?view=changes'}`;
}
