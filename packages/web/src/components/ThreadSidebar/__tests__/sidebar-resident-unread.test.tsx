import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { writeShellPresentation } from '../../shell/shell-presentation';
import {
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

let harness: ThreadSidebarHarness;
beforeEach(() => {
  installThreadSidebarGlobals();
  resetThreadSidebarMocks();
  writeShellPresentation('v2');
  mockStore.currentThreadId = 'default';
  mockStore.threads = [
    { id: 'thread_assistant', title: '我的助手', unreadCount: 3 },
    { id: 'thread_coordination', title: '后台协调', unreadCount: 8, systemKind: 'plugin_internal' },
    { id: 'thread_business', title: '原业务会话', unreadCount: 1 },
  ].map((row) => ({ projectPath: '/project', participants: [], createdAt: 1, lastActiveAt: 1, ...row }));
  mockApiFetch.mockImplementation((path: string) =>
    path === '/api/plugin-conversations'
      ? jsonOk({
          entries: [
            {
              pluginId: 'dev.resident',
              instanceId: 'resident',
              commandId: 'main',
              label: '我的助手',
              threadId: 'thread_assistant',
              status: 'ready',
            },
          ],
        })
      : defaultSidebarApiMock(path),
  );
  harness = createThreadSidebarHarness();
});
afterEach(() => {
  harness.cleanup();
  writeShellPresentation('classic');
  vi.restoreAllMocks();
  resetThreadSidebarGlobals();
});

it('keeps main unread on the resident entry, hides only internal rows and clears through the shared read command', async () => {
  await harness.render();
  expect(harness.container.querySelector('[data-testid="resident-entry-unread"]')?.textContent).toBe('3 未读');
  expect(harness.container.querySelector('[data-thread-id="thread_assistant"]')).toBeNull();
  expect(harness.container.querySelector('[data-thread-id="thread_coordination"]')).toBeNull();
  expect(harness.container.textContent).not.toContain('后台协调');
  expect(harness.container.textContent).toContain('原业务会话');
  const entry = harness.container.querySelector('nav[aria-label="常驻助手"] button') as HTMLButtonElement;
  await act(async () => entry.click());
  expect(harness.container.querySelector('[data-testid="resident-entry-unread"]')).toBeNull();
  const state = useSidebarProjectionStore.getState();
  expect(
    Object.values(state.pendingThreadCommands).some(
      (command) => command.threadId === 'thread_assistant' && command.field === 'attention',
    ),
  ).toBe(true);
  act(() => {
    state.applySidebarSnapshot(
      state.rows.map((row) => (row.id === 'thread_assistant' ? { ...row, unreadCount: 0 } : row)),
      state.appliedGeneration + 1,
    );
  });
  act(() => {
    const latest = useSidebarProjectionStore.getState();
    latest.applySidebarSnapshot(
      latest.rows.map((row) => (row.id === 'thread_assistant' ? { ...row, unreadCount: 2 } : row)),
      latest.appliedGeneration + 1,
    );
  });
  expect(harness.container.querySelector('[data-testid="resident-entry-unread"]')?.textContent).toBe('2 未读');
  expect(mockApiFetch.mock.calls.filter(([path]) => path === '/api/plugin-conversations')).toHaveLength(1);
});
