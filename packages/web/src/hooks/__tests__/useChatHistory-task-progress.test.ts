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

describe('useChatHistory task-progress hydration', () => {
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
      currentThreadId: 'thread-progress',
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
    act(() => {
      root.unmount();
    });
    container.remove();
    apiFetchMock.mockReset();
  });

  it('does not restore completed snapshots into targetCats', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/messages')) {
        return Promise.resolve(new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 }));
      }
      if (typeof url === 'string' && url.includes('/api/tasks')) {
        return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
      }
      if (typeof url === 'string' && url.includes('/task-progress')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              taskProgress: {
                codex: {
                  tasks: [{ id: 'task-1', subject: 'Write plan', status: 'completed' }],
                  status: 'completed',
                  updatedAt: 123,
                },
              },
            }),
            { status: 200 },
          ),
        );
      }
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(new Response(JSON.stringify({ queue: [], paused: false }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-progress' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const state = useChatStore.getState();
    expect(state.catInvocations.codex?.taskProgress?.snapshotStatus).toBe('completed');
    expect(state.targetCats).toEqual([]);
  });

  it('restores running snapshots into targetCats even when all tasks are completed', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/messages')) {
        return Promise.resolve(new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 }));
      }
      if (typeof url === 'string' && url.includes('/api/tasks')) {
        return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
      }
      if (typeof url === 'string' && url.includes('/task-progress')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              taskProgress: {
                codex: {
                  tasks: [
                    { id: 'task-1', subject: 'Write plan', status: 'completed' },
                    { id: 'task-2', subject: 'Run tests', status: 'completed' },
                  ],
                  status: 'running',
                  updatedAt: 456,
                },
              },
            }),
            { status: 200 },
          ),
        );
      }
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(JSON.stringify({ queue: [], paused: false, activeInvocations: ['codex'] }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-progress' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const state = useChatStore.getState();
    expect(state.catInvocations.codex?.taskProgress?.snapshotStatus).toBe('running');
    expect(state.targetCats).toEqual(['codex']);
  });
});
