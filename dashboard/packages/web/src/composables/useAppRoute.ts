import { reactive, type Reactive } from 'vue';

export type AppPage =
  'overview' | 'agent' | 'projects' | 'hardware' | 'memory' | 'studio' | 'gallery' | 'settings';

export interface AppRouteState {
  page: AppPage;
  taskId: string | undefined;
  projectId: string | undefined;
  nodeId?: string | undefined;
  view?: 'changes' | undefined;
}

/**
 * Shared hash-route state. The shell (App.vue) and the agent cockpit read
 * and write it so the URL always encodes the current view, e.g.
 * `#/agent/<taskId>` or `#/projects/<projectId>`, and a refresh or browser
 * back/forward restores it.
 */
export const appRoute: Reactive<AppRouteState> = reactive({
  page: 'overview',
  taskId: undefined,
  projectId: undefined,
});

/**
 * Matches `#/overview`, `#/agent[/taskId]` and `#/projects[/projectId]`,
 * tolerating a trailing slash and deeper, hand-edited paths (`#/agent/`,
 * `#/agent/a/b`): the first segment is used as the id, anything after it is
 * ignored instead of falling back to the wrong page.
 */
const routePattern =
  /^#\/(overview|agent|projects|hardware|memory|studio|gallery|settings)(?:\/([^/?#]+))?\/?(.+)?$/;

function parseSegment(segment: string | undefined): string | undefined {
  if (segment === undefined || segment === '') return undefined;
  const [first] = segment.split(/[/?#]/);
  if (first === undefined || first === '') return undefined;
  return decodeSegment(first);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A hand-edited hash may contain an invalid percent sequence; keep the
    // raw segment so the id simply does not match any known task.
    return segment;
  }
}

export function parseAppRoute(hash: string): AppRouteState {
  const match = routePattern.exec(hash);
  if (match?.[1] === 'settings')
    return { page: 'settings', taskId: undefined, projectId: undefined };
  if (match?.[1] === 'studio' || match?.[1] === 'gallery')
    return { page: match[1], taskId: undefined, projectId: undefined };
  if (match?.[1] === 'memory') return { page: 'memory', taskId: undefined, projectId: undefined };
  if (match?.[1] === 'hardware')
    return { page: 'hardware', taskId: undefined, projectId: undefined };
  if (match?.[1] === 'agent') {
    return {
      page: 'agent',
      taskId: parseSegment(match[2]),
      projectId: undefined,
      ...(new URLSearchParams(hash.split('?')[1]).get('view') === 'changes'
        ? { view: 'changes' as const }
        : {}),
    };
  }
  if (match?.[1] === 'projects') {
    return {
      page: 'projects',
      taskId: undefined,
      projectId: parseSegment(match[2]),
      ...(match[3]?.replace(/^\//, '').startsWith('map/')
        ? { nodeId: parseSegment(match[3].replace(/^\//, '').slice(4)) }
        : {}),
    };
  }
  return { page: 'overview', taskId: undefined, projectId: undefined };
}

export function syncAppRoute(): void {
  const location = globalThis.location;
  if (location === undefined || location === null) return;
  const next = parseAppRoute(location.hash ?? '');
  appRoute.page = next.page;
  appRoute.taskId = next.taskId;
  appRoute.projectId = next.projectId;
  appRoute.nodeId = next.nodeId;
  appRoute.view = next.view;
}

export function navigateTo(
  page: AppPage,
  taskId?: string,
  projectId?: string,
  nodeId?: string
): void {
  const location = globalThis.location;
  if (location === undefined || location === null) return;
  let hash = `#/${page}`;
  if (page === 'agent' && taskId !== undefined) hash = `#/agent/${encodeURIComponent(taskId)}`;
  if (page === 'projects' && projectId !== undefined) {
    hash = `#/projects/${encodeURIComponent(projectId)}${nodeId === undefined ? '' : `/map/${encodeURIComponent(nodeId)}`}`;
  }
  if (location.hash === hash) return;
  location.hash = hash;
  // Update immediately so the same tick sees the new route even if the
  // environment does not dispatch a hashchange event.
  syncAppRoute();
}

// Reflect the current URL before the first render; onMounted alone is too
// late because child components read the route during setup.
if (typeof globalThis.location !== 'undefined' && globalThis.location !== null) syncAppRoute();

// Register the hashchange listener exactly once at module level. Components
// must not register their own listeners: addEventListener dedupes identical
// callbacks, so if App.vue and a child component both registered syncAppRoute
// and the child unmounted, its removeEventListener would delete the shared
// entry and the app-wide navigation would die until the page reloaded.
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('hashchange', syncAppRoute);
}

export function useAppRoute(): {
  appRoute: Reactive<AppRouteState>;
  navigateTo: typeof navigateTo;
} {
  return { appRoute, navigateTo };
}
