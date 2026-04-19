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

const TEST_THREADS = [
  {
    id: 'thread-1',
    title: '恢复线程',
    projectPath: 'default',
    createdBy: 'default-user',
    participants: [],
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    pinned: false,
    favorited: false,
    preferredCats: [],
  },
];

let storeThreads = [] as typeof TEST_THREADS;
const mockStore: Record<string, unknown> = {
  get threads() {
    return storeThreads;
  },
  currentThreadId: 'default',
  setThreads: vi.fn((threads: typeof TEST_THREADS) => {
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

describe('ThreadSidebar online recovery', () => {
  let container: HTMLDivElement;
  let root: Root;
  let threadsFetchCount = 0;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    storeThreads = [];
    threadsFetchCount = 0;
    mockPush.mockReset();
    mockApiFetch.mockReset();
    mockStore.setThreads = vi.fn((threads: typeof TEST_THREADS) => {
      storeThreads = threads;
    });
    mockStore.fetchGlobalBubbleDefaults = vi.fn();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/threads') {
        threadsFetchCount += 1;
        if (threadsFetchCount === 1) {
          return Promise.reject(new Error('network down'));
        }
        return jsonOk({ threads: TEST_THREADS });
      }
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

  it('reloads threads when the browser comes back online after initial load failure', async () => {
    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();

    expect(mockStore.setThreads).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockStore.setThreads).toHaveBeenCalledWith(TEST_THREADS);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads');
  });
});
