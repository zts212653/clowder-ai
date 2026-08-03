import { beforeEach, describe, expect, it } from 'vitest';
import type { QueueEntry } from '../chat-types';
import { useChatStore } from '../chatStore';

function makeEntry(id: string, status: 'queued' | 'processing' = 'queued'): QueueEntry {
  return {
    id,
    threadId: 'thread-1',
    userId: 'user-1',
    content: `msg-${id}`,
    messageId: null,
    mergedMessageIds: [],
    source: 'user',
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
      queuePaused: false,
      queuePauseReason: undefined,
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

  it('projects live queue receipts onto the original timeline messages', () => {
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
      queueReceipt: {
        version: 1 as const,
        entryId: 'receipt',
        targets: [{ catId: 'opus', state: 'seen' as const, invocationId: 'inv-1' }],
        reminderAttempts: [],
      },
    };

    useChatStore.getState().setQueue('thread-1', [entry]);

    expect(useChatStore.getState().messages.map((message) => message.extra?.queueReceipt)).toEqual([
      entry.queueReceipt,
      entry.queueReceipt,
    ]);
  });

  it('setQueuePaused sets paused state', () => {
    useChatStore.getState().setQueuePaused('thread-1', true, 'canceled');
    const s = useChatStore.getState();
    expect(s.queuePaused).toBe(true);
    expect(s.queuePauseReason).toBe('canceled');
  });

  it('setQueue clears queuePaused when queue becomes empty', () => {
    useChatStore.getState().setQueuePaused('thread-1', true, 'canceled');
    useChatStore.getState().setQueue('thread-1', []);
    expect(useChatStore.getState().queuePaused).toBe(false);
  });

  // P1 Red test: queue_updated after "continue" should clear queuePaused
  // Scenario: queue paused → user clicks continue → backend emits queue_updated
  // with action='processing' and a non-empty queue → queuePaused should be false
  it('P1: queue_updated with processing action clears queuePaused (simulate continue)', () => {
    // Setup: queue is paused with 2 entries
    const entries = [makeEntry('a'), makeEntry('b')];
    useChatStore.getState().setQueue('thread-1', entries);
    useChatStore.getState().setQueuePaused('thread-1', true, 'canceled');
    expect(useChatStore.getState().queuePaused).toBe(true);

    // Simulate: backend processes next → emits queue_updated with one entry now 'processing'
    // This is what useSocket handler does on queue_updated
    const updatedEntries = [makeEntry('a', 'processing'), makeEntry('b')];
    const store = useChatStore.getState();
    store.setQueue('thread-1', updatedEntries);
    // After "continue" via queue_updated, the handler should also clear paused
    // (This is where the bug is — setQueue alone doesn't clear it when queue is non-empty)
    store.setQueuePaused('thread-1', false);

    expect(useChatStore.getState().queuePaused).toBe(false);
    expect(useChatStore.getState().queuePauseReason).toBeUndefined();
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

  it('setQueuePaused on background thread updates threadStates', () => {
    useChatStore.getState().setQueuePaused('thread-2', true, 'failed');
    const ts = useChatStore.getState().threadStates['thread-2'];
    expect(ts?.queuePaused).toBe(true);
    expect(ts?.queuePauseReason).toBe('failed');
  });
});
