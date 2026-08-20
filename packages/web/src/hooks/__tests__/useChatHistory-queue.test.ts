/**
 * F39 Bug 1: useChatHistory fetches queue state on mount/thread-switch
 * so that F5 refresh restores QueuePanel correctly.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueuePanel } from '@/components/QueuePanel';
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

function QueueHydrationPanelHost({ threadId }: { threadId: string }) {
  useChatHistory(threadId);
  return React.createElement(QueuePanel, { threadId });
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

  it('fetches GET /api/threads/:threadId/queue on mount', async () => {
    const queueEntries = [
      {
        id: 'q1',
        threadId: 'thread-q',
        userId: 'u1',
        content: 'queued msg',
        messageId: 'm1',
        mergedMessageIds: [],
        source: 'user',
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

  it('sets queuePaused when API reports paused=true', async () => {
    const queueEntries = [
      {
        id: 'q2',
        threadId: 'thread-q',
        userId: 'u1',
        content: 'paused msg',
        messageId: null,
        mergedMessageIds: [],
        source: 'user',
        targetCats: ['opus'],
        intent: 'execute',
        status: 'queued',
        createdAt: Date.now(),
      },
    ];

    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(JSON.stringify({ queue: queueEntries, paused: true, pauseReason: 'failed' }), { status: 200 }),
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
    expect(state.queue).toHaveLength(1);
    expect(state.queuePaused).toBe(true);
    expect(state.queuePauseReason).toBe('failed');
  });

  it('clears stale queue+paused when server returns empty (Cloud R1 P1)', async () => {
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
          source: 'user' as const,
          targetCats: ['opus'],
          intent: 'execute',
          status: 'queued' as const,
          createdAt: Date.now(),
        },
      ],
      queuePaused: true,
      queuePauseReason: 'failed',
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
    // Stale data must be cleared
    expect(state.queue).toHaveLength(0);
    expect(state.queuePaused).toBe(false);
  });

  it('F264: preserves a terminal per-target receipt from cold history after the active queue is gone', async () => {
    const queueReceipt = {
      version: 1 as const,
      entryId: 'receipt-terminal-1',
      targets: [
        {
          catId: 'gemini',
          state: 'handled' as const,
          outcome: {
            invocationId: 'inv-responded',
            disposition: 'responded' as const,
            evidenceRef: { kind: 'invocation_lineage' as const, invocationId: 'inv-responded' },
            handledAt: 1700000000100,
          },
        },
        { catId: 'codex', state: 'failed' as const },
      ],
      reminderAttempts: [
        {
          id: 'reminder-missed-1',
          targetCatId: 'codex',
          invocationId: 'inv-failed',
          state: 'missed' as const,
          requestedAt: 1700000000010,
          deliveredAt: 1700000000020,
          missedAt: 1700000000030,
          missedReason: 'delivered_not_read' as const,
        },
      ],
    };

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
                  id: 'msg-terminal-receipt',
                  type: 'user',
                  catId: null,
                  content: '本轮结束后回执仍应留在原消息上。',
                  extra: { queueReceipt },
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

    expect(useChatStore.getState().messages[0]?.extra?.queueReceipt).toEqual(queueReceipt);
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

  it('resumes an unresolved timeout reconciliation after F5 hydration and updates the same notice', async () => {
    useChatStore.setState({
      messages: [
        {
          id: 'invocation-status-parent-refresh',
          type: 'system',
          variant: 'info',
          content: 'Client wait window ended. Canonical status could not be verified.',
          timestamp: Date.now() - 60_000,
          cachedFrom: 'idb',
          extra: {
            invocationReconciliation: {
              v: 1,
              invocationId: 'parent-refresh',
              catIds: ['opus'],
              turnInvocationIds: ['child-refresh'],
              phase: 'unknown_running',
              reason: 'record_unavailable',
              updatedAt: Date.now() - 60_000,
            },
          },
        },
      ],
    });
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/invocations/parent-refresh') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'parent-refresh',
              threadId: 'thread-q',
              status: 'succeeded',
              updatedAt: Date.now(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              queue: [],
              paused: false,
              activeInvocations: [
                {
                  catId: 'opus',
                  startedAt: Date.now() - 6 * 60 * 1000,
                  executionId: 'parent-refresh',
                  turnInvocationId: 'child-refresh',
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
    await vi.waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/invocations/parent-refresh');
    });

    const state = useChatStore.getState();
    const notice = state.messages.find((message) => message.id === 'invocation-status-parent-refresh');
    expect(notice?.extra?.invocationReconciliation?.phase).toBe('succeeded');
    expect(notice?.content).toContain('completed');
    expect(state.activeInvocations).not.toHaveProperty('parent-refresh');
    expect(state.catInvocations.opus?.invocationId).toBeUndefined();
    expect(state.catInvocations.opus?.turnInvocationId).toBeUndefined();
  });

  it('terminalizes an unresolved F5 receipt even when queue hydration is already empty', async () => {
    useChatStore.setState({
      messages: [
        {
          id: 'invocation-status-parent-empty-queue',
          type: 'system',
          variant: 'info',
          content: 'Client wait window ended. Canonical status could not be verified.',
          timestamp: Date.now() - 60_000,
          cachedFrom: 'idb',
          extra: {
            invocationReconciliation: {
              v: 1,
              invocationId: 'parent-empty-queue',
              catIds: ['opus'],
              turnInvocationIds: ['child-empty-queue'],
              phase: 'unknown_running',
              reason: 'record_unavailable',
              updatedAt: Date.now() - 60_000,
            },
          },
        },
      ],
      activeInvocations: {},
      hasActiveInvocation: false,
      catInvocations: {},
    });
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/invocations/parent-empty-queue') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'parent-empty-queue',
              threadId: 'thread-q',
              status: 'succeeded',
              updatedAt: Date.now(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(JSON.stringify({ queue: [], paused: false, activeInvocations: [] }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-q' }));
    });
    await vi.waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/invocations/parent-empty-queue');
    });

    const state = useChatStore.getState();
    const notices = state.messages.filter((message) => message.id === 'invocation-status-parent-empty-queue');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.extra?.invocationReconciliation?.phase).toBe('succeeded');
    expect(notices[0]?.content).toContain('completed');
    expect(state.activeInvocations).toEqual({});
    expect(state.hasActiveInvocation).toBe(false);
    expect(state.catInvocations).toEqual({});
    expect(apiFetchMock.mock.calls.filter(([url]) => url === '/api/invocations/parent-empty-queue')).toHaveLength(1);
  });

  it('F264: same-parent authoritative hydration clears the old child and exposes its receipt as unsettled', async () => {
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
                  source: 'user',
                  targetCats: ['opus'],
                  targetStates: { opus: 'seen' },
                  queueReceipt: {
                    version: 1,
                    entryId: 'q-same-parent',
                    targets: [
                      {
                        catId: 'opus',
                        state: 'seen',
                        invocationId: 'child-opus-old',
                        seenAt: 1700000000000,
                      },
                    ],
                    reminderAttempts: [],
                  },
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
    expect(container.textContent).toContain('已读，但关联回合已结束；尚未确认处理完成');
    expect(container.textContent).not.toContain('当前轮处理中');
    expect(container.querySelector('[data-testid="queue-recover"]')).not.toBeNull();
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
