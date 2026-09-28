/**
 * Live Queue receipt/liveness projection contract:
 *
 * A `queued_seen` event can arrive after its earlier `processing` event. The
 * event's Queue row therefore has the child receipt before the browser has the
 * parent-to-child liveness bridge. The QueuePanel must reconcile that bridge
 * without a refresh; otherwise it falsely offers a recovery action for a turn
 * that is already live.
 */
import EventEmitter from 'node:events';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueuePanel } from '@/components/QueuePanel';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { reconcileThreadWithServer, type SocketCallbacks, useSocket } from '../useSocket';

const mockSocket = new EventEmitter() as EventEmitter & {
  connected: boolean;
  id: string;
  io: { engine: { transport: { name: string }; on: () => void } };
  disconnect: () => void;
  emit: (...args: unknown[]) => boolean;
};
mockSocket.connected = true;
mockSocket.id = 'queue-exact-live-socket';
mockSocket.io = { engine: { transport: { name: 'websocket' }, on: vi.fn() } };
mockSocket.disconnect = vi.fn();
mockSocket.emit = vi.fn(() => true) as unknown as typeof mockSocket.emit;

vi.mock('socket.io-client', () => ({ io: () => mockSocket }));

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3100',
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/utils/offline-store', () => ({ saveThreadActiveState: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/utils/userId', () => ({ getUserId: () => 'test-user' }));

const THREAD_ID = 'thread-queue-exact-live';

const QUEUED_SEEN_ENTRY: QueueEntry = {
  id: 'q-exact-live',
  threadId: THREAD_ID,
  userId: 'test-user',
  content: 'already read by this exact child',
  messageId: 'm-exact-live',
  mergedMessageIds: [],
  source: 'agent',
  sourceCategory: 'a2a',
  autoExecute: true,
  callerCatId: 'codex',
  targetCats: ['codex-sol'],
  targetStates: { 'codex-sol': 'seen' },
  queueReceipt: {
    version: 1,
    entryId: 'q-exact-live',
    targets: [{ catId: 'codex-sol', state: 'seen', invocationId: 'turn-sol', seenAt: 1234 }],
    reminderAttempts: [],
  },
  intent: 'execute',
  status: 'queued',
  createdAt: 1200,
};

function Host() {
  const callbacks: SocketCallbacks = { onMessage: vi.fn() };
  useSocket(callbacks, THREAD_ID);
  return <QueuePanel threadId={THREAD_ID} />;
}

function emitServerEvent(event: string, ...args: unknown[]) {
  for (const listener of mockSocket.listeners(event)) {
    (listener as (...listenerArgs: unknown[]) => void)(...args);
  }
}

describe('useSocket Queue exact-live bridge', () => {
  let container: HTMLDivElement;
  let root: Root;

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
    mockSocket.removeAllListeners();
    mockSocket.connected = true;
    vi.clearAllMocks();
    apiFetchMock.mockImplementation((url: string) => {
      if (url === `/api/threads/${THREAD_ID}/queue`) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              activeInvocations: [
                {
                  catId: 'codex-sol',
                  executionId: 'parent-sol',
                  turnInvocationId: 'turn-sol',
                  startedAt: 1200,
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    useChatStore.setState({
      messages: [],
      queue: [],
      queuePaused: false,
      queuePauseReason: undefined,
      hasActiveInvocation: false,
      isLoading: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      activeInvocations: {},
      catInvocations: {},
      currentThreadId: THREAD_ID,
      threadStates: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('queue-first: hides recovery after one queued_seen event and canonical exact-liveness reconciliation', async () => {
    await act(async () => {
      root.render(<Host />);
    });

    await act(async () => {
      emitServerEvent('queue_updated', {
        threadId: THREAD_ID,
        queue: [QUEUED_SEEN_ENTRY],
        action: 'queued_seen',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(`/api/threads/${THREAD_ID}/queue`);
    expect(useChatStore.getState().catInvocations['codex-sol']).toMatchObject({
      invocationId: 'parent-sol',
      turnInvocationId: 'turn-sol',
    });
    expect(container.querySelector('[data-testid="queue-recover"]')).toBeNull();
    expect(container.querySelector('[data-testid="steer-q-exact-live"]')).toBeNull();
  });

  it.each([
    THREAD_ID,
    'thread-queue-background',
  ])('reconciles missed completion and pause truth for %s without another execution', async (threadId) => {
    const oldQueue = [1, 2, 3].map((index) => ({
      ...QUEUED_SEEN_ENTRY,
      threadId,
      id: `old-${index}`,
    }));
    useChatStore.getState().setQueue(threadId, oldQueue);
    useChatStore.getState().setQueuePaused(threadId, true, 'failed');
    apiFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ queue: [], paused: false, activeInvocations: [] })),
    );
    await act(async () => {
      root.render(<Host />);
      await reconcileThreadWithServer(threadId, () => false, 'Reconnect');
    });

    const state = useChatStore.getState().getThreadState(threadId);
    expect(state.queue).toEqual([]);
    expect(state.queuePaused).toBe(false);
    expect(state.queuePauseReason).toBeUndefined();
    expect(container.querySelector('[data-testid="queue-recover"]')).toBeNull();
    expect(apiFetchMock.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('retains real pending work and the server pause reason', async () => {
    apiFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ queue: [QUEUED_SEEN_ENTRY], paused: true, pauseReason: 'canceled', activeInvocations: [] }),
      ),
    );
    await reconcileThreadWithServer(THREAD_ID, () => false, 'StaleWatchdog');
    expect(useChatStore.getState().queue).toEqual([QUEUED_SEEN_ENTRY]);
    expect(useChatStore.getState().queuePaused).toBe(true);
    expect(useChatStore.getState().queuePauseReason).toBe('canceled');
  });

  it.each([
    'queued',
    'queued_handled',
    'queue_paused',
    'queue_full_warning',
  ])('a delayed reconciliation cannot replace newer %s truth', async (action) => {
    await act(async () => root.render(<Host />));
    let resolveResponse!: (response: Response) => void;
    apiFetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const pending = reconcileThreadWithServer(THREAD_ID, () => false, 'Reconnect');
    const liveQueue = action === 'queued_handled' ? [] : [QUEUED_SEEN_ENTRY];
    await act(async () => {
      emitServerEvent(action.startsWith('queue_') ? action : 'queue_updated', {
        threadId: THREAD_ID,
        queue: liveQueue,
        action,
        reason: 'failed',
        source: 'connector',
      });
      resolveResponse(
        new Response(
          JSON.stringify({
            queue: [{ ...QUEUED_SEEN_ENTRY, id: 'stale-response' }],
            paused: false,
            activeInvocations: [{ catId: 'codex', executionId: 'old-parent', turnInvocationId: 'old-child' }],
          }),
        ),
      );
      await pending;
    });
    expect(useChatStore.getState().queue).toEqual(liveQueue);
    expect(useChatStore.getState().activeInvocations).not.toHaveProperty('old-parent');
    if (action === 'queue_paused') expect(useChatStore.getState().queuePaused).toBe(true);
  });

  it('the latest reconciliation wins even when an older request finishes last', async () => {
    let resolveOld!: (response: Response) => void;
    apiFetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveOld = resolve;
      }),
    );
    const oldRead = reconcileThreadWithServer(THREAD_ID, () => false, 'Reconnect');
    apiFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          queue: [],
          paused: false,
          activeInvocations: [{ catId: 'codex-sol', executionId: 'new-parent', turnInvocationId: 'new-child' }],
        }),
      ),
    );
    await reconcileThreadWithServer(THREAD_ID, () => false, 'QueueProcessing');
    resolveOld(new Response(JSON.stringify({ queue: [QUEUED_SEEN_ENTRY], paused: true, activeInvocations: [] })));
    await oldRead;
    expect(useChatStore.getState().queue).toEqual([]);
    expect(useChatStore.getState().queuePaused).toBe(false);
    expect(useChatStore.getState().activeInvocations).toHaveProperty('new-parent');
  });

  it.each([
    THREAD_ID,
    'thread-idle-background',
  ])('automatically checks an ended receipt in idle %s without reconnect or a user message', async (threadId) => {
    vi.useFakeTimers();
    useChatStore.getState().setQueue(threadId, [{ ...QUEUED_SEEN_ENTRY, threadId }]);
    useChatStore.getState().setQueuePaused(threadId, true, 'failed');
    apiFetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            queue: [],
            paused: false,
            activeInvocations: [],
          }),
        ),
    );
    await act(async () => root.render(<Host />));
    await act(async () => vi.advanceTimersByTimeAsync(31_000));
    expect(apiFetchMock).toHaveBeenCalledWith(`/api/threads/${threadId}/queue`);
    expect(useChatStore.getState().getThreadState(threadId).queue).toEqual([]);
    expect(useChatStore.getState().getThreadState(threadId).queuePaused).toBe(false);
    expect(container.querySelector('[data-testid="queue-recover"]')).toBeNull();
  });
});
