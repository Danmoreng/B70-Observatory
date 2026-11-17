import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentProjectSchema,
  AgentRunSnapshotSchema,
  DurableTaskListSchema,
  ProjectArchitectureSchema,
} from '@observatory/contracts';
import type { AgentCockpitState } from '../src/composables/useAgentCockpit.js';
import AgentArchitectureMap from '../src/components/agent/AgentArchitectureMap.vue';
import { appRoute, navigateTo, parseAppRoute } from '../src/composables/useAppRoute.js';
import { architectureTrail, targetForNode, tasksAtNode } from '../src/lib/architecture.js';
import { fetchProjectArchitecture } from '../src/lib/api.js';
import { setLocale } from '../src/lib/i18n.js';
vi.mock('../src/lib/api.js', () => ({
  fetchProjectArchitecture: vi.fn(),
  fetchSpeechStatus: vi.fn(async () => ({ enabled: false })),
}));
enableAutoUnmount(afterEach);
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const revision = 'a'.repeat(40);
const timestamp = '2026-10-23T18:00:00.000Z';
const project = AgentProjectSchema.parse({
  id: projectId,
  name: 'Observatory',
  repositoryPath: '/tmp/project',
  targetBranch: 'main',
  createdAt: timestamp,
  updatedAt: timestamp,
});
const words = (value: string) => ({ en: value, de: value });
const map = ProjectArchitectureSchema.parse({
  projectId,
  mapId: 'observatory-v1',
  revision,
  generatedAt: timestamp,
  kind: 'curated',
  nodes: [
    { id: 'root', label: words('Observatory'), description: words('Project'), sourcePaths: [] },
    {
      id: 'interface',
      parentId: 'root',
      label: words('Interface'),
      description: words('Screens'),
      sourcePaths: ['src/app.vue'],
    },
    {
      id: 'projects',
      parentId: 'interface',
      label: words('Project overview'),
      description: words('Select projects'),
      sourcePaths: ['src/projects.vue'],
      screen: 'projects',
    },
    {
      id: 'agents',
      parentId: 'root',
      label: words('Agents'),
      description: words('Run work'),
      sourcePaths: ['src/agent.ts'],
    },
  ],
});
function cockpit() {
  const tasks = ref(DurableTaskListSchema.parse({ items: [], activeTaskIds: [] }));
  const start = vi.fn(async () => false);
  return {
    snapshot: ref(
      AgentRunSnapshotSchema.parse({
        service: 'local-ai-b70-observatory',
        enabled: true,
        status: 'idle',
        sequence: 0,
        pendingSteering: 0,
        timeline: [],
      })
    ),
    tasks,
    start,
    error: ref('Try again'),
    selectedTaskId: ref<string>(),
    refreshTasks: vi.fn(),
  } as unknown as AgentCockpitState;
}
function setup(nodeId = 'root') {
  vi.mocked(fetchProjectArchitecture).mockResolvedValue(map);
  navigateTo('projects', undefined, projectId, nodeId);
  const state = cockpit();
  const wrapper = mount(AgentArchitectureMap, {
    props: { project, tasks: [], cockpit: state },
    global: { stubs: { AgentDictation: true, AgentAppPanel: true } },
  });
  return { wrapper, state };
}
afterEach(() => {
  setLocale('en');
  localStorage.clear();
  navigateTo('overview');
  vi.clearAllMocks();
});

describe('architecture map workflow', () => {
  it('focuses the selected area and restores its context without losing navigation', async () => {
    const { wrapper } = setup('interface');
    await flushPromises();
    expect(wrapper.get('.map-focus h3').text()).toBe('Interface');
    expect(wrapper.get('.map-legend').text()).toContain('Child areas');
    expect(wrapper.find('.map-inspector').exists()).toBe(true);
    expect(wrapper.find('.map-task-form').exists()).toBe(false);
    await wrapper.get('.map-legend button').trigger('click');
    expect(wrapper.find('.map-inspector').exists()).toBe(false);
    expect(wrapper.get('.map-layout').classes()).toContain('map-focused');
    await wrapper.get('[data-node="projects"]').trigger('click');
    expect(wrapper.get('.map-focus h3').text()).toBe('Project overview');
    await wrapper.get('.map-legend button').trigger('click');
    expect(wrapper.find('.map-inspector').exists()).toBe(true);
  });
  it('does not pull the user back into a task after they navigated to another area', async () => {
    const { wrapper, state } = setup('projects');
    await flushPromises();
    let finish!: (ok: boolean) => void;
    vi.mocked(state.start).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    await wrapper.get('.map-inspector-heading button').trigger('click');
    await wrapper.get('#map-task-message').setValue('Improve this screen');
    await wrapper.get('.map-task-form').trigger('submit');
    navigateTo('projects', undefined, projectId, 'agents');
    await flushPromises();
    state.selectedTaskId.value = taskId;
    finish(true);
    await flushPromises();
    expect(appRoute.page).toBe('projects');
    expect(appRoute.nodeId).toBe('agents');
    expect(wrapper.find('.app-dialog').exists()).toBe(false);
    expect(
      localStorage.getItem(`observatory.agent.draft.map:${projectId}:projects.continue`)
    ).toBeNull();
  });

  it('drills through functional levels, preserves location in the URL and switches layout without losing context', async () => {
    const { wrapper } = setup();
    await flushPromises();
    expect(wrapper.findAll('.map-node')).toHaveLength(2);
    await wrapper.get('[data-node="interface"]').trigger('click');
    expect(appRoute.nodeId).toBe('interface');
    expect(parseAppRoute(location.hash).nodeId).toBe('interface');
    expect(wrapper.findAll('.map-node')).toHaveLength(1);
    const controls = wrapper.findAll('.map-layout-switch button');
    await controls[1]!.trigger('click');
    expect(wrapper.get('.map-canvas').classes()).toContain('layout-nested');
    expect(appRoute.nodeId).toBe('interface');
    await wrapper.get('[data-node="projects"]').trigger('click');
    expect(wrapper.get('.map-leaf-files').text()).toContain('src/projects.vue');
    expect(wrapper.find('.map-screen').exists()).toBe(true);
  });
  it('retains a failed task draft and idempotency key, then navigates only after a successful start', async () => {
    const { wrapper, state } = setup('projects');
    await flushPromises();
    await wrapper.get('.map-inspector-heading button').trigger('click');
    await wrapper.get('#map-task-message').setValue('Make project cards easier to tap');
    await wrapper.get('.map-task-form').trigger('submit');
    await flushPromises();
    const first = vi.mocked(state.start).mock.calls[0]![0];
    expect(first.architectureTarget).toMatchObject({
      nodeId: 'projects',
      revision,
      sourcePaths: ['src/projects.vue'],
      breadcrumbs: ['Observatory', 'Interface', 'Project overview'],
    });
    expect(first.projectId).toBe(projectId);
    expect(wrapper.get('#map-task-message').element).toHaveProperty(
      'value',
      'Make project cards easier to tap'
    );
    expect(wrapper.get('[role="alert"]').text()).toContain('Try again');
    vi.mocked(state.start).mockImplementation(async () => {
      state.selectedTaskId.value = taskId;
      return true;
    });
    await wrapper.get('.map-task-form').trigger('submit');
    await flushPromises();
    expect(vi.mocked(state.start).mock.calls[1]![0].idempotencyKey).toBe(first.idempotencyKey);
    expect(appRoute.taskId).toBe(taskId);
    expect(
      localStorage.getItem(`observatory.agent.draft.map:${projectId}:projects.continue`)
    ).toBeNull();
  });
  it('keeps drafts separate for different architecture nodes', async () => {
    const { wrapper } = setup('projects');
    await flushPromises();
    await wrapper.get('.map-inspector-heading button').trigger('click');
    await wrapper.get('#map-task-message').setValue('Project draft');
    await wrapper.get('.app-dialog-heading button').trigger('click');
    navigateTo('projects', undefined, projectId, 'agents');
    await flushPromises();
    await wrapper.get('.map-inspector-heading button').trigger('click');
    expect(wrapper.get('#map-task-message').element).toHaveProperty('value', '');
    await wrapper.get('#map-task-message').setValue('Agent draft');
    await wrapper.get('.app-dialog-heading button').trigger('click');
    navigateTo('projects', undefined, projectId, 'projects');
    await flushPromises();
    await wrapper.get('.map-inspector-heading button').trigger('click');
    expect(wrapper.get('#map-task-message').element).toHaveProperty('value', 'Project draft');
  });
  it('shows a recoverable map error and allows retrying', async () => {
    vi.mocked(fetchProjectArchitecture).mockRejectedValueOnce(new Error('offline'));
    navigateTo('projects', undefined, projectId);
    const wrapper = mount(AgentArchitectureMap, {
      props: { project, tasks: [], cockpit: cockpit() },
    });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('could not be loaded');
    vi.mocked(fetchProjectArchitecture).mockResolvedValue(map);
    await wrapper.get('[role="alert"] button').trigger('click');
    await flushPromises();
    expect(wrapper.find('.map-canvas').exists()).toBe(true);
  });
  it('groups descendant task pins without mixing projects or map definitions', () => {
    const target = targetForNode(map, map.nodes[2]!, 'en');
    const run = {
      id: '30000000-0000-4000-8000-000000000001',
      taskId,
      turnId: '40000000-0000-4000-8000-000000000001',
      status: 'completed',
      version: 1,
      profileId: 'durable-v1',
      baseRevision: revision,
      checkStatus: 'not_run',
      createdAt: timestamp,
    };
    const base = {
      id: taskId,
      title: 'Pinned task',
      projectId,
      projectName: 'Observatory',
      status: 'open',
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      latestRun: run,
      architectureTarget: target,
    };
    const tasks = DurableTaskListSchema.parse({
      items: [
        base,
        {
          ...base,
          id: '20000000-0000-4000-8000-000000000002',
          projectId: '10000000-0000-4000-8000-000000000002',
        },
        {
          ...base,
          id: '20000000-0000-4000-8000-000000000003',
          architectureTarget: { ...target, mapId: 'different-map' },
        },
      ],
      activeTaskIds: [],
    }).items;
    expect(tasksAtNode(map, map.nodes[1]!, tasks).map((task) => task.id)).toEqual([taskId]);
    expect(tasksAtNode(map, map.nodes[3]!, tasks)).toEqual([]);
    expect(architectureTrail(map, map.nodes[2]!).map((entry) => entry.id)).toEqual([
      'root',
      'interface',
      'projects',
    ]);
  });
});
