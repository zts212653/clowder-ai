import EventEmitter from 'node:events';
import type { QueueMessageReceipt } from '@cat-cafe/shared';
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

  it.each([
    'consumed',
    'coalesced',
    'multi-target',
  ])('replaces live Queue and retains the original receipt with F5 parity: %s', async (mode) => {
    const initial = {
      ...QUEUED_SEEN_ENTRY,
      ...(mode === 'coalesced' ? { mergedMessageIds: ['sibling'] } : {}),
      ...(mode === 'multi-target'
        ? { targetCats: ['codex-sol', 'opus'], targetStates: { 'codex-sol': 'seen', opus: 'queued' } }
        : {}),
    } satisfies QueueEntry;
    const remaining: QueueEntry[] =
      mode === 'consumed'
        ? []
        : [
            {
              ...initial,
              ...(mode === 'coalesced' ? { messageId: 'sibling', mergedMessageIds: [] } : { targetCats: ['opus'] }),
              targetStates: mode === 'coalesced' ? { 'codex-sol': 'queued' } : { opus: 'queued' },
              queueReceipt: undefined,
            },
          ];
    const receipt: QueueMessageReceipt = {
      version: 1,
      entryId: initial.id,
      reminderAttempts: [],
      targets: [
        {
          catId: 'codex-sol',
          state: 'handled',
          outcome: {
            invocationId: 'turn-sol',
            disposition: 'dispatch_disposition',
            handledAt: 2100,
            evidenceRef: {
              kind: 'dispatch_disposition',
              invocationId: 'turn-sol',
              sourceMessageId: initial.messageId!,
              handoffEventId: `route:${initial.messageId}:codex-sol`,
              dispositionEventId: `dispatch-disposition:turn-sol:${initial.messageId}`,
              disposition: 'completed',
              dispositionAt: 2000,
            },
          },
        },
        ...(mode === 'multi-target' ? [{ catId: 'opus', state: 'queued' as const }] : []),
      ],
    };
    useChatStore.setState({
      messages: [
        {
          id: initial.messageId!,
          type: 'assistant',
          catId: 'codex',
          content: 'dispatch source',
          timestamp: 1200,
          extra: { queueReceipt: initial.queueReceipt },
        },
      ],
    });
    useChatStore.getState().setQueue(THREAD_ID, [initial]);
    await act(async () => root.render(<Host />));
    await act(async () => {
      emitServerEvent('queue_updated', {
        threadId: THREAD_ID,
        action: 'queued_handled',
        queue: remaining,
        messageReceipts: [{ messageId: initial.messageId, queueReceipt: receipt }],
      });
    });
    const live = useChatStore.getState().getThreadState(THREAD_ID).queue;
    expect(live).toEqual(remaining);
    expect(
      useChatStore.getState().messages.find((message) => message.id === initial.messageId)?.extra?.queueReceipt,
    ).toEqual(receipt);
    if (mode === 'consumed') expect(container.querySelector(`[data-testid="steer-${initial.id}"]`)).toBeNull();
    if (mode === 'coalesced') expect(live[0]?.messageId).toBe('sibling');
    if (mode === 'multi-target') expect(live[0]?.targetCats).toEqual(['opus']);
    apiFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ queue: remaining, paused: false, activeInvocations: [] })),
    );
    await act(async () => {
      await reconcileThreadWithServer(THREAD_ID, () => false, 'Reconnect');
    });
    expect(useChatStore.getState().getThreadState(THREAD_ID).queue).toEqual(live);
    expect(
      useChatStore.getState().messages.find((message) => message.id === initial.messageId)?.extra?.queueReceipt,
    ).toEqual(receipt);
  });
});
