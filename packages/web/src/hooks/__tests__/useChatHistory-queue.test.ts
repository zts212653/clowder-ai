/**
 * F39 Bug 1: useChatHistory fetches queue state on mount/thread-switch
 * so that F5 refresh restores QueuePanel correctly.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueuePanel } from '@/components/QueuePanel';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

function HookProbe({ threadId }: { threadId: string }) {
  useChatHistory(threadId);
  return null;
}

function QueueHydrationPanelProbe({ threadId }: { threadId: string }) {
  useChatHistory(threadId);
  return React.createElement(QueuePanel, { threadId });
}

function HookHost({ threadId }: { threadId: string }) {
  return React.createElement(ThreadChatHistoryAdmissionProvider, null, React.createElement(HookProbe, { threadId }));
}

function QueueHydrationPanelHost({ threadId }: { threadId: string }) {
  return React.createElement(
    ThreadChatHistoryAdmissionProvider,
    null,
    React.createElement(QueueHydrationPanelProbe, { threadId }),
  );
}

describe('useChatHistory queue hydration (F39 Bug 1)', () => {
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
      currentThreadId: 'thread-q',
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
      queue: [],
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    apiFetchMock.mockReset();
  });

  it('fetches GET /api/threads/:threadId/queue on mount', async () => {
    const queueEntries = [
      {
        id: 'q1',
        threadId: 'thread-q',
        userId: 'u1',
        content: 'queued msg',
        messageId: 'm1',
        mergedMessageIds: [],
        from: { kind: 'user', userId: 'test-user' },
        targetCats: ['opus'],
        intent: 'execute',
        status: 'queued',
        createdAt: Date.now(),
      },
    ];

    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(new Response(JSON.stringify({ queue: queueEntries, paused: false }), { status: 200 }));
      }
      // Other fetches (messages, tasks, task-progress) return empty
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-q' }));
    });

    // Verify queue endpoint was called
    const queueCalls = apiFetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('/queue'));
    expect(queueCalls.length).toBeGreaterThanOrEqual(1);
    expect(queueCalls[0][0]).toContain('/api/threads/thread-q/queue');

    // Verify store was updated
    const state = useChatStore.getState();
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].id).toBe('q1');
  });

  it('clears a stale queue when server returns empty (Cloud R1 P1)', async () => {
    // Pre-populate store with stale queue data (simulates previous session)
    useChatStore.setState({
      queue: [
        {
          id: 'q-stale',
          threadId: 'thread-q',
          userId: 'u1',
          content: 'stale entry',
          messageId: null,
          mergedMessageIds: [],
          from: { kind: 'user' as const, userId: 'u1' },
          targetCats: ['opus'],
          intent: 'execute',
          status: 'queued' as const,
          createdAt: Date.now(),
        },
      ],
    });

    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(new Response(JSON.stringify({ queue: [] }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-q' }));
    });

    const state = useChatStore.getState();
    // Stale data must be cleared
    expect(state.queue).toHaveLength(0);
  });

  it('F177/F254: preserves typed child execution identity across cold history hydration', async () => {
    const turnExecution = {
      invocationId: 'child-ordinary-1',
      parentInvocationId: 'parent-1',
      executionKind: 'ordinary' as const,
    };
    const auxiliaryTurnExecutions = [
      {
        invocationId: 'child-routing-guard-1',
        parentInvocationId: 'parent-1',
        executionKind: 'routing_guard' as const,
      },
    ];
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(new Response(JSON.stringify({ queue: [], paused: false }), { status: 200 }));
      }
      if (typeof url === 'string' && url.includes('/api/messages')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              messages: [
                {
                  id: 'msg-routing-guard',
                  type: 'assistant',
                  catId: 'codex',
                  content: '',
                  extra: { turnExecution, auxiliaryTurnExecutions },
                  timestamp: 1700000000000,
                },
              ],
              hasMore: false,
              tasks: [],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-q' }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useChatStore.getState().messages[0]?.extra?.turnExecution).toEqual(turnExecution);
    expect(useChatStore.getState().messages[0]?.extra?.auxiliaryTurnExecutions).toEqual(auxiliaryTurnExecutions);
  });

  it('F108B P1-2: hydrates activeInvocations record from queue response', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ queue: [], paused: false, activeInvocations: [{ catId: 'opus', startedAt: Date.now() }] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-q' }));
    });

    const state = useChatStore.getState();
    // hasActiveInvocation boolean must be set
    expect(state.hasActiveInvocation).toBe(true);
    // activeInvocations record must contain synthetic entry for ThreadExecutionBar
    const entries = Object.entries(state.activeInvocations);
    expect(entries.length).toBe(1);
    const [key, value] = entries[0];
    expect(key).toBe('hydrated-thread-q-opus');
    expect(value).toMatchObject({ catId: 'opus', mode: 'execute' });
  });

  it('reconciles empty History when queue hydration discovers an active invocation', async () => {
    vi.useFakeTimers();
    let messageRequestCount = 0;
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/messages')) {
        messageRequestCount += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              messages:
                messageRequestCount === 1
                  ? []
                  : [
                      {
                        id: 'm-delivered-after-route-transition',
                        type: 'user',
                        content: 'first message in a new thread',
                        timestamp: 1700000000000,
                      },
                    ],
              hasMore: false,
            }),
            { status: 200 },
          ),
        );
      }
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              queue: [],
              paused: false,
              activeInvocations: [{ catId: 'opus', startedAt: Date.now() }],
            }),
            { status: 200 },
          ),
        );
      }
      if (typeof url === 'string' && url.includes('/task-progress')) {
        return Promise.resolve(new Response(JSON.stringify({ taskProgress: {} }), { status: 200 }));
      }
      if (typeof url === 'string' && url.includes('/api/tasks')) {
        return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-q' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messageRequestCount).toBe(2);
    expect(useChatStore.getState().messages).toEqual([
      expect.objectContaining({ id: 'm-delivered-after-route-transition' }),
    ]);
    vi.useRealTimers();
  });

  it('does not request catch-up when slower initial History already contains messages', async () => {
    vi.useFakeTimers();
    let messageRequestCount = 0;
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/messages')) {
        messageRequestCount += 1;
        return new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({
                    messages: [
                      {
                        id: 'm-already-hydrated',
                        type: 'user',
                        content: 'initial History is authoritative',
                        timestamp: 1700000000000,
                      },
                    ],
                    hasMore: false,
                  }),
                  { status: 200 },
                ),
              ),
            100,
          );
        });
      }
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              queue: [],
              paused: false,
              activeInvocations: [{ catId: 'opus', startedAt: Date.now() }],
            }),
            { status: 200 },
          ),
        );
      }
      if (typeof url === 'string' && url.includes('/task-progress')) {
        return Promise.resolve(new Response(JSON.stringify({ taskProgress: {} }), { status: 200 }));
      }
      if (typeof url === 'string' && url.includes('/api/tasks')) {
        return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-q' }));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messageRequestCount).toBe(1);
    expect(useChatStore.getState().messages).toEqual([expect.objectContaining({ id: 'm-already-hydrated' })]);
    vi.useRealTimers();
  });

  it('F264: hydrates parent control and child turn identities from canonical queue liveness', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              queue: [],
              paused: false,
              activeInvocations: [
                {
                  catId: 'opus',
                  startedAt: Date.now(),
                  executionId: 'parent-opus',
                  turnInvocationId: 'child-opus',
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-q' }));
    });

    const state = useChatStore.getState();
    expect(state.activeInvocations).toHaveProperty('parent-opus');
    expect(state.activeInvocations).not.toHaveProperty('child-opus');
    expect(state.catInvocations.opus).toMatchObject({
      invocationId: 'parent-opus',
      turnInvocationId: 'child-opus',
    });
  });

  it('F264: parent-only hydration clears a previous child turn identity', async () => {
    useChatStore.setState({
      catInvocations: {
        opus: {
          invocationId: 'parent-opus-old',
          turnInvocationId: 'child-opus-old',
        },
      },
    });
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              queue: [],
              paused: false,
              activeInvocations: [
                {
                  catId: 'opus',
                  startedAt: Date.now(),
                  executionId: 'parent-opus-new',
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-q' }));
    });

    const state = useChatStore.getState();
    expect(state.activeInvocations).toHaveProperty('parent-opus-new');
    expect(state.catInvocations.opus?.invocationId).toBe('parent-opus-new');
    expect(state.catInvocations.opus?.turnInvocationId).toBeUndefined();
  });

  it.each([
    true,
    false,
  ])('F5 restores canonical response and liveness without a separate wait-window notice (running=%s)', async (running) => {
    useChatStore.setState({
      messages: [
        {
          id: 'invocation-status-parent-refresh',
          type: 'system',
          content: 'old client notice',
          timestamp: 1,
          cachedFrom: 'idb',
        },
      ],
    });
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/queue'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              queue: [],
              paused: false,
              activeInvocations: running
                ? [
                    {
                      catId: 'opus',
                      startedAt: 1,
                      executionId: 'parent-refresh',
                      turnInvocationId: 'child-refresh',
                    },
                  ]
                : [],
            }),
            { status: 200 },
          ),
        );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            messages: [
              {
                id: 'response-refresh',
                threadId: 'thread-q',
                catId: 'opus',
                content: 'canonical reply',
                timestamp: 2,
                lifecycle: {
                  kind: 'response',
                  orderKey: '2:response-refresh',
                  invocationId: 'child-refresh',
                  targetId: 'opus',
                  inputEntryIds: [],
                  inputMessageIds: [],
                  status: running ? 'processing' : 'completed',
                  startedAt: 2,
                },
              },
            ],
            hasMore: false,
            tasks: [],
          }),
          { status: 200 },
        ),
      );
    });
    await act(async () => root.render(React.createElement(HookHost, { threadId: 'thread-q' })));
    const state = useChatStore.getState();
    expect(state.messages.map((message) => message.id)).toEqual(['response-refresh']);
    expect(state.messages[0]?.content).toBe('canonical reply');
    expect(Boolean(state.activeInvocations['parent-refresh'])).toBe(running);
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes('/api/invocations/'))).toBe(false);
  });

  it('F264: same-parent authoritative hydration clears the old child without projecting Queue receipts', async () => {
    useChatStore.setState({
      catInvocations: {
        opus: {
          invocationId: 'parent-opus',
          turnInvocationId: 'child-opus-old',
        },
      },
    });
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              queue: [
                {
                  id: 'q-same-parent',
                  threadId: 'thread-q',
                  userId: 'u1',
                  content: 'same parent must not certify an old child',
                  messageId: 'm-same-parent',
                  mergedMessageIds: [],
                  from: { kind: 'user', userId: 'test-user' },
                  targetCats: ['opus'],
                  intent: 'execute',
                  status: 'queued',
                  createdAt: 1700000000000,
                },
              ],
              paused: false,
              activeInvocations: [
                {
                  catId: 'opus',
                  startedAt: Date.now(),
                  executionId: 'parent-opus',
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(QueueHydrationPanelHost, { threadId: 'thread-q' }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(useChatStore.getState().catInvocations.opus).toMatchObject({
      invocationId: 'parent-opus',
      turnInvocationId: undefined,
    });
    expect(container.textContent).toContain('same parent must not certify an old child');
    expect(container.textContent).not.toContain('未投递 · 排队中');
    expect(container.textContent).not.toContain('当前轮处理中');
    expect(container.querySelector('[data-testid="queue-recover"]')).toBeNull();
  });

  it('F108B P1-2: replaces stale slots — no ghost cats in ThreadExecutionBar', async () => {
    // Pre-populate with stale codex invocation (from snapshot restore)
    useChatStore.setState({
      activeInvocations: {
        'stale-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
      },
      hasActiveInvocation: true,
    });

    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        // Server says only opus is active — codex should be gone
        return Promise.resolve(
          new Response(
            JSON.stringify({ queue: [], paused: false, activeInvocations: [{ catId: 'opus', startedAt: Date.now() }] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-q' }));
    });

    const state = useChatStore.getState();
    const entries = Object.entries(state.activeInvocations);
    // Only opus — no ghost codex
    expect(entries.length).toBe(1);
    expect(entries[0][1]).toMatchObject({ catId: 'opus' });
    // Verify codex is gone
    const catIds = entries.map(([, v]) => v.catId);
    expect(catIds).not.toContain('codex');
  });

  it('F194: preserves full ideate targetCats when queue hydration reports only active subset', async () => {
    useChatStore.setState({
      hasActiveInvocation: true,
      intentMode: 'ideate',
      targetCats: ['opus', 'opus-47', 'codex'],
      catStatuses: {
        opus: 'streaming',
        'opus-47': 'done',
        codex: 'streaming',
      },
    });

    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              queue: [],
              paused: false,
              activeInvocations: [
                { catId: 'opus', startedAt: Date.now() },
                { catId: 'codex', startedAt: Date.now() },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-q' }));
    });

    const state = useChatStore.getState();
    expect(state.targetCats).toEqual(['opus', 'opus-47', 'codex']);
    expect(Object.values(state.activeInvocations).map((slot) => slot.catId)).toEqual(['opus', 'codex']);
    expect(state.catStatuses.opus).toBe('streaming');
    expect(state.catStatuses['opus-47']).toBe('done');
    expect(state.catStatuses.codex).toBe('streaming');
  });

  it('F108B P1-2: clears activeInvocations record when server reports none', async () => {
    // Pre-populate with stale activeInvocations
    useChatStore.setState({
      activeInvocations: {
        'stale-inv': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      hasActiveInvocation: true,
    });

    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(new Response(JSON.stringify({ queue: [], paused: false }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-q' }));
    });

    const state = useChatStore.getState();
    expect(state.hasActiveInvocation).toBe(false);
    expect(Object.keys(state.activeInvocations)).toHaveLength(0);
  });
});
