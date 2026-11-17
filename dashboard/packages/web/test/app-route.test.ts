import { describe, expect, it } from 'vitest';
import { parseAppRoute } from '../src/composables/useAppRoute.js';

describe('parseAppRoute', () => {
  it('restores map locations and links directly to a task review', () => {
    expect(parseAppRoute('#/projects/project-1/map/subagents')).toMatchObject({
      page: 'projects',
      projectId: 'project-1',
      nodeId: 'subagents',
    });
    expect(parseAppRoute('#/agent/task-1?view=changes')).toMatchObject({
      page: 'agent',
      taskId: 'task-1',
      view: 'changes',
    });
  });

  it('maps the bare overview hash to the overview page', () => {
    expect(parseAppRoute('#/overview')).toEqual({
      page: 'overview',
      taskId: undefined,
      projectId: undefined,
    });
  });

  it('maps an unknown or missing hash to the overview page', () => {
    expect(parseAppRoute('')).toEqual({
      page: 'overview',
      taskId: undefined,
      projectId: undefined,
    });
    expect(parseAppRoute('#/')).toEqual({
      page: 'overview',
      taskId: undefined,
      projectId: undefined,
    });
    expect(parseAppRoute('#/elsewhere')).toEqual({
      page: 'overview',
      taskId: undefined,
      projectId: undefined,
    });
  });

  it('maps the bare agent hash to the agent page without a task', () => {
    expect(parseAppRoute('#/agent')).toEqual({
      page: 'agent',
      taskId: undefined,
      projectId: undefined,
    });
  });

  it('maps an agent task hash to the agent page with the task id', () => {
    expect(parseAppRoute('#/agent/task-42')).toEqual({
      page: 'agent',
      taskId: 'task-42',
      projectId: undefined,
    });
  });

  it('decodes a percent-encoded task id', () => {
    expect(parseAppRoute('#/agent/task%20id')).toEqual({
      page: 'agent',
      taskId: 'task id',
      projectId: undefined,
    });
  });

  it('keeps a hand-edited invalid percent sequence as the raw segment', () => {
    expect(parseAppRoute('#/agent/task%zz')).toEqual({
      page: 'agent',
      taskId: 'task%zz',
      projectId: undefined,
    });
  });

  it('accepts a hand-edited trailing slash', () => {
    expect(parseAppRoute('#/agent/')).toEqual({
      page: 'agent',
      taskId: undefined,
      projectId: undefined,
    });
    expect(parseAppRoute('#/overview/')).toEqual({
      page: 'overview',
      taskId: undefined,
      projectId: undefined,
    });
  });

  it('ignores deeper hand-edited path segments and keeps the first as the task id', () => {
    expect(parseAppRoute('#/agent/a/b')).toEqual({
      page: 'agent',
      taskId: 'a',
      projectId: undefined,
    });
    expect(parseAppRoute('#/agent/a/b/c')).toEqual({
      page: 'agent',
      taskId: 'a',
      projectId: undefined,
    });
  });

  it('keeps the agent page for a trailing slash after the task id', () => {
    expect(parseAppRoute('#/agent/task-42/')).toEqual({
      page: 'agent',
      taskId: 'task-42',
      projectId: undefined,
    });
  });

  it('maps the bare projects hash to the projects page without a project', () => {
    expect(parseAppRoute('#/projects')).toEqual({
      page: 'projects',
      taskId: undefined,
      projectId: undefined,
    });
  });

  it('maps a project hash to the projects page with the project id', () => {
    expect(parseAppRoute('#/projects/proj-7')).toEqual({
      page: 'projects',
      taskId: undefined,
      projectId: 'proj-7',
    });
  });

  it('decodes a percent-encoded project id', () => {
    expect(parseAppRoute('#/projects/proj%207')).toEqual({
      page: 'projects',
      taskId: undefined,
      projectId: 'proj 7',
    });
  });

  it('accepts a hand-edited trailing slash and keeps the first projects segment', () => {
    expect(parseAppRoute('#/projects/')).toEqual({
      page: 'projects',
      taskId: undefined,
      projectId: undefined,
    });
    expect(parseAppRoute('#/projects/a/b')).toEqual({
      page: 'projects',
      taskId: undefined,
      projectId: 'a',
    });
  });
});

it('restores integrated studio and gallery links on refresh', () => {
  for (const page of ['studio', 'gallery']) expect(parseAppRoute('#/' + page).page).toBe(page);
});
