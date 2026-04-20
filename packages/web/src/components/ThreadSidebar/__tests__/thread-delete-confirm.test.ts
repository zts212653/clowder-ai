/**
 * I-1: Thread deletion must show a confirmation dialog before proceeding.
 * Verifies that clicking delete shows a dialog, cancel dismisses it,
 * and confirm actually triggers the DELETE API call.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadSidebar } from '../ThreadSidebar';

// ── Mocks ─────────────────────────────────────────────────────
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: 'http://localhost:3102',
}));

const TEST_THREAD = {
  id: 'thread_abc123',
  title: '和砚砚讨论家规',
  projectPath: '/projects/cat-cafe',
  createdBy: 'user1',
  participants: ['user1'],
  lastActiveAt: Date.now(),
  createdAt: Date.now() - 100000,
  pinned: false,
  favorited: false,
  preferredCats: [] as string[],
};

let storeThreads = [TEST_THREAD];
const mockStore: Record<string, unknown> = {
  get threads() {
    return storeThreads;
  },
  currentThreadId: 'default',
  setThreads: vi.fn((t: typeof storeThreads) => {
    storeThreads = t;
  }),
  setCurrentProject: vi.fn(),
  isLoadingThreads: false,
  setLoadingThreads: vi.fn(),
  updateThreadTitle: vi.fn(),
  getThreadState: () => ({ catStatuses: {}, unreadCount: 0 }),
  updateThreadPin: vi.fn(),
  updateThreadFavorite: vi.fn(),
  updateThreadPreferredCats: vi.fn(),
  threadStates: {},
  clearUnread: vi.fn(),
  clearAllUnread: vi.fn(),
  initThreadUnread: vi.fn(),
  fetchGlobalBubbleDefaults: vi.fn(),
};
vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(
    (selector?: (s: typeof mockStore) => unknown) => (selector ? selector(mockStore) : mockStore),
    { getState: () => mockStore },
  );
  return { useChatStore: hook };
});
vi.mock('../TaskPanel', () => ({ TaskPanel: () => null }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => null, cats: [] }),
}));

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(data) });
}

describe('Thread delete confirmation (I-1)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    storeThreads = [TEST_THREAD];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    mockPush.mockReset();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/threads') return jsonOk({ threads: [TEST_THREAD] });
      return jsonOk({});
    });
    // Provide localStorage stub for collapse-state persistence
    const store: Record<string, string> = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
        removeItem: (k: string) => {
          delete store[k];
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function flush() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  function findDeleteButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('title') === '删除对话');
  }

  /** F095 defaults all sections collapsed. Click expand-all first. */
  function expandAll() {
    const expandBtn = container.querySelector('[data-testid="expand-all-btn"]') as HTMLButtonElement | null;
    if (expandBtn)
      act(() => {
        expandBtn.click();
      });
  }

  it('shows confirmation dialog when clicking delete', async () => {
    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();
    expandAll();

    const deleteBtn = findDeleteButton();
    expect(deleteBtn, 'delete button should exist for non-default thread').toBeTruthy();

    act(() => {
      deleteBtn?.click();
    });

    // Dialog should appear with thread title and warning
    expect(container.textContent).toContain('确认删除对话');
    expect(container.textContent).toContain('和砚砚讨论家规');
    expect(container.textContent).toContain('回收站');

    // No DELETE API call yet
    const deleteCalls = mockApiFetch.mock.calls.filter(
      (call: unknown[]) => (call[1] as { method?: string } | undefined)?.method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('dismisses dialog when clicking cancel', async () => {
    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();
    expandAll();

    const deleteBtn = findDeleteButton();
    act(() => {
      deleteBtn?.click();
    });
    expect(container.textContent).toContain('确认删除对话');

    // Click cancel
    const cancelBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '取消')!;
    act(() => {
      cancelBtn.click();
    });

    // Dialog should be gone
    expect(container.textContent).not.toContain('确认删除对话');
  });

  it('calls DELETE API only after clicking confirm', async () => {
    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();
    expandAll();

    const deleteBtn = findDeleteButton();
    act(() => {
      deleteBtn?.click();
    });

    // Click confirm
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '移入回收站')!;
    expect(confirmBtn).toBeTruthy();

    await act(async () => {
      confirmBtn.click();
    });
    await flush();

    // Now DELETE should have been called
    const deleteCalls = mockApiFetch.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === `/api/threads/${TEST_THREAD.id}` &&
        (call[1] as { method?: string } | undefined)?.method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(1);
  });
});
