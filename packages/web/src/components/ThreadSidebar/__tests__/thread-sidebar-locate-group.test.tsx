import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
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
} from '@/components/ThreadSidebar/__tests__/thread-sidebar-test-helpers';
import { SIDEBAR_TAB_STORAGE_KEY } from '@/components/ThreadSidebar/sidebar-tab-state';
import { useLabelStore } from '@/stores/label-store';

vi.mock('@/components/ThreadSidebar/ThreadSidebarV2Header', () => ({ ThreadSidebarV2Header: () => null }));

describe.each([8, 100])('grouped locate from memory with %i members', (memberCount) => {
  let harness: ThreadSidebarHarness;
  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    writeShellPresentation('v2');
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, 'pinned');
    useLabelStore.setState({ labels: [], isLoading: false });
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
    const threads = Array.from({ length: memberCount }, (_, index) => ({
      id: `member-${index}`,
      title: `Member ${index}`,
      projectPath: '/project',
      participants: [],
      createdBy: 'user',
      createdAt: 1710000000000,
      lastActiveAt: 1710000000000,
      pinned: true,
      presence: { status: 'idle' },
    }));
    Object.assign(mockStore, {
      threads,
      currentThreadId: `member-${memberCount - 1}`,
      threadStates: {},
      isLoadingThreads: false,
    });
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/config/thread-attention')
        return jsonOk({
          aliases: {},
          open: {},
          groups: [{ id: 'g', name: 'Our group', threadIds: threads.map((thread) => thread.id) }],
        });
      return defaultSidebarApiMock(path);
    });
    harness = createThreadSidebarHarness();
  });
  afterEach(() => {
    harness.cleanup();
    resetThreadSidebarGlobals();
    vi.restoreAllMocks();
  });

  it('reveals the remembered conversation before trying to locate it', async () => {
    await harness.render({ activeDestination: 'memory' });
    expect(harness.container.textContent).toContain(`其余 ${memberCount - 4} 个对话`);
    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>('[data-testid="select-open-session-btn"]')?.click();
    });
    for (let frame = 0; frame < 4; frame++)
      await act(async () => {
        await new Promise(requestAnimationFrame);
      });
    expect(harness.container.querySelector(`[data-thread-id="member-${memberCount - 1}"]`)).not.toBeNull();
  });
});
