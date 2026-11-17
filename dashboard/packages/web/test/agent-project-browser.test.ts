import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentProjectSchema,
  DurableTaskListSchema,
  type AgentProject,
  type DurableTaskList,
} from '@observatory/contracts';
import AgentProjectBrowser from '../src/components/agent/AgentProjectBrowser.vue';
import WorkspaceHome from '../src/components/WorkspaceHome.vue';
import { appRoute, navigateTo } from '../src/composables/useAppRoute.js';

enableAutoUnmount(afterEach);

const mockState = vi.hoisted(() => ({
  projects: [] as AgentProject[],
  tasks: { items: [], activeTaskIds: [] } as DurableTaskList,
}));

vi.mock('../src/lib/api.js', () => ({
  HealthFetchError: class HealthFetchError extends Error {},
  fetchAgent: vi.fn(async () => undefined),
  fetchAgentTasks: vi.fn(async () => mockState.tasks),
  fetchAgentTask: vi.fn(async () => {
    throw new Error('not available in this test');
  }),
  fetchAgentProjects: vi.fn(async () => mockState.projects),
  fetchProjectArchitecture: vi.fn(async () => {
    throw new Error('map unavailable');
  }),
  subscribeAgent: vi.fn(() => vi.fn()),
  deleteAgentTask: vi.fn(),
  cancelAgentRun: vi.fn(),
  pauseAgentRun: vi.fn(),
  continueAgentTask: vi.fn(),
  queueAgentFollowup: vi.fn(),
  answerAgentQuestion: vi.fn(),
  acceptAgentRunResult: vi.fn(),
  mergeAgentRunResult: vi.fn(),
  collectAgentRunTrace: vi.fn(),
  startAgentRun: vi.fn(),
  startAgentReview: vi.fn(),
  startAgentCorrection: vi.fn(),
  startAgentConflictResolution: vi.fn(),
  startReleaseBuild: vi.fn(),
  activateRelease: vi.fn(),
  rollbackRelease: vi.fn(),
  steerAgentRun: vi.fn(),
}));

const revision = 'a'.repeat(40);
const run = (id: string, taskId: string, status: string) => ({
  id,
  taskId,
  turnId: '11111111-1111-4111-8111-111111111111',
  status,
  version: 1,
  profileId: 'p',
  baseRevision: revision,
  checkStatus: 'not_run',
  createdAt: '2026-01-01T00:00:00.000Z',
  reason: 'test run',
});
const task = (
  id: string,
  title: string,
  projectId: string,
  projectName: string,
  status: string,
  updatedAt: string
) => ({
  id,
  title,
  projectId,
  projectName,
  status: 'open',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt,
  latestRun: run(`40000000-0000-4000-8000-${id.slice(-12)}`, id, status),
});

function seedProjectsAndTasks(): void {
  mockState.projects = [
    AgentProjectSchema.parse({
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Alpha',
      repositoryPath: '/tmp/alpha',
      targetBranch: 'main',
      editPaths: ['src'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }),
    AgentProjectSchema.parse({
      id: '20000000-0000-4000-8000-000000000002',
      name: 'Beta',
      repositoryPath: '/tmp/beta',
      targetBranch: 'main',
      editPaths: ['.'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }),
  ];
  mockState.tasks = DurableTaskListSchema.parse({
    items: [
      task(
        '30000000-0000-4000-8000-000000000003',
        'Alpha live task',
        '10000000-0000-4000-8000-000000000001',
        'Alpha',
        'running',
        '2026-02-03T00:00:00.000Z'
      ),
      task(
        '30000000-0000-4000-8000-000000000004',
        'Alpha done task',
        '10000000-0000-4000-8000-000000000001',
        'Alpha',
        'completed',
        '2026-02-01T00:00:00.000Z'
      ),
      task(
        '30000000-0000-4000-8000-000000000005',
        'Beta task',
        '20000000-0000-4000-8000-000000000002',
        'Beta',
        'completed',
        '2026-01-15T00:00:00.000Z'
      ),
    ],
    activeTaskIds: ['30000000-0000-4000-8000-000000000003'],
  });
}

afterEach(async () => {
  window.location.hash = '';
  appRoute.page = 'overview';
  appRoute.taskId = undefined;
  appRoute.projectId = undefined;
  await flushPromises();
});

describe('project browser', () => {
  it('hides archived projects by default, with explicit access to their historical tasks', async () => {
    seedProjectsAndTasks();
    mockState.projects[1]!.archived = true;
    appRoute.page = 'projects';
    const wrapper = mount(AgentProjectBrowser);
    await flushPromises();
    expect(wrapper.findAll('.shared-project-card')).toHaveLength(1);
    expect(wrapper.findAll('.shared-project-card')[0]!.text()).toContain('Alpha');
    await wrapper.get('.project-archived-filter input').setValue(true);
    expect(wrapper.findAll('.shared-project-card')).toHaveLength(2);
    appRoute.projectId = mockState.projects[1]!.id;
    await flushPromises();
    expect(wrapper.text()).toContain('Archived');
    expect(wrapper.text()).toContain('Beta task');
  });

  it('omits archived registrations from workspace recent projects', async () => {
    seedProjectsAndTasks();
    mockState.projects[1]!.archived = true;
    const wrapper = mount(WorkspaceHome);
    await flushPromises();
    const recent = wrapper.get('.shared-project-grid');
    expect(recent.text()).toContain('Alpha');
    expect(recent.text()).not.toContain('Beta');
  });

  it('lists registered projects grouped with their task counts', async () => {
    seedProjectsAndTasks();
    appRoute.page = 'projects';
    const wrapper = mount(AgentProjectBrowser);
    await flushPromises();
    const rows = wrapper.findAll('.shared-project-card');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.text()).toContain('Alpha');
    expect(rows[0]?.text()).toContain('2 tasks');
    expect(rows[0]?.text()).toContain('1 active');
    expect(rows[1]?.text()).toContain('Beta');
    expect(rows[1]?.text()).toContain('1 task');
  });

  it('opens the project and lists its tasks newest first', async () => {
    seedProjectsAndTasks();
    const projectId = '10000000-0000-4000-8000-000000000001';
    appRoute.page = 'projects';
    appRoute.projectId = projectId;
    const wrapper = mount(AgentProjectBrowser);
    await flushPromises();
    expect(wrapper.find('.project-detail-meta').text()).toContain('/tmp/alpha');
    const titles = wrapper
      .findAll('.task-table .task-table-row .task-table-title')
      .map((row) => row.text());
    expect(titles).toEqual(['Alpha live task', 'Alpha done task']);
    expect(wrapper.get('.project-view-tabs [aria-selected="true"]').text()).toContain(
      'All project tasks'
    );
    await wrapper.findAll('.project-view-tabs button')[1]!.trigger('click');
    expect(wrapper.find('.task-table').exists()).toBe(false);
    expect(wrapper.get('.project-view-tabs [aria-selected="true"]').text()).toBe('Project map');
    await wrapper.findAll('.project-view-tabs button')[0]!.trigger('click');
    expect(wrapper.findAll('.task-table-row')).toHaveLength(2);
  });

  it('opens a project directly from a list row', async () => {
    seedProjectsAndTasks();
    appRoute.page = 'projects';
    const wrapper = mount(AgentProjectBrowser);
    await flushPromises();
    // No preview card or open button: one click on the row navigates.
    expect(wrapper.find('.workbench-preview').exists()).toBe(false);
    expect(wrapper.find('.workbench-open-project').exists()).toBe(false);
    await wrapper.findAll('.project-card-link')[0]?.trigger('click');
    expect(appRoute.page).toBe('projects');
    expect(appRoute.projectId).toBe('10000000-0000-4000-8000-000000000001');
    expect(wrapper.get('.project-detail-meta').text()).toContain('/tmp/alpha');
  });

  it('opens a task directly from a project-detail row', async () => {
    seedProjectsAndTasks();
    appRoute.page = 'projects';
    appRoute.projectId = '10000000-0000-4000-8000-000000000001';
    const wrapper = mount(AgentProjectBrowser);
    await flushPromises();
    expect(wrapper.find('.workbench-preview').exists()).toBe(false);
    expect(wrapper.find('.workbench-task-context').exists()).toBe(false);
    await wrapper.find('.task-table .task-table-row').trigger('click');
    expect(appRoute.page).toBe('agent');
    expect(appRoute.taskId).toBe('30000000-0000-4000-8000-000000000003');
  });

  it('toggles a pin without navigating to the project', async () => {
    seedProjectsAndTasks();
    navigateTo('projects');
    const wrapper = mount(AgentProjectBrowser);
    await flushPromises();
    const pin = wrapper.findAll('.project-card-pin')[0]!;
    expect(pin.attributes('aria-pressed')).toBe('false');
    await pin.trigger('click');
    expect(pin.attributes('aria-pressed')).toBe('true');
    expect(appRoute.page).toBe('projects');
    expect(appRoute.projectId).toBeUndefined();
    await pin.trigger('click');
    expect(pin.attributes('aria-pressed')).toBe('false');
    expect(appRoute.projectId).toBeUndefined();
  });

  it('keeps tasks of an unregistered project visible under their stored name', async () => {
    seedProjectsAndTasks();
    mockState.projects = [];
    appRoute.page = 'projects';
    const wrapper = mount(AgentProjectBrowser);
    await flushPromises();
    const rows = wrapper.findAll('.shared-project-card');
    expect(rows.map((row) => row.text())).toEqual(
      expect.arrayContaining([expect.stringContaining('Alpha'), expect.stringContaining('Beta')])
    );
  });
  it('keeps project cards accessible with a real link and separate actions', async () => {
    seedProjectsAndTasks();
    appRoute.page = 'projects';
    const wrapper = mount(AgentProjectBrowser);
    await flushPromises();
    expect(wrapper.findAll('article.shared-project-card > a.project-card-link')).toHaveLength(2);
    expect(wrapper.get('.project-card-link').attributes('href')).toContain('#/projects/');
    expect(wrapper.get('.project-card-create').text()).toContain('New task');
  });

  it('sorts and filters the project list without a preview pane', async () => {
    seedProjectsAndTasks();
    appRoute.page = 'projects';
    const wrapper = mount(AgentProjectBrowser);
    await flushPromises();
    expect(wrapper.find('.workbench-preview').exists()).toBe(false);
    await wrapper.get('select').setValue('name');
    expect(wrapper.findAll('.shared-project-card')[0]!.text()).toContain('Alpha');
    await wrapper.get('input[type="search"]').setValue('Alpha');
    expect(wrapper.findAll('.shared-project-card')).toHaveLength(1);
    await wrapper.get('input[type="search"]').setValue('missing');
    expect(wrapper.findAll('.shared-project-card')).toHaveLength(0);
    expect(wrapper.text()).toContain('No projects match your search.');
  });

  it('explains stale project links and allows returning to the overview', async () => {
    seedProjectsAndTasks();
    appRoute.page = 'projects';
    appRoute.projectId = 'missing';
    const wrapper = mount(AgentProjectBrowser);
    await flushPromises();
    expect(wrapper.get('.task-note').text()).toContain('This project is no longer available.');
    expect(wrapper.find('.project-grid').exists()).toBe(false);
    await wrapper.get('.task-back-button').trigger('click');
    expect(appRoute.projectId).toBeUndefined();
    expect(wrapper.findAll('.shared-project-card')).toHaveLength(2);
  });

  it('keeps the start page focused on active work and links to dedicated hardware', async () => {
    seedProjectsAndTasks();
    appRoute.page = 'overview';
    const wrapper = mount(WorkspaceHome);
    await flushPromises();
    expect(wrapper.findAll('.workspace-inbox')[0]!.findAll('.workspace-task-row')).toHaveLength(1);
    expect(wrapper.findAll('.workspace-inbox')[0]!.text()).toContain('Alpha live task');
    expect(wrapper.findAll('.workspace-inbox')[1]!.findAll('.workspace-task-row')).toHaveLength(2);
    expect(wrapper.find('.kpi-grid').exists()).toBe(false);
    expect(wrapper.find('.workbench-preview').exists()).toBe(false);
    await wrapper.get('.workspace-home-links .text-button').trigger('click');
    expect(appRoute.page).toBe('hardware');
  });

  it('opens a task directly from a start-page inbox row', async () => {
    seedProjectsAndTasks();
    appRoute.page = 'overview';
    const wrapper = mount(WorkspaceHome);
    await flushPromises();
    await wrapper.find('.workspace-inbox .workspace-task-row').trigger('click');
    expect(appRoute.page).toBe('agent');
    expect(appRoute.taskId).toBe('30000000-0000-4000-8000-000000000003');
  });
});
