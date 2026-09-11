import { beforeEach, describe, expect, it } from 'vitest';
import type { QueueEntry } from '../chat-types';
import { DEFAULT_THREAD_STATE, useChatStore } from '../chatStore';

function makeEntry(id: string, status: 'queued' | 'processing' = 'queued'): QueueEntry {
  return {
    id,
    threadId: 'thread-1',
    userId: 'user-1',
    content: `msg-${id}`,
    messageId: null,
    mergedMessageIds: [],
    from: { kind: 'user', userId: 'test-user' },
    targetCats: ['opus'],
    intent: 'execute',
    status,
    createdAt: Date.now(),
  };
}

describe('chatStore queue state', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentThreadId: 'thread-1',
      messages: [],
      queue: [],
      queueFull: false,
      queueFullSource: undefined,
      threadStates: {},
    });
  });

  it('setQueue updates queue entries', () => {
    const entries = [makeEntry('a'), makeEntry('b')];
    useChatStore.getState().setQueue('thread-1', entries);
    expect(useChatStore.getState().queue).toEqual(entries);
  });

  it('keeps pending Queue truth out of History messages', () => {
    useChatStore.setState({
      messages: [
        { id: 'msg-primary', type: 'user', content: 'one', timestamp: 1 },
        { id: 'msg-merged', type: 'user', content: 'two', timestamp: 2 },
      ],
    });
    const entry = {
      ...makeEntry('receipt'),
      messageId: 'msg-primary',
      mergedMessageIds: ['msg-merged'],
    };
    const before = useChatStore.getState().messages;

    useChatStore.getState().setQueue('thread-1', [entry]);

    expect(useChatStore.getState().messages).toBe(before);
  });

  it('does not mutate active History when an actionable Queue row disappears', () => {
    useChatStore.setState({
      messages: [
        { id: 'msg-withdrawn', type: 'user', content: 'stop this work', timestamp: 1 },
        { id: 'msg-unrelated', type: 'user', content: 'leave me alone', timestamp: 2 },
      ],
    });

    const before = useChatStore.getState().messages;
    useChatStore.getState().setQueue('thread-1', []);

    expect(useChatStore.getState().queue).toEqual([]);
    expect(useChatStore.getState().messages).toBe(before);
  });

  it('updates a background Queue without rewriting its History snapshot', () => {
    useChatStore.setState({
      messages: [{ id: 'active-message', type: 'user', content: 'active', timestamp: 1 }],
      threadStates: {
        'thread-2': {
          ...DEFAULT_THREAD_STATE,
          messages: [
            {
              id: 'msg-background',
              type: 'user',
              content: 'background',
              timestamp: 2,
            },
          ],
          queue: [makeEntry('background-receipt')],
        },
      },
    });

    const before = useChatStore.getState().threadStates['thread-2']?.messages;
    useChatStore.getState().setQueue('thread-2', []);

    expect(useChatStore.getState().messages[0]?.id).toBe('active-message');
    expect(useChatStore.getState().threadStates['thread-2']?.queue).toEqual([]);
    expect(useChatStore.getState().threadStates['thread-2']?.messages).toBe(before);
  });

  it('setQueueFull sets full state', () => {
    useChatStore.getState().setQueueFull('thread-1', 'user');
    const s = useChatStore.getState();
    expect(s.queueFull).toBe(true);
    expect(s.queueFullSource).toBe('user');
  });

  it('setQueue clears queueFull when queue shrinks below threshold', () => {
    // Fill queue and mark full
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry(`e${i}`));
    useChatStore.getState().setQueue('thread-1', entries);
    useChatStore.getState().setQueueFull('thread-1', 'user');
    expect(useChatStore.getState().queueFull).toBe(true);

    // Remove some entries (shrink below 5)
    useChatStore.getState().setQueue('thread-1', entries.slice(0, 3));
    expect(useChatStore.getState().queueFull).toBe(false);
  });

  // Background thread variant
  it('setQueue on background thread updates threadStates', () => {
    const entries = [makeEntry('a')];
    useChatStore.getState().setQueue('thread-2', entries);
    expect(useChatStore.getState().threadStates['thread-2']?.queue).toEqual(entries);
  });
});
