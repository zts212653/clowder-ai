import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

const hoistedMocks = vi.hoisted(() => ({
  addToastMock: vi.fn(),
  mockApiFetch: vi.fn(),
  mockPush: vi.fn(),
}));

export const mockPush = hoistedMocks.mockPush;
export const mockApiFetch = hoistedMocks.mockApiFetch;
export const addToastMock = hoistedMocks.addToastMock;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: 'http://localhost:3102',
}));

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

vi.mock('@/stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({ addToast: addToastMock }),
  },
}));

vi.mock('../TaskPanel', () => ({ TaskPanel: () => null }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => null, cats: [] }),
}));

import { ThreadSidebar } from '../ThreadSidebar';

export function installThreadSidebarGlobals() {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

export function resetThreadSidebarGlobals() {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
}

export function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

export function textFail(status = 500, body = 'fail') {
  return Promise.resolve({ ok: false, status, text: () => Promise.resolve(body) });
}

export function defaultSidebarApiMock(path: string) {
  if (path === '/api/threads') return jsonOk({ threads: [] });
  if (path === '/api/governance/health') return jsonOk({ projects: [] });
  if (path === '/api/projects/cwd') return jsonOk({ path: '/test' });
  if (path === '/api/backlog/items') return jsonOk({ items: [] });
  if (path.startsWith('/api/projects/browse')) {
    return jsonOk({
      current: '/test',
      name: 'test',
      parent: '/',
      entries: [],
    });
  }
  return jsonOk({});
}

export function resetThreadSidebarMocks() {
  mockApiFetch.mockReset();
  mockPush.mockReset();
  addToastMock.mockReset();
  mockApiFetch.mockImplementation((path: string) => defaultSidebarApiMock(path));

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
}

export interface ThreadSidebarHarness {
  container: HTMLDivElement;
  root: Root;
  cleanup: () => void;
  flush: () => Promise<void>;
  render: (props?: React.ComponentProps<typeof ThreadSidebar>) => Promise<void>;
}

export function createThreadSidebarHarness(): ThreadSidebarHarness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  return {
    container,
    root,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
    flush,
    render: async (props) => {
      act(() => {
        root.render(React.createElement(ThreadSidebar, props));
      });
      await flush();
    },
  };
}

export async function openCreateDialog(container: HTMLElement, flush: () => Promise<void>) {
  const newButton = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('新对话'),
  );
  if (!newButton) throw new Error('新对话 button not found');

  await act(async () => {
    newButton.click();
  });
  await flush();
}

export async function createInLobby(container: HTMLElement, flush: () => Promise<void>) {
  const lobbyButton = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('大厅'),
  );
  if (!lobbyButton) throw new Error('大厅 button not found');

  await act(async () => {
    lobbyButton.click();
  });

  const confirmButton = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('创建对话'),
  );
  if (!confirmButton) throw new Error('创建对话 button not found');

  await act(async () => {
    confirmButton.click();
  });
  await flush();
}

export async function clickBootcampButton(container: HTMLElement, flush: () => Promise<void>) {
  const bootcampButton = container.querySelector('[data-testid="sidebar-bootcamp"]') as HTMLButtonElement | null;
  if (!bootcampButton) throw new Error('sidebar-bootcamp button not found');

  await act(async () => {
    bootcampButton.click();
  });
  await flush();
}
