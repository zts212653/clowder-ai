// @vitest-environment jsdom
/**
 * A send that the server commits after the browser gave up leaves a "please
 * retry" notice with no response to settle it. The notice must fold away on the
 * live proof of admission — the Queue entry or the delivery — because no HTTP
 * response will ever arrive for that attempt.
 */
import EventEmitter from 'node:events';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import type { QueueEntry } from '@/stores/chat-types';
import { sendErrorNoticeId } from '../send-error-notice';
import { useSocket, type SocketCallbacks } from '../useSocket';

const mockSocket = new EventEmitter() as EventEmitter & {
  connected: boolean;
  id: string;
  io: { engine: { transport: { name: string }; on: () => void } };
  disconnect: () => void;
  emit: (...args: unknown[]) => boolean;
};
mockSocket.connected = true;
mockSocket.id = 'late-commit-socket';
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

const THREAD_ID = 'thread-late-commit';
const ATTEMPT = 'attempt-late-commit';
const OTHER_ATTEMPT = 'attempt-still-failed';
/** Server truth the event's own /queue reconciliation reads back. */
let serverQueue: QueueEntry[];

function Host() {
  const callbacks: SocketCallbacks = { onMessage: vi.fn() };
  useSocket(callbacks, THREAD_ID);
  return null;
}

function emitServerEvent(event: string, ...args: unknown[]) {
  for (const listener of mockSocket.listeners(event)) {
    (listener as (...listenerArgs: unknown[]) => void)(...args);
  }
}

function queueEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: 'queue:late-commit',
    threadId: THREAD_ID,
    userId: 'test-user',
    content: 'hello',
    messageId: 'message-late-commit',
    mergedMessageIds: [],
    from: { kind: 'user', userId: 'test-user' },
    targetCats: ['codex'],
    intent: 'execute',
    status: 'queued',
    createdAt: 1000,
    ...overrides,
  };
}

function publishNotice(attemptId: string) {
  useChatStore.getState().addMessageToThread(THREAD_ID, {
    id: sendErrorNoticeId(attemptId),
    type: 'system',
    variant: 'error',
    content: 'Failed to send message: 网络请求超时，请重试。',
    timestamp: 1,
  });
}

function noticeIds(): string[] {
  return useChatStore
    .getState()
    .getThreadState(THREAD_ID)
    .messages.filter((row) => row.variant === 'error')
    .map((row) => row.id);
}

describe('a late-committed send settles its notice from the live projection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockSocket.removeAllListeners();
    mockSocket.connected = true;
    vi.clearAllMocks();
    apiFetchMock.mockImplementation((url: string) =>
      url === `/api/threads/${THREAD_ID}/queue`
        ? Promise.resolve(new Response(JSON.stringify({ queue: serverQueue, activeInvocations: [] }), { status: 200 }))
        : Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    serverQueue = [];
    useChatStore.setState({
      currentThreadId: THREAD_ID,
      messages: [],
      queue: [],
      queueFull: false,
      queueFullSource: undefined,
      hasActiveInvocation: false,
      isLoading: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      activeInvocations: {},
      catInvocations: {},
      deletedMessageIds: {},
      threadStates: {},
    });
    await act(async () => root.render(<Host />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('folds the notice when the Queue admits the same attempt after the client gave up', async () => {
    publishNotice(ATTEMPT);
    expect(noticeIds()).toEqual([sendErrorNoticeId(ATTEMPT)]);
    const admitted = queueEntry({ clientMessageId: ATTEMPT });
    serverQueue = [admitted];

    await act(async () => {
      emitServerEvent('queue_updated', {
        threadId: THREAD_ID,
        action: 'enqueued',
        queue: [admitted],
      });
    });

    expect(noticeIds()).toEqual([]);
    // The late commit's own row still reaches the conversation.
    expect(useChatStore.getState().getThreadState(THREAD_ID).queue).toHaveLength(1);
  });

  it('folds the notice when delivery proves admission, even with no Queue event seen', async () => {
    publishNotice(ATTEMPT);

    await act(async () => {
      emitServerEvent('messages_delivered', {
        threadId: THREAD_ID,
        messageIds: ['message-late-commit'],
        deliveredAt: 2000,
        messages: [
          {
            id: 'message-late-commit',
            from: { kind: 'user', userId: 'test-user' },
            content: 'hello',
            catId: null,
            timestamp: 1000,
            mentions: [],
            userId: 'test-user',
            clientMessageId: ATTEMPT,
          },
        ],
      });
    });

    expect(noticeIds()).toEqual([]);
    expect(
      useChatStore.getState().getThreadState(THREAD_ID).messages.some((row) => row.id === 'message-late-commit'),
    ).toBe(true);
  });

  it('keeps another attempt’s failure notice, so a real failure still shows', async () => {
    publishNotice(ATTEMPT);
    publishNotice(OTHER_ATTEMPT);

    await act(async () => {
      emitServerEvent('queue_updated', {
        threadId: THREAD_ID,
        action: 'enqueued',
        queue: [queueEntry({ clientMessageId: ATTEMPT })],
      });
    });

    expect(noticeIds()).toEqual([sendErrorNoticeId(OTHER_ATTEMPT)]);
  });

  it('leaves the notice alone while the Queue entry carries no attempt key', async () => {
    publishNotice(ATTEMPT);

    await act(async () => {
      emitServerEvent('queue_updated', {
        threadId: THREAD_ID,
        action: 'enqueued',
        queue: [queueEntry()],
      });
    });

    expect(noticeIds()).toEqual([sendErrorNoticeId(ATTEMPT)]);
  });
});