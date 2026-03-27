import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDebugEvents, configureDebug, dumpBubbleTimeline } from '@/debug/invocationEventDebug';
import type { ChatMessage } from '../chat-types';
import { useChatStore } from '../chatStore';

function makeMsg(id: string, content = 'hello'): ChatMessage {
  return { id, type: 'user', content, timestamp: Date.now() };
}

describe('chatStore multi-thread state', () => {
  beforeEach(() => {
    clearDebugEvents();
    configureDebug({ enabled: false });
    // Reset store to initial state
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
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentThreadId: 'thread-a',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
  });

  afterEach(() => {
    clearDebugEvents();
    configureDebug({ enabled: false });
  });

  it('preserves messages when switching threads', () => {
    const store = useChatStore.getState();

    // Add messages to thread A
    store.addMessage(makeMsg('a1', 'from A'));
    store.addMessage(makeMsg('a2', 'also from A'));
    expect(useChatStore.getState().messages).toHaveLength(2);

    // Switch to thread B
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().currentThreadId).toBe('thread-b');
    expect(useChatStore.getState().messages).toHaveLength(0); // fresh thread

    // Add messages to thread B
    useChatStore.getState().addMessage(makeMsg('b1', 'from B'));
    expect(useChatStore.getState().messages).toHaveLength(1);

    // Switch back to thread A — messages should be restored
    useChatStore.getState().setCurrentThread('thread-a');
    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).toBe('a1');
    expect(msgs[1].id).toBe('a2');
  });

  it('preserves catStatuses when switching threads', () => {
    // Set cat status on thread A
    useChatStore.getState().setTargetCats(['opus', 'codex']);
    useChatStore.getState().setCatStatus('opus', 'streaming');
    expect(useChatStore.getState().catStatuses.opus).toBe('streaming');

    // Switch to thread B
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().targetCats).toHaveLength(0);
    expect(useChatStore.getState().catStatuses).toEqual({});

    // Switch back to thread A — statuses restored
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().targetCats).toEqual(['opus', 'codex']);
    expect(useChatStore.getState().catStatuses.opus).toBe('streaming');
  });

  it('preserves intentMode when switching threads', () => {
    useChatStore.getState().setIntentMode('ideate');
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().intentMode).toBeNull();

    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().intentMode).toBe('ideate');
  });

  it('preserves currentGame when switching threads', () => {
    const game = { gameId: 'g1', gameType: 'werewolf', status: 'playing' as const, currentPhase: 'night', round: 1 };
    useChatStore.getState().setCurrentGame(game);
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().currentGame).toBeNull();

    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().currentGame).toEqual(game);
  });

  it('does nothing when switching to same thread', () => {
    useChatStore.getState().addMessage(makeMsg('x1'));
    const before = useChatStore.getState();
    useChatStore.getState().setCurrentThread('thread-a');
    const after = useChatStore.getState();
    expect(before).toBe(after); // exact same reference (no state change)
  });

  describe('addMessageToThread', () => {
    it('adds to flat state when thread is active', () => {
      useChatStore.getState().addMessageToThread('thread-a', makeMsg('m1'));
      expect(useChatStore.getState().messages).toHaveLength(1);
    });

    it('adds to map when thread is not active', () => {
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('m1'));
      // Flat state unchanged
      expect(useChatStore.getState().messages).toHaveLength(0);
      // Map updated
      const ts = useChatStore.getState().threadStates['thread-b'];
      expect(ts).toBeDefined();
      expect(ts?.messages).toHaveLength(1);
      expect(ts?.unreadCount).toBe(1);
    });

    it('deduplicates by id', () => {
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('m1'));
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('m1'));
      const ts = useChatStore.getState().threadStates['thread-b'];
      expect(ts?.messages).toHaveLength(1);
    });
  });

  describe('appendToThreadMessage', () => {
    it('appends to active thread message content', () => {
      useChatStore.getState().addMessage(makeMsg('m1', 'hello'));
      useChatStore.getState().appendToThreadMessage('thread-a', 'm1', ' world');
      expect(useChatStore.getState().messages[0].content).toBe('hello world');
    });

    it('appends to background thread message content', () => {
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('m2', 'foo'));
      useChatStore.getState().appendToThreadMessage('thread-b', 'm2', 'bar');
      expect(useChatStore.getState().threadStates['thread-b']?.messages[0].content).toBe('foobar');
    });
  });

  describe('replaceMessageId / replaceThreadMessageId', () => {
    it('replaces an optimistic active-thread message id in place', () => {
      useChatStore.getState().addMessage(makeMsg('temp-user-1', 'hello'));
      useChatStore.getState().replaceMessageId('temp-user-1', 'msg-server-1');

      const messages = useChatStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('msg-server-1');
      expect(messages[0].content).toBe('hello');
    });

    it('drops the optimistic active-thread duplicate when the canonical id already exists', () => {
      useChatStore.getState().addMessage(makeMsg('temp-user-1', 'hello'));
      useChatStore.getState().addMessage(makeMsg('msg-server-1', 'hello'));

      useChatStore.getState().replaceMessageId('temp-user-1', 'msg-server-1');

      const messages = useChatStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('msg-server-1');
    });

    it('TD112: merges duplicate assistant bubble at addMessage time instead of needing replaceMessageId drop', () => {
      configureDebug({ enabled: true });
      useChatStore.getState().addMessage({
        id: 'temp-stream-1',
        type: 'assistant',
        catId: 'opus',
        content: 'hello',
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-1' } },
        timestamp: Date.now(),
      });
      useChatStore.getState().addMessage({
        id: 'msg-server-1',
        type: 'assistant',
        catId: 'opus',
        content: 'hello',
        origin: 'callback',
        extra: { stream: { invocationId: 'inv-1' } },
        timestamp: Date.now() + 1,
      });

      // TD112: second addMessage merges into first — only 1 message exists
      expect(useChatStore.getState().messages).toHaveLength(1);
      expect(useChatStore.getState().messages[0]!.id).toBe('temp-stream-1');
      expect(useChatStore.getState().messages[0]!.origin).toBe('callback');

      // The merge event should have been recorded
      expect(dumpBubbleTimeline({ rawThreadId: true }).events).toEqual([
        expect.objectContaining({
          event: 'bubble_lifecycle',
          threadId: 'thread-a',
          action: 'merge',
          reason: 'td112_store_dedup',
          catId: 'opus',
        }),
      ]);
    });

    it('replaces an optimistic background-thread message id in place', () => {
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('temp-user-2', 'background'));

      useChatStore.getState().replaceThreadMessageId('thread-b', 'temp-user-2', 'msg-server-2');

      const messages = useChatStore.getState().threadStates['thread-b']?.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('msg-server-2');
      expect(messages[0].content).toBe('background');
    });

    it('drops the optimistic background-thread duplicate when the canonical id already exists', () => {
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('temp-user-2', 'background'));
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('msg-server-2', 'background'));

      useChatStore.getState().replaceThreadMessageId('thread-b', 'temp-user-2', 'msg-server-2');

      const messages = useChatStore.getState().threadStates['thread-b']?.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('msg-server-2');
    });

    it('patchMessage merges callback fields without dropping stream invocation identity', () => {
      useChatStore.getState().addMessage({
        id: 'msg-stream-1',
        type: 'assistant',
        catId: 'opus',
        content: 'thinking...',
        origin: 'stream',
        isStreaming: true,
        extra: { stream: { invocationId: 'inv-1' } },
        timestamp: Date.now(),
      });

      useChatStore.getState().patchMessage('msg-stream-1', {
        content: 'final answer',
        origin: 'callback',
        isStreaming: false,
        extra: { crossPost: { sourceThreadId: 'thread-x', sourceInvocationId: 'inv-x' } },
      });

      expect(useChatStore.getState().messages).toEqual([
        expect.objectContaining({
          id: 'msg-stream-1',
          content: 'final answer',
          origin: 'callback',
          isStreaming: false,
          extra: {
            stream: { invocationId: 'inv-1' },
            crossPost: { sourceThreadId: 'thread-x', sourceInvocationId: 'inv-x' },
          },
        }),
      ]);
    });
  });

  describe('setThreadMessageStreaming', () => {
    it('updates streaming flag in active thread', () => {
      useChatStore.getState().addMessage({ ...makeMsg('m3', 'run'), type: 'assistant' });
      useChatStore.getState().setThreadMessageStreaming('thread-a', 'm3', true);
      expect(useChatStore.getState().messages[0].isStreaming).toBe(true);
    });

    it('updates streaming flag in background thread', () => {
      useChatStore.getState().addMessageToThread('thread-b', { ...makeMsg('m4', 'run'), type: 'assistant' });
      useChatStore.getState().setThreadMessageStreaming('thread-b', 'm4', true);
      expect(useChatStore.getState().threadStates['thread-b']?.messages[0].isStreaming).toBe(true);
    });
  });

  describe('getThreadState', () => {
    it('returns active thread state from flat fields', () => {
      useChatStore.getState().addMessage(makeMsg('g1'));
      useChatStore.getState().setLoading(true);
      const ts = useChatStore.getState().getThreadState('thread-a');
      expect(ts.messages).toHaveLength(1);
      expect(ts.isLoading).toBe(true);
    });

    it('returns background thread state from map', () => {
      useChatStore.getState().addMessageToThread('thread-c', makeMsg('g2'));
      const ts = useChatStore.getState().getThreadState('thread-c');
      expect(ts.messages).toHaveLength(1);
    });

    it('returns defaults for unknown thread', () => {
      const ts = useChatStore.getState().getThreadState('thread-unknown');
      expect(ts.messages).toHaveLength(0);
      expect(ts.isLoading).toBe(false);
    });
  });

  describe('unread tracking', () => {
    it('incrementUnread updates background thread', () => {
      // Set up a background thread with state
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('u1'));
      useChatStore.getState().incrementUnread('thread-b');
      const ts = useChatStore.getState().threadStates['thread-b'];
      // 1 from addMessageToThread + 1 from incrementUnread
      expect(ts?.unreadCount).toBe(2);
    });

    it('clearUnread resets count', () => {
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('u2'));
      useChatStore.getState().clearUnread('thread-b');
      expect(useChatStore.getState().threadStates['thread-b']?.unreadCount).toBe(0);
    });

    it('incrementUnread is no-op for active thread', () => {
      const before = useChatStore.getState();
      useChatStore.getState().incrementUnread('thread-a');
      const after = useChatStore.getState();
      expect(before).toBe(after);
    });
  });

  describe('viewMode', () => {
    it('defaults to single', () => {
      expect(useChatStore.getState().viewMode).toBe('single');
    });

    it('can switch to split', () => {
      useChatStore.getState().setViewMode('split');
      expect(useChatStore.getState().viewMode).toBe('split');
    });

    it('manages split pane thread IDs', () => {
      useChatStore.getState().setSplitPaneThreadIds(['a', 'b', 'c', 'd']);
      expect(useChatStore.getState().splitPaneThreadIds).toEqual(['a', 'b', 'c', 'd']);
    });

    it('manages split pane target', () => {
      useChatStore.getState().setSplitPaneTarget('b');
      expect(useChatStore.getState().splitPaneTargetId).toBe('b');
    });
  });

  it('preserves isLoading across thread switches', () => {
    useChatStore.getState().setLoading(true);
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().isLoading).toBe(false); // fresh thread

    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().isLoading).toBe(true); // restored
  });

  describe('updateThreadCatStatus', () => {
    it('updates active thread cat status via flat state', () => {
      useChatStore.getState().updateThreadCatStatus('thread-a', 'opus', 'streaming');
      expect(useChatStore.getState().catStatuses.opus).toBe('streaming');
    });

    it('updates background thread cat status in map', () => {
      useChatStore.getState().updateThreadCatStatus('thread-b', 'codex', 'error');
      const ts = useChatStore.getState().threadStates['thread-b'];
      expect(ts).toBeDefined();
      expect(ts?.catStatuses.codex).toBe('error');
    });

    it('preserves existing cat statuses when updating one cat', () => {
      useChatStore.getState().updateThreadCatStatus('thread-b', 'opus', 'streaming');
      useChatStore.getState().updateThreadCatStatus('thread-b', 'codex', 'done');
      const ts = useChatStore.getState().threadStates['thread-b']!;
      expect(ts.catStatuses.opus).toBe('streaming');
      expect(ts.catStatuses.codex).toBe('done');
    });

    it('updates lastActivity when updating background thread', () => {
      const before = Date.now();
      useChatStore.getState().updateThreadCatStatus('thread-b', 'opus', 'done');
      const ts = useChatStore.getState().threadStates['thread-b']!;
      expect(ts.lastActivity).toBeGreaterThanOrEqual(before);
    });
  });

  describe('setThreadTargetCats pre-seeds catStatuses (yellow cat fix)', () => {
    it('background thread gets pending catStatuses when targetCats are set', () => {
      // Simulate the background intent_mode sequence from useSocket.ts:
      // 1. setThreadIntentMode clears catStatuses to {}
      useChatStore.getState().setThreadIntentMode('thread-b', 'execute');
      expect(useChatStore.getState().threadStates['thread-b']?.catStatuses).toEqual({});

      // 2. setThreadTargetCats should pre-seed with 'pending' (like active path)
      useChatStore.getState().setThreadTargetCats('thread-b', ['opus', 'codex']);
      const ts = useChatStore.getState().threadStates['thread-b']!;
      expect(ts.targetCats).toEqual(['opus', 'codex']);
      expect(ts.catStatuses).toEqual({ opus: 'pending', codex: 'pending' });
    });

    it('active thread also gets pending catStatuses from setThreadTargetCats', () => {
      // Active thread path should mirror background behavior
      useChatStore.getState().setThreadTargetCats('thread-a', ['gemini']);
      expect(useChatStore.getState().targetCats).toEqual(['gemini']);
      expect(useChatStore.getState().catStatuses).toEqual({ gemini: 'pending' });
    });
  });

  it('handles rapid multi-thread switches', () => {
    // thread-a: add message
    useChatStore.getState().addMessage(makeMsg('r1'));
    // switch to b
    useChatStore.getState().setCurrentThread('thread-b');
    useChatStore.getState().addMessage(makeMsg('r2'));
    // switch to c
    useChatStore.getState().setCurrentThread('thread-c');
    useChatStore.getState().addMessage(makeMsg('r3'));
    // switch back to a
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['r1']);
    // switch to b
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['r2']);
    // switch to c
    useChatStore.getState().setCurrentThread('thread-c');
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['r3']);
  });

  describe('unread suppression (persistent badge fix)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('clearUnread sets suppression that blocks initThreadUnread', () => {
      // Background thread gets unread
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('s1'));
      expect(useChatStore.getState().threadStates['thread-b']?.unreadCount).toBe(1);

      // User opens thread-b (simulated) — clearUnread fires
      useChatStore.getState().clearUnread('thread-b');
      expect(useChatStore.getState().threadStates['thread-b']?.unreadCount).toBe(0);

      // API re-hydration arrives with stale count — should be suppressed
      useChatStore.getState().initThreadUnread('thread-b', 1, false);
      expect(useChatStore.getState().threadStates['thread-b']?.unreadCount).toBe(0);
    });

    it('suppression persists until confirmUnreadAck (#586)', () => {
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('s2'));
      useChatStore.getState().clearUnread('thread-b');

      // Even after a long time, suppression holds (Infinity, not 10s)
      vi.advanceTimersByTime(120_000);

      // Still suppressed — initThreadUnread is blocked
      useChatStore.getState().initThreadUnread('thread-b', 2, false);
      expect(useChatStore.getState().threadStates['thread-b']?.unreadCount).toBe(0);

      // Any successful ack clears suppression (/read/latest is idempotent)
      useChatStore.getState().confirmUnreadAck('thread-b');

      // Now initThreadUnread works
      useChatStore.getState().initThreadUnread('thread-b', 2, false);
      expect(useChatStore.getState().threadStates['thread-b']?.unreadCount).toBe(2);
    });

    it('clearAllUnread suppresses all threads', () => {
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('s3'));
      useChatStore.getState().addMessageToThread('thread-c', makeMsg('s4'));

      useChatStore.getState().clearAllUnread();
      expect(useChatStore.getState().threadStates['thread-b']?.unreadCount).toBe(0);
      expect(useChatStore.getState().threadStates['thread-c']?.unreadCount).toBe(0);

      // Stale re-hydration — both suppressed
      useChatStore.getState().initThreadUnread('thread-b', 1, false);
      useChatStore.getState().initThreadUnread('thread-c', 3, true);
      expect(useChatStore.getState().threadStates['thread-b']?.unreadCount).toBe(0);
      expect(useChatStore.getState().threadStates['thread-c']?.unreadCount).toBe(0);
    });

    it('suppression does not block genuinely new messages via addMessageToThread', () => {
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('s5'));
      useChatStore.getState().clearUnread('thread-b');

      // A genuinely new WebSocket message arrives — addMessageToThread should still work
      useChatStore.getState().addMessageToThread('thread-b', makeMsg('s6'));
      expect(useChatStore.getState().threadStates['thread-b']?.unreadCount).toBe(1);
    });
  });
});
