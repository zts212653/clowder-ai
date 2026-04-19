import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

function HookHost({ threadId }: { threadId: string }) {
  useChatHistory(threadId);
  return null;
}

describe('useChatHistory request priority', () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    useChatStore.setState({
      messages: [],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,

      threadStates: {},
      currentThreadId: 'thread-priority',
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
      queue: [],
      queuePaused: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => {
      root.unmount();
    });
    container.remove();
    apiFetchMock.mockReset();
  });

  it('starts messages and secondary hydration endpoints together on cold mount', async () => {
    let resolveMessages: ((value: Response) => void) | null = null;
    const messagesPromise = new Promise<Response>((resolve) => {
      resolveMessages = resolve;
    });

    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/messages')) {
        return messagesPromise;
      }
      if (typeof url === 'string' && url.includes('/task-progress')) {
        return Promise.resolve(new Response(JSON.stringify({ taskProgress: {} }), { status: 200 }));
      }
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(new Response(JSON.stringify({ queue: [], paused: false }), { status: 200 }));
      }
      if (typeof url === 'string' && url.includes('/api/tasks')) {
        return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-priority' }));
    });

    const urlsBeforeHistoryResolved = apiFetchMock.mock.calls.map(([url]) => String(url));
    expect(urlsBeforeHistoryResolved.filter((u) => u.includes('/api/messages'))).toHaveLength(1);
    expect(urlsBeforeHistoryResolved.some((u) => u.includes('/api/tasks'))).toBe(true);
    expect(urlsBeforeHistoryResolved.some((u) => u.includes('/task-progress'))).toBe(true);
    expect(urlsBeforeHistoryResolved.some((u) => u.includes('/queue'))).toBe(true);

    resolveMessages!(new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 }));

    await act(async () => {
      await Promise.resolve();
    });

    const urlsAfterHistoryResolved = apiFetchMock.mock.calls.map(([url]) => String(url));
    expect(urlsAfterHistoryResolved.some((u) => u.includes('/api/tasks'))).toBe(true);
    expect(urlsAfterHistoryResolved.some((u) => u.includes('/task-progress'))).toBe(true);
    expect(urlsAfterHistoryResolved.some((u) => u.includes('/queue'))).toBe(true);
  });

  it('does not wait for a fallback timer to start secondary hydration when history stalls', async () => {
    vi.useFakeTimers();
    let resolveMessages: ((value: Response) => void) | null = null;
    const messagesPromise = new Promise<Response>((resolve) => {
      resolveMessages = resolve;
    });

    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/messages')) {
        return messagesPromise;
      }
      if (typeof url === 'string' && url.includes('/task-progress')) {
        return Promise.resolve(new Response(JSON.stringify({ taskProgress: {} }), { status: 200 }));
      }
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(new Response(JSON.stringify({ queue: [], paused: false }), { status: 200 }));
      }
      if (typeof url === 'string' && url.includes('/api/tasks')) {
        return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-priority' }));
    });

    const initialUrls = apiFetchMock.mock.calls.map(([url]) => String(url));
    expect(initialUrls.filter((u) => u.includes('/api/messages'))).toHaveLength(1);
    expect(initialUrls.filter((u) => u.includes('/api/tasks'))).toHaveLength(1);
    expect(initialUrls.filter((u) => u.includes('/task-progress'))).toHaveLength(1);
    expect(initialUrls.filter((u) => u.includes('/queue'))).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    const urlsAfterDelay = apiFetchMock.mock.calls.map(([url]) => String(url));
    expect(urlsAfterDelay.filter((u) => u.includes('/api/messages'))).toHaveLength(1);
    expect(urlsAfterDelay.filter((u) => u.includes('/api/tasks'))).toHaveLength(1);
    expect(urlsAfterDelay.filter((u) => u.includes('/task-progress'))).toHaveLength(1);
    expect(urlsAfterDelay.filter((u) => u.includes('/queue'))).toHaveLength(1);

    resolveMessages!(new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 }));
    await act(async () => {
      await Promise.resolve();
    });
    vi.useRealTimers();
  });
});
