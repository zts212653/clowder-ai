import { act } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { SIDEBAR_TAB_STORAGE_KEY } from '../sidebar-tab-state';
import { CHAT_THREAD_ROUTE_EVENT, getThreadIdFromPathname } from '../thread-navigation';
import {
  createThreadSidebarHarness,
  getCatByIdMock,
  installThreadSidebarGlobals,
  mockApiFetch,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

let harness: ThreadSidebarHarness;
const followRoute = () => {
  mockStore.currentThreadId = getThreadIdFromPathname(window.location.pathname);
};
beforeEach(() => {
  installThreadSidebarGlobals();
  resetThreadSidebarMocks();
  writeShellPresentation('v2');
  window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, 'project');
  mockStore.currentThreadId = 'row-0';
  mockStore.threads = Array.from({ length: 24 }, (_, i) => ({
    id: `row-${i}`,
    title: `Thread ${i}`,
    participants: [`participant-${i}`],
    projectPath: '/private/project',
    lastActiveAt: Date.now() - i * 1000,
    unreadCount: i ? 21 : 0,
    hasUserMention: false,
    presence: { status: 'idle' },
  }));
  window.history.replaceState(null, '', '/thread/row-0');
  window.addEventListener(CHAT_THREAD_ROUTE_EVENT, followRoute);
  harness = createThreadSidebarHarness();
});
afterEach(() => {
  harness.cleanup();
  window.removeEventListener(CHAT_THREAD_ROUTE_EVENT, followRoute);
  writeShellPresentation('classic');
  resetThreadSidebarGlobals();
});

it('clears unread and selects the row without rerendering unchanged project rows', async () => {
  await harness.render();
  expect(harness.container.querySelector('[data-thread-id="row-1"] [data-testid="thread-row-unread"]')).not.toBeNull();
  getCatByIdMock.mockClear();
  await act(async () => {
    (harness.container.querySelector('[data-thread-id="row-1"] [role="link"]') as HTMLElement).click();
  });
  await harness.render();
  const selected = harness.container.querySelector('[data-thread-id="row-1"]');
  expect(selected?.getAttribute('aria-current')).toBe('page');
  expect(selected?.querySelector('[data-testid="thread-row-unread"]')).toBeNull();
  expect(harness.container.querySelector('[data-thread-id="row-2"] [data-testid="thread-row-unread"]')).not.toBeNull();
  // Each real ThreadItem resolves its participant during render. Unchanged rows
  // must not repeat that work; this catches the callback identity regression
  // without making CI depend on a wall-clock browser benchmark.
  const participants = getCatByIdMock.mock.calls.flat();
  expect(participants).toContain('participant-1');
  expect(participants.filter((id) => id !== 'participant-0' && id !== 'participant-1')).toEqual([]);
});

it('uses the latest projected title when asking to delete', async () => {
  await harness.render();
  await act(async () => {
    useSidebarProjectionStore.setState((state) => ({
      rows: state.rows.map((row) => (row.id === 'row-1' ? { ...row, title: 'Updated title' } : row)),
    }));
  });
  const row = harness.container.querySelector('[data-thread-id="row-1"]');
  if (!row) throw new Error('missing updated project row');
  await act(async () => {
    (row.querySelector('button[aria-label="更多操作"]') as HTMLButtonElement).click();
  });
  const remove = Array.from(harness.container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === '删除对话',
  );
  expect(remove).toBeDefined();
  await act(async () => {
    remove?.click();
  });
  expect(harness.container.textContent).toContain('Updated title');
  expect(harness.container.textContent).toContain('确认删除对话');
  const confirm = Array.from(harness.container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === '移入回收站',
  );
  expect(confirm?.disabled).toBe(false);
  expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
});
