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
  refreshApiSession: vi.fn(async () => {}),
  API_URL: 'http://localhost:3100',
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/utils/offline-store', () => ({ saveThreadActiveState: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/utils/userId', () => ({ getUserId: () => 'test-user' }));

const THREAD_ID = 'thread-queue-exact-live';
let serverQueue: QueueEntry[];

const QUEUED_SEEN_ENTRY: QueueEntry = {
  id: 'q-exact-live',
  threadId: THREAD_ID,
  userId: 'test-user',
  content: 'already read by this exact child',
  messageId: 'm-exact-live',
  mergedMessageIds: [],
  from: { kind: 'agent', catId: 'codex' },
  sourceCategory: 'a2a',
  autoExecute: true,
  targetCats: ['codex-sol'],
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

describe('dispatch receipt Queue publication', () => {
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
              queue: serverQueue,
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

  it.each([
    'consumed',
    'sibling',
    'multi-target',
  ])('Queue updates replace pending work while lifecycle events alone publish read facts: %s', async (mode) => {
    const initial: QueueEntry = {
      ...QUEUED_SEEN_ENTRY,
      ...(mode === 'multi-target' ? { targetCats: ['codex-sol', 'opus'] } : {}),
    };
    const remaining: QueueEntry[] =
      mode === 'consumed'
        ? []
        : [
            {
              ...initial,
              ...(mode === 'sibling' ? { messageId: 'sibling' } : { targetCats: ['opus'] }),
            },
          ];
    const source = {
      id: initial.messageId!,
      from: initial.from,
      catId: 'codex',
      content: 'dispatch source',
      timestamp: 1200,
      lifecycle: { kind: 'input', orderKey: '1200:source' },
    };
    serverQueue = [initial];
    useChatStore.getState().setQueue(THREAD_ID, [initial]);
    await act(async () => root.render(<Host />));
    act(() => emitServerEvent('message_lifecycle_updated', { threadId: THREAD_ID, message: source }));
    serverQueue = remaining;
    await act(async () =>
      emitServerEvent('queue_updated', {
        threadId: THREAD_ID,
        action: 'queued_handled',
        queue: remaining,
        // A stale peer's Queue receipt must not become a second History owner.
        messageReceipts: [
          { messageId: source.id, queueReceipt: { version: 1, targets: [{ catId: 'opus', state: 'handled' }] } },
        ],
      }),
    );
    expect(useChatStore.getState().getThreadState(THREAD_ID).queue).toEqual(remaining);
    expect(useChatStore.getState().messages.find((message) => message.id === source.id)?.lifecycle).toEqual(
      source.lifecycle,
    );
    expect(useChatStore.getState().messages[0]?.extra ?? {}).not.toHaveProperty('queueReceipt');
    const settledSource = {
      ...source,
      lifecycle: {
        ...source.lifecycle,
        dispatchRefs: [
          { targetId: 'codex-sol', phase: 'settled', statusMessageId: 'response-sol', dispatchedAt: 2000 },
        ],
      },
    };
    act(() => {
      emitServerEvent('message_lifecycle_updated', { threadId: THREAD_ID, message: settledSource });
      emitServerEvent('message_lifecycle_updated', {
        threadId: THREAD_ID,
        message: {
          id: 'response-sol',
          from: { kind: 'agent', catId: 'codex-sol' },
          catId: 'codex-sol',
          content: 'handled',
          timestamp: 2100,
          lifecycle: {
            kind: 'response',
            orderKey: '2000:response',
            invocationId: 'child-sol',
            targetId: 'codex-sol',
            inputEntryIds: [initial.id],
            inputMessageIds: [source.id],
            status: 'completed',
            startedAt: 2000,
            completedAt: 2100,
          },
        },
      });
    });
    const live = useChatStore.getState().getThreadState(THREAD_ID).queue;
    if (mode === 'consumed') expect(container.querySelector(`[data-testid="steer-${initial.id}"]`)).toBeNull();
    if (mode === 'sibling') {
      expect(live[0]?.messageId).toBe('sibling');
      expect(container.textContent).not.toContain('（已读）');
    }
    if (mode === 'multi-target') {
      expect(live[0]?.targetCats).toEqual(['opus']);
      expect(container.textContent).toContain('（已投递）');
    }
    apiFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ queue: remaining, paused: false, activeInvocations: [] })),
    );
    await act(async () => {
      await reconcileThreadWithServer(THREAD_ID, () => false, 'Reconnect');
    });
    expect(useChatStore.getState().getThreadState(THREAD_ID).queue).toEqual(live);
    expect(useChatStore.getState().messages.find((message) => message.id === source.id)?.lifecycle).toEqual(
      settledSource.lifecycle,
    );
    expect(
      useChatStore.getState().messages.find((message) => message.id === source.id)?.extra ?? {},
    ).not.toHaveProperty('queueReceipt');
  });
});
