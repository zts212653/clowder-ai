import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectThreadMessages } from '@/hooks/useThreadScopedSelectors';
import type { ChatMessage } from '@/stores/chat-types';
import { DEFAULT_THREAD_STATE, useChatStore } from '@/stores/chatStore';
import { isMessageTimelineOrdered } from '@/stores/message-timeline';

const ACTIVE_THREAD = 'thread-active';
const BACKGROUND_THREAD = 'thread-background';

function message(id: string, timestamp: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, type: 'user', content: id, timestamp, ...overrides };
}

/**
 * Runtime messages are intentionally tolerant of lifecycle extensions. Model a
 * future non-response kind with completedAt so streaming-flag writers stay in
 * the order-changing writer inventory if the shared union later admits it.
 */
function extensibleLifecycleMessage(id: string): ChatMessage {
  return {
    id,
    type: 'assistant',
    catId: 'sol',
    content: id,
    timestamp: 1_000,
    timelineOrderAt: 1_000,
    isStreaming: true,
    lifecycle: { kind: 'notification', status: 'processing', completedAt: 3_000 },
  } as unknown as ChatMessage;
}

function reset(messages: ChatMessage[] = [], backgroundMessages: ChatMessage[] = []): void {
  useChatStore.setState({
    currentThreadId: ACTIVE_THREAD,
    messages,
    threadStates: {
      [BACKGROUND_THREAD]: { ...DEFAULT_THREAD_STATE, messages: backgroundMessages },
    },
  });
}

function expectPresentationOrder(threadId: string, expectedIds: string[]): void {
  const ordered = selectThreadMessages(useChatStore.getState(), threadId);
  expect(isMessageTimelineOrdered(ordered)).toBe(true);
  expect(ordered.map((candidate) => candidate.id)).toEqual(expectedIds);
}

interface WriterCase {
  name: string;
  threadId?: string;
  arrange: () => void;
  write: () => void;
  expectedIds: string[];
}

const collectionAndInsertWriters: WriterCase[] = [
  {
    name: 'prependHistory',
    arrange: () => reset([message('middle', 2_000)]),
    write: () => useChatStore.getState().prependHistory([message('late', 3_000), message('early', 1_000)], false),
    expectedIds: ['early', 'middle', 'late'],
  },
  {
    name: 'replaceMessages',
    arrange: () => reset(),
    write: () => useChatStore.getState().replaceMessages([message('late', 3_000), message('early', 1_000)], false),
    expectedIds: ['early', 'late'],
  },
  {
    name: 'replaceThreadMessages(active)',
    arrange: () => reset(),
    write: () =>
      useChatStore
        .getState()
        .replaceThreadMessages(ACTIVE_THREAD, [message('late', 3_000), message('early', 1_000)], false),
    expectedIds: ['early', 'late'],
  },
  {
    name: 'replaceThreadMessages(background)',
    threadId: BACKGROUND_THREAD,
    arrange: () => reset(),
    write: () =>
      useChatStore
        .getState()
        .replaceThreadMessages(BACKGROUND_THREAD, [message('late', 3_000), message('early', 1_000)], false),
    expectedIds: ['early', 'late'],
  },
  {
    name: 'hydrateThread(active)',
    arrange: () => reset(),
    write: () =>
      useChatStore.getState().hydrateThread(ACTIVE_THREAD, [message('late', 3_000), message('early', 1_000)], false),
    expectedIds: ['early', 'late'],
  },
  {
    name: 'hydrateThread(background)',
    threadId: BACKGROUND_THREAD,
    arrange: () => reset(),
    write: () =>
      useChatStore
        .getState()
        .hydrateThread(BACKGROUND_THREAD, [message('late', 3_000), message('early', 1_000)], false),
    expectedIds: ['early', 'late'],
  },
  {
    name: 'addMessage',
    arrange: () => reset([message('late', 3_000)]),
    write: () => useChatStore.getState().addMessage(message('early', 1_000)),
    expectedIds: ['early', 'late'],
  },
  {
    name: 'addMessageToThread(active)',
    arrange: () => reset([message('late', 3_000)]),
    write: () => useChatStore.getState().addMessageToThread(ACTIVE_THREAD, message('early', 1_000)),
    expectedIds: ['early', 'late'],
  },
  {
    name: 'addMessageToThread(background)',
    threadId: BACKGROUND_THREAD,
    arrange: () => reset([], [message('late', 3_000)]),
    write: () => useChatStore.getState().addMessageToThread(BACKGROUND_THREAD, message('early', 1_000)),
    expectedIds: ['early', 'late'],
  },
  {
    name: 'upsertLifecycleMessage(active)',
    arrange: () => reset([message('late', 3_000)]),
    write: () => useChatStore.getState().upsertLifecycleMessage(ACTIVE_THREAD, message('early', 1_000)),
    expectedIds: ['early', 'late'],
  },
  {
    name: 'upsertLifecycleMessage(background)',
    threadId: BACKGROUND_THREAD,
    arrange: () => reset([], [message('late', 3_000)]),
    write: () => useChatStore.getState().upsertLifecycleMessage(BACKGROUND_THREAD, message('early', 1_000)),
    expectedIds: ['early', 'late'],
  },
];

const clockAndTieBreakWriters: WriterCase[] = [
  {
    name: 'patchMessage',
    arrange: () => reset([message('moving', 4_000), message('middle', 2_000)]),
    write: () => useChatStore.getState().patchMessage('moving', { timelineOrderAt: 1_000 }),
    expectedIds: ['moving', 'middle'],
  },
  {
    name: 'patchThreadMessage(active)',
    arrange: () => reset([message('moving', 4_000), message('middle', 2_000)]),
    write: () => useChatStore.getState().patchThreadMessage(ACTIVE_THREAD, 'moving', { timelineOrderAt: 1_000 }),
    expectedIds: ['moving', 'middle'],
  },
  {
    name: 'patchThreadMessage(background)',
    threadId: BACKGROUND_THREAD,
    arrange: () => reset([], [message('moving', 4_000), message('middle', 2_000)]),
    write: () => useChatStore.getState().patchThreadMessage(BACKGROUND_THREAD, 'moving', { timelineOrderAt: 1_000 }),
    expectedIds: ['moving', 'middle'],
  },
  {
    name: 'replaceMessageId',
    arrange: () => reset([message('z', 1_000), message('b', 1_000)]),
    write: () => useChatStore.getState().replaceMessageId('z', 'a'),
    expectedIds: ['a', 'b'],
  },
  {
    name: 'replaceThreadMessageId(active)',
    arrange: () => reset([message('z', 1_000), message('b', 1_000)]),
    write: () => useChatStore.getState().replaceThreadMessageId(ACTIVE_THREAD, 'z', 'a'),
    expectedIds: ['a', 'b'],
  },
  {
    name: 'replaceThreadMessageId(background)',
    threadId: BACKGROUND_THREAD,
    arrange: () => reset([], [message('z', 1_000), message('b', 1_000)]),
    write: () => useChatStore.getState().replaceThreadMessageId(BACKGROUND_THREAD, 'z', 'a'),
    expectedIds: ['a', 'b'],
  },
  {
    name: 'batchStreamChunkUpdate(active)',
    arrange: () =>
      reset([
        message('streaming', 1_000, { type: 'assistant', catId: 'sol', isStreaming: true }),
        message('middle', 2_000),
      ]),
    write: () =>
      useChatStore.getState().batchStreamChunkUpdate({
        threadId: ACTIVE_THREAD,
        messageId: 'streaming',
        catId: 'sol',
        content: ' chunk',
        streaming: true,
        catStatus: 'streaming',
      }),
    expectedIds: ['middle', 'streaming'],
  },
  {
    name: 'batchStreamChunkUpdate(background)',
    threadId: BACKGROUND_THREAD,
    arrange: () =>
      reset(
        [],
        [message('streaming', 1_000, { type: 'assistant', catId: 'sol', isStreaming: true }), message('middle', 2_000)],
      ),
    write: () =>
      useChatStore.getState().batchStreamChunkUpdate({
        threadId: BACKGROUND_THREAD,
        messageId: 'streaming',
        catId: 'sol',
        content: ' chunk',
        streaming: true,
        catStatus: 'streaming',
      }),
    expectedIds: ['middle', 'streaming'],
  },
  {
    name: 'setStreaming',
    arrange: () => reset([extensibleLifecycleMessage('streaming'), message('middle', 2_000)]),
    write: () => useChatStore.getState().setStreaming('streaming', false),
    expectedIds: ['middle', 'streaming'],
  },
  {
    name: 'setThreadMessageStreaming(background)',
    threadId: BACKGROUND_THREAD,
    arrange: () => reset([], [extensibleLifecycleMessage('streaming'), message('middle', 2_000)]),
    write: () => useChatStore.getState().setThreadMessageStreaming(BACKGROUND_THREAD, 'streaming', false),
    expectedIds: ['middle', 'streaming'],
  },
  {
    name: 'markMessagesDelivered(active)',
    arrange: () => reset([message('delivered', 1_000), message('middle', 2_000)]),
    write: () =>
      useChatStore
        .getState()
        .markMessagesDelivered(ACTIVE_THREAD, ['delivered'], 3_000, [
          { id: 'delivered', catId: null, content: 'delivered', timestamp: 3_000, timelineOrderAt: 3_000 },
        ]),
    expectedIds: ['middle', 'delivered'],
  },
  {
    name: 'markMessagesDelivered(background)',
    threadId: BACKGROUND_THREAD,
    arrange: () => reset([], [message('delivered', 1_000), message('middle', 2_000)]),
    write: () =>
      useChatStore
        .getState()
        .markMessagesDelivered(BACKGROUND_THREAD, ['delivered'], 3_000, [
          { id: 'delivered', catId: null, content: 'delivered', timestamp: 3_000, timelineOrderAt: 3_000 },
        ]),
    expectedIds: ['middle', 'delivered'],
  },
];

describe('chatStore presentation-order invariant coverage', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(4_000);
    reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([...collectionAndInsertWriters, ...clockAndTieBreakWriters])('$name exposes one ordered presentation view', ({
    threadId = ACTIVE_THREAD,
    arrange,
    write,
    expectedIds,
  }) => {
    arrange();
    write();
    expectPresentationOrder(threadId, expectedIds);
  });
});
