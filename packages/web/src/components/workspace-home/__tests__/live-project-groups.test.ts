import { expect, it } from 'vitest';
import { groupLiveProjects } from '../live-project-groups';
import { live } from './home-fixtures';

it('orders current project, longest running projects, and Uncategorized while disambiguating directory names', () => {
  const executions = [
    { ...live('kimi', 'c', 'current', 'e3'), projectPath: '/z/demo', startedAt: 30 },
    { ...live('kimi', 'a', 'older', 'e1'), projectPath: '/a/demo', startedAt: 10 },
    { ...live('kimi', 'b', 'middle', 'e2'), projectPath: '/b/another', startedAt: 20 },
    { ...live('kimi', 'd', 'unassigned', 'e0'), projectPath: 'default', startedAt: 0 },
  ];
  const groups = groupLiveProjects(executions, '/z/demo', ['/failed']);
  expect(groups.map((group) => group.path)).toEqual(['/z/demo', '/a/demo', '/b/another', '/failed', 'default']);
  expect(groups.slice(0, 2).map((group) => group.label)).toEqual(['z/demo', 'a/demo']);
  expect(groups.find((group) => group.path === '/failed')).toMatchObject({ unavailable: true, executions: [] });
  expect(
    groupLiveProjects([...executions, { ...executions[1], executionId: 'new', startedAt: 999 }], '/z/demo', []).map(
      (group) => group.path,
    ),
  ).toEqual(['/z/demo', '/a/demo', '/b/another', 'default']);
});

it('keeps expanding a colliding suffix until every owning project can be distinguished', () => {
  const paths = ['/users/alice/work/cat-cafe', '/tmp/work/cat-cafe', '/work/cat-cafe'];
  const groups = groupLiveProjects(
    paths.map((projectPath, index) => ({
      ...live('kimi', `thread-${index}`, '同名对话', `run-${index}`),
      projectPath,
    })),
    null,
    [],
  );
  expect(new Set(groups.map((group) => group.label)).size).toBe(paths.length);
  expect(groups.find((group) => group.path === paths[0])?.label).toBe('alice/work/cat-cafe');
  expect(groups.find((group) => group.path === paths[1])?.label).toBe('tmp/work/cat-cafe');
  expect(groups.find((group) => group.path === paths[2])?.label).toBe('/work/cat-cafe');
});
