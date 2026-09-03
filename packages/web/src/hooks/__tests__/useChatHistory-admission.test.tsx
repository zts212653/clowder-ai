import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { __resetTaskCacheForTest, useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const THREAD_ID = 'thread-history-admission';

function HistoryProbe({ capture }: { capture: (history: ReturnType<typeof useChatHistory>) => void }) {
  const history = useChatHistory(THREAD_ID);
  capture(history);
  return null;
}

function Harness({ children }: { children: ReactNode }) {
  return <ThreadChatHistoryAdmissionProvider>{children}</ThreadChatHistoryAdmissionProvider>;
}

describe('useChatHistory runtime admission', () => {
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
    __resetTaskCacheForTest();
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
      currentThreadId: THREAD_ID,
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
      queue: [],
      queuePaused: false,
    });
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/messages')) {
        return Promise.resolve(new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 }));
      }
      if (url.includes('/api/tasks')) {
        return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
      }
      if (url.includes('/task-progress')) {
        return Promise.resolve(new Response(JSON.stringify({ taskProgress: {} }), { status: 200 }));
      }
      if (url.includes('/queue')) {
        return Promise.resolve(new Response(JSON.stringify({ queue: [], paused: false }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
  });

  it('hydrates one thread once while keeping viewport refs local to each surface', async () => {
    let first: ReturnType<typeof useChatHistory> | undefined;
    let second: ReturnType<typeof useChatHistory> | undefined;

    await act(async () => {
      root.render(
        <Harness>
          <HistoryProbe capture={(history) => (first = history)} />
          <HistoryProbe capture={(history) => (second = history)} />
        </Harness>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const urls = apiFetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes('/api/messages'))).toHaveLength(1);
    expect(urls.filter((url) => url.includes('/api/tasks'))).toHaveLength(1);
    expect(urls.filter((url) => url.includes('/task-progress'))).toHaveLength(1);
    expect(urls.filter((url) => url.includes('/queue'))).toHaveLength(1);
    expect(first?.scrollContainerRef).not.toBe(second?.scrollContainerRef);
    expect(first?.messagesEndRef).not.toBe(second?.messagesEndRef);
  });

  it.each([
    ['messages', '/api/messages'],
    ['tasks', '/api/tasks'],
    ['task progress', '/task-progress'],
    ['queue', '/queue'],
  ])('retries when %s hydration fails and another surface joins later', async (_label, failingRoute) => {
    let failingRequestCount = 0;
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes(failingRoute)) {
        failingRequestCount += 1;
        if (failingRequestCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({ error: 'offline' }), { status: 503 }));
        }
      }
      if (url.includes('/api/messages')) {
        return Promise.resolve(new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 }));
      }
      if (url.includes('/api/tasks')) {
        return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
      }
      if (url.includes('/task-progress')) {
        return Promise.resolve(new Response(JSON.stringify({ taskProgress: {} }), { status: 200 }));
      }
      if (url.includes('/queue')) {
        return Promise.resolve(new Response(JSON.stringify({ queue: [], paused: false }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    await act(async () => {
      root.render(
        <Harness>
          <HistoryProbe key="first" capture={() => {}} />
        </Harness>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(failingRequestCount).toBe(1);

    await act(async () => {
      root.render(
        <Harness>
          <HistoryProbe key="first" capture={() => {}} />
          <HistoryProbe key="late" capture={() => {}} />
        </Harness>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(failingRequestCount).toBe(2);
  });

  it('retries shared pagination when the request origin unmounts before settlement', async () => {
    let messageRequestCount = 0;
    let resolveAbandoned: ((value: Response) => void) | undefined;
    const abandonedResponse = new Promise<Response>((resolve) => {
      resolveAbandoned = resolve;
    });
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/messages')) {
        messageRequestCount += 1;
        if (messageRequestCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                messages: [{ id: 'seed-message', type: 'user', content: 'seed', timestamp: 100 }],
                hasMore: true,
              }),
              { status: 200 },
            ),
          );
        }
        if (messageRequestCount === 2) return abandonedResponse;
        return Promise.resolve(new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 }));
      }
      if (url.includes('/api/tasks')) {
        return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
      }
      if (url.includes('/task-progress')) {
        return Promise.resolve(new Response(JSON.stringify({ taskProgress: {} }), { status: 200 }));
      }
      if (url.includes('/queue')) {
        return Promise.resolve(new Response(JSON.stringify({ queue: [], paused: false }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    let first: ReturnType<typeof useChatHistory> | undefined;
    let second: ReturnType<typeof useChatHistory> | undefined;
    await act(async () => {
      root.render(
        <Harness>
          <HistoryProbe key="first" capture={(history) => (first = history)} />
          <HistoryProbe key="second" capture={(history) => (second = history)} />
        </Harness>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(messageRequestCount).toBe(1);

    const firstViewport = document.createElement('div');
    const secondViewport = document.createElement('div');
    Object.defineProperty(firstViewport, 'scrollTop', { configurable: true, value: 0, writable: true });
    Object.defineProperty(secondViewport, 'scrollTop', { configurable: true, value: 0, writable: true });
    (first!.scrollContainerRef as { current: HTMLDivElement | null }).current = firstViewport;
    (second!.scrollContainerRef as { current: HTMLDivElement | null }).current = secondViewport;

    act(() => {
      first!.handleScroll();
      second!.handleScroll();
    });
    expect(messageRequestCount).toBe(2);

    await act(async () => {
      root.render(
        <Harness>
          <HistoryProbe key="second" capture={(history) => (second = history)} />
        </Harness>,
      );
      resolveAbandoned?.(new Response(JSON.stringify({ messages: [], hasMore: true }), { status: 200 }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messageRequestCount).toBe(3);
    expect(useChatStore.getState().hasMore).toBe(false);
  });
});
