import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadSidebar } from '../ThreadSidebar';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: 'http://localhost:3102',
}));

type TestThread = {
  id: string;
  title: string | null;
  projectPath: string;
  createdBy: string;
  participants: string[];
  lastActiveAt: number;
  createdAt: number;
  pinned: boolean;
  favorited: boolean;
  preferredCats: string[];
};

const NOW = 1_710_000_000_000;
const TEST_THREADS: TestThread[] = Array.from({ length: 24 }, (_, index) => ({
  id: `thread-${String(index + 1).padStart(2, '0')}`,
  title: `测试对话 ${index + 1}`,
  projectPath: '/projects/cat-cafe',
  createdBy: 'user1',
  participants: ['user1'],
  lastActiveAt: NOW - index * 1_000,
  createdAt: NOW - 100_000 - index * 1_000,
  pinned: false,
  favorited: false,
  preferredCats: [],
}));

let storeThreads = [...TEST_THREADS];
const mockStore: Record<string, unknown> = {
  get threads() {
    return storeThreads;
  },
  currentThreadId: 'default',
  setThreads: vi.fn((threads: typeof storeThreads) => {
    storeThreads = threads;
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
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

function findScrollContainer(root: HTMLElement): HTMLDivElement {
  const scroller = Array.from(root.querySelectorAll('div')).find(
    (el): el is HTMLDivElement => el.className.includes('overflow-y-auto') && !!el.querySelector('[data-thread-id]'),
  );
  if (!scroller) throw new Error('scroll container not found');
  return scroller;
}

describe('ThreadSidebar scroll memory', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    storeThreads = [...TEST_THREADS];
    mockStore.currentThreadId = 'default';
    mockPush.mockReset();
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/threads') return jsonOk({ threads: TEST_THREADS });
      if (path === '/api/governance/health') return jsonOk({ projects: [] });
      return jsonOk({});
    });

    const storage: Record<string, string> = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (key: string) => storage[key] ?? null,
        setItem: (key: string, value: string) => {
          storage[key] = value;
        },
        removeItem: (key: string) => {
          delete storage[key];
        },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'sessionStorage', {
      value: {
        getItem: (key: string) => storage[key] ?? null,
        setItem: (key: string, value: string) => {
          storage[key] = value;
        },
        removeItem: (key: string) => {
          delete storage[key];
        },
      },
      writable: true,
      configurable: true,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function expandAll(rootEl: HTMLElement) {
    const expandBtn = rootEl.querySelector('[data-testid="expand-all-btn"]') as HTMLButtonElement | null;
    if (!expandBtn) throw new Error('expand-all button not found');
    act(() => {
      expandBtn.click();
    });
  }

  it('keeps sidebar scroll position when switching to a thread far below', async () => {
    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();
    expandAll(container);

    const scroller = findScrollContainer(container);
    scroller.scrollTop = 280;
    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    const target = container.querySelector('[data-thread-id="thread-18"]') as HTMLDivElement | null;
    expect(target).toBeTruthy();
    act(() => {
      target?.click();
    });

    act(() => root.unmount());
    mockStore.currentThreadId = 'thread-18';
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();
    expandAll(container);

    const nextScroller = findScrollContainer(container);
    expect(nextScroller.scrollTop).toBe(280);
  });

  it('does not overwrite sessionStorage with 0 when sidebar unmounts (detached DOM)', async () => {
    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();
    expandAll(container);

    const scroller = findScrollContainer(container);
    scroller.scrollTop = 350;
    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    // sessionStorage should have 350 from the scroll handler
    expect(window.sessionStorage.getItem('cat-cafe:sidebar:scrollTop')).toBe('350');

    // Unmount — cleanup effect fires while DOM element may be detached
    act(() => root.unmount());

    // The critical assertion: sessionStorage must still hold 350, NOT 0
    expect(window.sessionStorage.getItem('cat-cafe:sidebar:scrollTop')).toBe('350');
  });
});
