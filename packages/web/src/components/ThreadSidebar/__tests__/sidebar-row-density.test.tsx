import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '../../shell/shell-presentation';
import {
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  mockApiFetch,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

let harness: ThreadSidebarHarness;
vi.mock('../ThreadSidebarV2Header', () => ({ ThreadSidebarV2Header: () => null }));
beforeEach(() => {
  installThreadSidebarGlobals();
  resetThreadSidebarMocks();
  writeShellPresentation('v2');
  localStorage.setItem('cat-cafe:sidebar:active-tab', 'project');
  Object.assign(mockStore, {
    threads: ['a', 'b'].map((id) => ({
      id,
      title: id,
      projectPath: '/project',
      participants: [],
      createdBy: 'user',
      createdAt: 1,
      lastActiveAt: 1,
    })),
    currentThreadId: 'default',
    threadStates: {},
    isLoadingThreads: false,
  });
  mockApiFetch.mockImplementation(defaultSidebarApiMock);
  harness = createThreadSidebarHarness();
});
afterEach(() => {
  harness.cleanup();
  writeShellPresentation('classic');
  resetThreadSidebarGlobals();
});
it('does not reserve classic 80px slots around compact v2 project conversations', async () => {
  await harness.render();
  await act(async () => harness.container.querySelector<HTMLButtonElement>('[aria-label="展开全部项目"]')?.click());
  const rows = [...harness.container.querySelectorAll('[data-thread-id]')];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.closest('.h-20')).toBeNull();
});

it('uses the project folder name for Windows paths', async () => {
  const { projectDisplayName } = await import('../thread-utils');
  expect(projectDisplayName('G:\\AIwork\\clowder-ai\\worktrees\\feat-onboarding-first-run\\')).toBe(
    'feat-onboarding-first-run',
  );
  expect(projectDisplayName('G:/AIwork/clowder-ai/clowder-ai-runtime')).toBe('clowder-ai-runtime');
});
