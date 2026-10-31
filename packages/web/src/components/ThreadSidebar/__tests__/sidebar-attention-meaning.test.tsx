import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { SIDEBAR_TAB_STORAGE_KEY } from '../sidebar-tab-state';
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
const ids = ['old-pin', 'older', 'oldest', 'other', 'latest', 'hidden'];
beforeEach(() => {
  installThreadSidebarGlobals();
  resetThreadSidebarMocks();
  writeShellPresentation('v2');
  window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, 'recent');
  mockStore.currentThreadId = 'default';
  mockStore.threads = [...ids, 'outside'].map((id, index) => ({
    id,
    title: id,
    projectPath: '/project',
    createdBy: 'user',
    participants: [],
    createdAt: 1,
    lastActiveAt: id === 'latest' ? 100 : id === 'outside' ? 90 : index + 1,
    pinned: id === 'old-pin',
    unreadCount: id === 'latest' ? 12 : 0,
    hasUserMention: id === 'latest',
    presence: { status: index === 0 ? 'error' : index < 3 ? 'done' : 'idle' },
  }));
  harness = createThreadSidebarHarness();
});
afterEach(() => {
  harness.cleanup();
  writeShellLanguage('zh');
  writeShellPresentation('classic');
  vi.restoreAllMocks();
  resetThreadSidebarGlobals();
});
function preferences(open: boolean, grouped = true, memberSort?: 'running-first') {
  mockApiFetch.mockImplementation((path: string) =>
    path === '/api/config/thread-attention'
      ? jsonOk({
          aliases: {},
          memberSort: memberSort ? { 'group:g': memberSort } : {},
          open: { 'group:g': open },
          groups: grouped ? [{ id: 'g', name: 'Our group', threadIds: ids }] : [],
        })
      : defaultSidebarApiMock(path),
  );
}
function updateActivity(id: string, activity: number) {
  act(() => {
    const store = useSidebarProjectionStore.getState();
    store.applySidebarSnapshot(
      store.rows.map((row) => (row.id === id ? { ...row, lastActiveAt: activity, unreadCount: 4 } : row)),
      store.appliedGeneration + 1,
    );
  });
}
function threadIds() {
  return [...harness.container.querySelectorAll('[data-thread-id]')].map((element) =>
    element.getAttribute('data-thread-id'),
  );
}
function point(type: string) {
  act(() => harness.container.querySelector('[data-testid="sidebar-thread-list"]')?.dispatchEvent(new Event(type)));
}
it.each([
  'zh',
  'en',
] as const)('production collapsed summary preserves presence and keeps attention meaning on its conversation in %s', async (language) => {
  writeShellLanguage(language);
  preferences(false);
  await harness.render();
  const summary = () => harness.container.querySelector('[data-testid="group-presence-summary"]');
  expect(summary()?.textContent).toBe(language === 'zh' ? '1 个出错' : '1 error');
  expect(harness.container.querySelector('[data-testid="group-unread"]')).toBeNull();
  expect(harness.container.querySelector('[data-testid="group-mention"]')).toBeNull();
  // This harness does not confirm unified decisions; never report a falsely complete count.
  expect(harness.container.querySelector('[data-testid="group-count"]')?.textContent).toBe('…');
  const shortcut = () => harness.container.querySelector('[data-peek-reason]');
  expect(shortcut()?.getAttribute('data-thread-id')).toBe('latest');
  expect(shortcut()?.querySelector('[data-testid="group-peek-title"]')?.textContent).toBe('latest');
  expect(shortcut()?.querySelector('[data-testid="group-peek-label"]')?.textContent).toBe(
    language === 'zh' ? '@你' : '@you',
  );
  act(() => {
    const store = useSidebarProjectionStore.getState();
    store.applySidebarSnapshot(
      store.rows.map((row) => ({ ...row, hasUserMention: false, presence: { status: 'done' } })),
      store.appliedGeneration + 1,
    );
  });
  expect(summary()?.textContent).toContain(language === 'zh' ? '6 个已回复' : '6 replied');
  expect(summary()?.querySelector('[data-testid="group-replied-cat"]')).not.toBeNull();
  expect(shortcut()?.getAttribute('data-peek-reason')).toBe('unread');
  expect(shortcut()?.querySelector('[data-testid="group-peek-label"]')?.textContent).toBe(
    language === 'zh' ? '12 未读' : '12 unread',
  );
  preferences(true);
  harness.cleanup();
  harness = createThreadSidebarHarness();
  await harness.render();
  const unreadRow = harness.container.querySelector('[data-thread-id="latest"]');
  expect(unreadRow?.querySelector('[data-testid="thread-row-unread"]')?.textContent).toBe(
    language === 'zh' ? '12 未读' : '12 unread',
  );
  act(() => writeShellPresentation('classic'));
  expect(harness.container.querySelector('[data-testid="group-presence-summary"]')).toBeNull();
  expect(harness.container.querySelector('[data-testid="group-unread"]')).toBeNull();
});
it('production recent order includes pin-first members, previews the end, and releases on pointer leave', async () => {
  preferences(true);
  await harness.render();
  expect(threadIds()).toEqual(['old-pin', 'latest', 'hidden', 'other', 'outside']);
  expect(
    [...harness.container.querySelectorAll('button')].find((button) => button.textContent === '其余 2 个对话')
      ?.textContent,
  ).toContain('2');
  point('pointerenter');
  updateActivity('older', 120);
  expect(threadIds()).toEqual(['old-pin', 'latest', 'hidden', 'other', 'outside']);
  point('pointerleave');
  expect(threadIds()).toEqual(['old-pin', 'older', 'latest', 'hidden', 'outside']);
  updateActivity('other', 150);
  expect(threadIds()).toEqual(['old-pin', 'other', 'older', 'latest', 'outside']);
  expect(
    mockApiFetch.mock.calls.filter(([, options]) => options?.method === 'PUT' || options?.method === 'POST'),
  ).toHaveLength(0);
});
it('retains the existing running-first preference while bringing recently active non-running members into the preview', async () => {
  preferences(true, true, 'running-first');
  await harness.render();
  expect(threadIds()).toEqual(['old-pin', 'latest', 'hidden', 'other', 'outside']);
  expect(
    mockApiFetch.mock.calls.filter(([, options]) => options?.method === 'PUT' || options?.method === 'POST'),
  ).toHaveLength(0);
});
it('production recent sorting also applies when there is no Group, while classic retains its old work/unread rule', async () => {
  preferences(false, false);
  await harness.render();
  expect(threadIds()).toEqual(['old-pin', 'latest', 'outside', 'hidden', 'other', 'oldest', 'older']);
  point('pointerenter');
  updateActivity('older', 120);
  expect(threadIds()).toEqual(['old-pin', 'latest', 'outside', 'hidden', 'other', 'oldest', 'older']);
  point('pointerleave');
  expect(threadIds()[1]).toBe('older');
  act(() => writeShellPresentation('classic'));
  // Both are unread, so their current activity resolves their classic tie; do not inherit the v2 placement snapshot.
  expect(threadIds().slice(0, 3)).toEqual(['old-pin', 'older', 'latest']);
});
