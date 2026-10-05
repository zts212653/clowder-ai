import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '@/stores/chat-types';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('../thread-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../thread-navigation')>()),
  pushThreadRouteWithHistory: navigation.push,
}));

import {
  createThreadSidebarHarness,
  installThreadSidebarGlobals,
  mockApiFetch,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

const NOW = 1710000000000;
const thread = (id: string, title: string, lastActiveAt: number): Thread & { lastActiveAt: number } => ({
  id,
  projectPath: '/proj/memory-nav',
  title,
  createdBy: 'user',
  participants: [],
  lastActiveAt,
  createdAt: NOW,
});

describe('F322 sidebar while a Café destination (记忆) is the current page', () => {
  let harness: ThreadSidebarHarness;
  const row = (id: string) => harness.container.querySelector<HTMLElement>(`[data-thread-id="${id}"]`);

  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    navigation.push.mockReset();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
    Object.assign(mockStore, {
      threads: [thread('origin', 'Origin conversation', NOW), thread('other', 'Other conversation', NOW - 1_000)],
      currentThreadId: 'origin',
      threadStates: {},
      isLoadingThreads: false,
    });
    harness = createThreadSidebarHarness();
  });
  afterEach(() => {
    harness.cleanup();
    resetThreadSidebarGlobals();
    vi.restoreAllMocks();
  });

  it('on a conversation, clicking the conversation you are already in does not navigate (unchanged)', async () => {
    await harness.render();
    expect(row('origin')?.getAttribute('aria-current')).toBe('page');
    row('origin')?.click();
    expect(navigation.push).not.toHaveBeenCalled();
    row('other')?.click();
    expect(navigation.push).toHaveBeenCalledWith('other', expect.anything());
  });

  it('on the destination, the conversation you came from is not "current" and clicking it takes you back', async () => {
    await harness.render({ activeDestination: 'memory' });
    expect(row('origin')).not.toBeNull();
    expect(row('origin')?.hasAttribute('aria-current')).toBe(false);
    row('origin')?.click();
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(navigation.push).toHaveBeenCalledWith('origin', expect.anything());
  });

  it('arriving on and leaving the destination re-draws the rows without a remount', async () => {
    await harness.render();
    const before = row('origin');
    expect(before?.getAttribute('aria-current')).toBe('page');
    await harness.render({ activeDestination: 'memory' });
    expect(row('origin')).toBe(before);
    expect(row('origin')?.hasAttribute('aria-current')).toBe(false);
    await harness.render({ activeDestination: null });
    expect(row('origin')?.getAttribute('aria-current')).toBe('page');
  });

  it('on the destination, other conversations still navigate as usual', async () => {
    await harness.render({ activeDestination: 'memory' });
    row('other')?.click();
    expect(navigation.push).toHaveBeenCalledWith('other', expect.anything());
  });
  // Deleting or archiving the conversation the store still remembers used to send you to the default conversation.
  // With a destination current that conversation is not the page you are on, so it must not move you off the page.
  const deleteCalls = () =>
    mockApiFetch.mock.calls.filter(
      (call: unknown[]) => (call[1] as { method?: string } | undefined)?.method === 'DELETE',
    );
  const button = (label: string) =>
    Array.from(harness.container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);

  async function deleteRow(id: string) {
    const expand = harness.container.querySelector<HTMLButtonElement>('[data-testid="expand-all-btn"]');
    if (expand) act(() => expand.click());
    const more = row(id)?.querySelector<HTMLButtonElement>('button[title="更多操作"]');
    if (!more) throw new Error(`no more-actions button on ${id}`);
    act(() => more.click());
    const del = button('删除对话');
    if (!del) throw new Error('no delete item');
    act(() => del.click());
    const confirm = button('移入回收站');
    if (!confirm) throw new Error('no confirm button');
    await act(async () => confirm.click());
    await harness.flush();
  }

  async function archiveProject() {
    const projectTab = Array.from(harness.container.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent?.trim() === '项目',
    ) as HTMLElement | undefined;
    if (!projectTab) throw new Error('no project tab');
    await act(async () => projectTab.click());
    await harness.flush();
    const expand = harness.container.querySelector<HTMLButtonElement>('[data-testid="expand-all-btn"]');
    if (expand) act(() => expand.click());
    const header = Array.from(harness.container.querySelectorAll<HTMLButtonElement>('button[title="更多操作"]')).find(
      (b) => b.closest('[data-thread-id]') === null,
    );
    if (!header) throw new Error('no project header menu');
    act(() => header.click());
    const archive = Array.from(harness.container.querySelectorAll('button, [role="menuitem"], div')).find(
      (el) => el.textContent?.trim() === '归档所有对话' && el.children.length <= 2,
    ) as HTMLElement | undefined;
    if (!archive) throw new Error('no archive item');
    await act(async () => archive.click());
    await harness.flush();
  }

  it('on a conversation, deleting the conversation you are in still takes you to the default one (unchanged)', async () => {
    await harness.render();
    await deleteRow('origin');
    expect(deleteCalls()).toHaveLength(1);
    expect(navigation.push).toHaveBeenCalledWith('default', expect.anything());
  });

  it('on the destination, deleting the conversation the store still remembers does not leave the page', async () => {
    await harness.render({ activeDestination: 'memory' });
    await deleteRow('origin');
    expect(deleteCalls()).toHaveLength(1);
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('on a conversation, archiving the project you are in still takes you to the default conversation (unchanged)', async () => {
    await harness.render();
    await archiveProject();
    expect(deleteCalls().length).toBeGreaterThan(0);
    expect(navigation.push).toHaveBeenCalledWith('default', expect.anything());
  });

  it('on the destination, archiving the project of the remembered conversation does not leave the page', async () => {
    await harness.render({ activeDestination: 'memory' });
    await archiveProject();
    expect(deleteCalls().length).toBeGreaterThan(0);
    expect(navigation.push).not.toHaveBeenCalled();
  });
});
