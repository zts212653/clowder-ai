/**
 * Regression test: mobile sidebar auto-closes after creating a new conversation.
 * Verifies that createInProject success path calls onClose on narrow viewports.
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

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
}

describe('ThreadSidebar mobile auto-close', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalInnerWidth: number;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalInnerWidth = window.innerWidth;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    mockPush.mockReset();
    // Default: threads list returns empty
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/threads') return jsonOk({ threads: [] });
      if (path === '/api/projects/cwd') return jsonOk({ path: '/test' });
      if (path.startsWith('/api/projects/browse'))
        return jsonOk({
          current: '/test',
          name: 'test',
          parent: '/',
          entries: [],
        });
      return jsonOk({});
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, writable: true });
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

  it('calls onClose after createInProject succeeds on mobile viewport', async () => {
    // Simulate mobile viewport
    Object.defineProperty(window, 'innerWidth', { value: 375, writable: true });

    const onClose = vi.fn();
    act(() => {
      root.render(React.createElement(ThreadSidebar, { onClose }));
    });
    await flush();

    // Set up mock for thread creation
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') {
        return jsonOk({ id: 'new-thread-123' });
      }
      if (path === '/api/threads') return jsonOk({ threads: [] });
      return jsonOk({});
    });

    // Click "+ 新对话" button to open picker
    const newBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('新对话'))!;
    expect(newBtn).toBeTruthy();
    act(() => {
      newBtn.click();
    });

    // Click "大厅 (无项目)" in the picker — this selects it (F068-R7 two-step flow)
    await flush();
    const lobbyBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('大厅'))!;
    expect(lobbyBtn).toBeTruthy();
    act(() => {
      lobbyBtn.click();
    });

    // Click "创建对话" confirm button to trigger createInProject
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('创建对话'),
    )!;
    expect(confirmBtn).toBeTruthy();
    act(() => {
      confirmBtn.click();
    });
    await flush();

    expect(onClose).toHaveBeenCalled();
  });

  it('does NOT call onClose after createInProject on desktop viewport', async () => {
    // Simulate desktop viewport
    Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });

    const onClose = vi.fn();
    act(() => {
      root.render(React.createElement(ThreadSidebar, { onClose }));
    });
    await flush();

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') {
        return jsonOk({ id: 'new-thread-456' });
      }
      if (path === '/api/threads') return jsonOk({ threads: [] });
      return jsonOk({});
    });

    // Open picker
    const newBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('新对话'))!;
    act(() => {
      newBtn.click();
    });
    await flush();

    // Select lobby
    const lobbyBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('大厅'))!;
    act(() => {
      lobbyBtn.click();
    });

    // Confirm creation (F068-R7 two-step flow)
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('创建对话'),
    )!;
    act(() => {
      confirmBtn.click();
    });
    await flush();

    expect(onClose).not.toHaveBeenCalled();
  });
});
