import { expect, it } from 'vitest';
import { WORKSPACE_MODE_META, WORKSPACE_MODES, type WorkspaceMode } from '@/lib/workspace-modes';
import { checkShellCopyParity } from '../../shell/__tests__/shell-copy-parity-check';
import { resolveShellCopy } from '../../shell/shell-copy';
import { homeCopy } from '../../workspace-home/workspace-home.shell-copy';
import {
  createBrowserSurface,
  createFilePreviewSurface,
  createTeamWorkspaceSurface,
  createWorkspaceDestinationSurface,
  createWorkspaceModeSurface,
} from '../real-surface-adapters';
import { workbenchTabLabels } from '../workbench-tab-labels';
import { workspaceChromeCopy } from '../workspace-chrome.shell-copy';

it('names opened evaluations consistently with the tools catalogue in both languages', () => {
  const surface = createWorkspaceModeSurface('eval', 'thread-code');
  for (const language of ['zh', 'en'] as const) {
    const chrome = resolveShellCopy(workspaceChromeCopy, language);
    const catalogue = resolveShellCopy(homeCopy, language);
    expect(workbenchTabLabels([surface], chrome.modeTabs).get(surface.id)).toBe(catalogue.rows.eval.label);
  }
});

it('keeps unique owner titles unchanged and separates file paths without changing descriptors', () => {
  const files = ['README.md', 'docs/README.md', 'guide.md'].map((path) =>
    createFilePreviewSurface({ worktreeId: 'work', path }),
  );
  const before = JSON.stringify(files);
  expect([...workbenchTabLabels(files).values()]).toEqual(['README.md', 'docs/README.md', 'guide.md']);
  expect(JSON.stringify(files)).toBe(before);
});

it('distinguishes the same path in different roots and is independent of tab order', () => {
  const files = ['one', 'two'].map((worktreeId) => createFilePreviewSurface({ worktreeId, path: 'docs/README.md' }));
  const labels = workbenchTabLabels(files);
  expect([...labels.values()]).toEqual(['docs/README.md · one', 'docs/README.md · two']);
  expect(workbenchTabLabels([...files].reverse())).toEqual(labels);
});

it('uses the original public context for conflicting non-file owners', () => {
  const pages = ['/a', '/b'].map((path) => createBrowserSurface({ ownerKey: path, port: 4444, path }));
  expect(new Set(workbenchTabLabels(pages).values()).size).toBe(2);
  expect([...workbenchTabLabels(pages).values()]).toEqual([
    'localhost:4444 · /a · managed preview',
    'localhost:4444 · /b · managed preview',
  ]);
});

it('keeps identical-context names unique without colliding with a pre-existing numbered title', () => {
  const pages = ['z', 'a', 'n'].map((ownerKey) => ({
    ...createBrowserSurface({ ownerKey, port: 4444 }),
    title: ownerKey === 'n' ? 'localhost:4444 · / · managed preview (1)' : 'localhost:4444',
  }));
  const labels = workbenchTabLabels(pages);
  expect(new Set(labels.values()).size).toBe(3);
  expect(labels.get(pages[1].id)).toBe('localhost:4444 · / · managed preview (2)');
  expect(workbenchTabLabels([...pages].reverse())).toEqual(labels);
});

const modeLabels: Readonly<Record<WorkspaceMode, string>> = {
  dev: 'Development',
  recall: 'Memory',
  'needs-me': 'To-do',
  'product-schedule': '日程',
  schedule: 'Scheduling',
  tasks: 'Tasks',
  team: 'Team',
  community: 'Community',
  artifacts: 'Works',
  approval: 'Approvals',
  trajectory: 'Trajectory',
  eval: 'Evaluation',
};

it('projects admitted mode owners without translating file names, custom destinations or invalid owners', () => {
  const calendar = createWorkspaceModeSurface('product-schedule', 'thread-code');
  const tasks = createWorkspaceModeSurface('tasks', 'thread-code');
  const team = createTeamWorkspaceSurface({ threadId: 'thread-code' });
  const file = createFilePreviewSurface({ worktreeId: 'work', path: 'Schedule.md' });
  const unknown = { ...tasks, id: 'custom', objectRef: { ...tasks.objectRef, id: 'mode:custom' } };
  const invalid = { ...calendar, id: 'invalid', resultTargetRef: { owner: 'wrong-owner', key: 'wrong' } };
  const surfaces = [calendar, tasks, team, file, unknown, invalid];
  const before = JSON.stringify(surfaces);
  const labels = workbenchTabLabels(surfaces, modeLabels);
  expect(labels.get(calendar.id)).toBe('日程');
  expect(labels.get(tasks.id)).toBe('Tasks');
  expect(labels.get(team.id)).toBe('Team');
  expect(labels.get(file.id)).toBe('Schedule.md');
  expect(labels.get(unknown.id)).toBe(unknown.title);
  expect(labels.get(invalid.id)).toBe(invalid.title);
  expect(JSON.stringify(surfaces)).toBe(before);
});

it('disambiguates translated labels using public context without reverting to the stored language', () => {
  const calendar = createWorkspaceModeSurface('product-schedule', 'thread-code');
  const file = createFilePreviewSurface({ worktreeId: 'work', path: '日程' });
  const labels = workbenchTabLabels([calendar, file], modeLabels);
  expect(labels.get(calendar.id)).toBe(`日程 · ${calendar.context}`);
  expect(labels.get(file.id)).toBe('日程');
  expect(workbenchTabLabels([file, calendar], modeLabels)).toEqual(labels);
  expect(workbenchTabLabels([calendar]).get(calendar.id)).toBe('Schedule');
});

it('uses the complete existing mode inventory in both shell languages', () => {
  expect(checkShellCopyParity(workspaceChromeCopy)).toEqual([]);
  for (const language of ['zh', 'en'] as const) {
    const titles = resolveShellCopy(workspaceChromeCopy, language).modeTabs;
    expect(Object.keys(titles).sort()).toEqual([...WORKSPACE_MODES].sort());
    // Development is a launcher grouping; its files/changes owners are not mode destinations.
    for (const mode of WORKSPACE_MODES.filter((mode) => mode !== 'dev')) {
      const meta = WORKSPACE_MODE_META[mode];
      const surface = createWorkspaceDestinationSurface({ kind: 'mode', id: mode, ...meta }, 'thread-code');
      expect(surface).not.toBeNull();
      if (!surface) throw new Error(`Missing original owner ${mode}`);
      expect(workbenchTabLabels([surface], titles).get(surface.id)).toBe(titles[mode]);
      expect(workbenchTabLabels([surface]).get(surface.id)).toBe(surface.title);
    }
  }
});
