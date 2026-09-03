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
import { type SocketCallbacks, useSocket } from '../useSocket';

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
      activeInvocations: {},
      catInvocations: {},
      currentThreadId: THREAD_ID,
      threadStates: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
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
});
