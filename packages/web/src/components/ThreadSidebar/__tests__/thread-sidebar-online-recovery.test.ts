import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { markApiGetGeneration } from '@/utils/api-get-generation';
import { ThreadSidebar } from '../ThreadSidebar';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: 'http://localhost:3102',
}));

vi.mock('@/utils/offline-store', () => ({
  loadSidebarSnapshot: () => Promise.resolve(null),
  saveSidebarSnapshot: () => Promise.resolve(),
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

const mockStore: Record<string, unknown> = {
  threads: [],
  currentThreadId: 'default',
  setThreads: vi.fn(),
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

import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { __resetSidebarRefreshForTests } from '@/utils/sidebar-thread-snapshot';

let nextMockGetGeneration = 0;

function jsonOk(data: unknown) {
  const response = new Response(JSON.stringify(data), { status: 200 });
  markApiGetGeneration(response, ++nextMockGetGeneration);
  return Promise.resolve(response);
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
    __resetSidebarRefreshForTests();
    nextMockGetGeneration = 0;
    useSidebarProjectionStore.setState({
      rows: [],
      appliedGeneration: 0,
      hasCanonicalSnapshot: false,
      pendingThreadCommands: {},
      refreshing: false,
    });
    threadsFetchCount = 0;
    mockPush.mockReset();
    mockApiFetch.mockReset();
    mockStore.setThreads = vi.fn();
    mockStore.fetchGlobalBubbleDefaults = vi.fn();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/threads?view=sidebar') {
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
      root.render(React.createElement(ThreadSidebar, { routeThreadId: mockStore.currentThreadId as string }));
    });
    await flush();

    expect(useSidebarProjectionStore.getState().rows).toEqual([]);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useSidebarProjectionStore.getState().rows).toEqual([
      expect.objectContaining({ id: 'thread-1', title: '恢复线程' }),
    ]);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads?view=sidebar', undefined, { afterCurrentGet: true });
  });
});
