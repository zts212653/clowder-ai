/**
 * Issue #586: 前端状态三连击 — 气泡裂变 + 猫状态不准 + 未读点复活
 *
 * Regression tests for the three interlinked bugs:
 * - Bug 1 (TD112): callback-before-stream creates duplicate bubbles
 * - Bug 2: clearCatStatuses leaves catInvocations stale → status panel shows wrong state
 * - Bug 3: 10s unread suppression window expires → dots reappear after reading
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

function makMsg(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, type: 'assistant', content: `msg-${id}`, timestamp: Date.now(), ...overrides };
}

describe('Issue #586 Bug 1: Store-level message dedup', () => {
  beforeEach(() => {
    useChatStore.setState({ messages: [], threadStates: {}, currentThreadId: 'thread-A' });
  });

  it('addMessage still deduplicates by exact id', () => {
    const store = useChatStore.getState();
    store.addMessage(makMsg('a'));
    store.addMessage(makMsg('a'));
    expect(useChatStore.getState().messages).toHaveLength(1);
  });

  it('addMessageToThread deduplicates by exact id in background thread', () => {
    const store = useChatStore.getState();
    store.addMessageToThread('thread-B', makMsg('bg-1', { catId: 'opus' }));
    store.addMessageToThread('thread-B', makMsg('bg-1', { catId: 'opus' }));
    expect(useChatStore.getState().threadStates['thread-B']?.messages).toHaveLength(1);
  });

  it('addMessageToThread increments unreadCount for background threads', () => {
    const store = useChatStore.getState();
    store.addMessageToThread('thread-B', makMsg('bg-1', { catId: 'opus' }));
    expect(useChatStore.getState().threadStates['thread-B']?.unreadCount).toBe(1);
  });
});

describe('Issue #586 Bug 2: clearCatStatuses also resets catInvocations', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      catStatuses: {},
      catInvocations: {},
      targetCats: [],
      currentThreadId: 'thread-A',
    });
  });

  it('clearCatStatuses marks running taskProgress as completed', () => {
    const store = useChatStore.getState();

    // Simulate cat working with active task progress
    store.setCatStatus('opus', 'streaming');
    store.setCatInvocation('opus', {
      invocationId: 'inv-1',
      taskProgress: {
        tasks: [{ id: 't1', subject: 'writing code', status: 'in_progress' }],
        lastUpdate: Date.now(),
        snapshotStatus: 'running',
      },
    });

    // Clear cat statuses (as done(isFinal) does)
    store.clearCatStatuses();

    const state = useChatStore.getState();
    expect(state.catStatuses).toEqual({});
    expect(state.targetCats).toEqual([]);
    // catInvocations taskProgress should be marked completed
    expect(state.catInvocations.opus?.taskProgress?.snapshotStatus).toBe('completed');
  });

  it('clearCatStatuses preserves already-completed taskProgress', () => {
    const store = useChatStore.getState();
    store.setCatInvocation('opus', {
      taskProgress: {
        tasks: [{ id: 't1', subject: 'done task', status: 'completed' }],
        lastUpdate: Date.now(),
        snapshotStatus: 'completed',
      },
    });

    store.clearCatStatuses();

    const state = useChatStore.getState();
    expect(state.catInvocations.opus?.taskProgress?.snapshotStatus).toBe('completed');
  });

  it('clearCatStatuses preserves interrupted taskProgress (cloud P1)', () => {
    const store = useChatStore.getState();
    // Cat A is running, Cat B was interrupted
    store.setCatInvocation('opus', {
      taskProgress: {
        tasks: [{ id: 't1', subject: 'writing', status: 'in_progress' }],
        lastUpdate: Date.now(),
        snapshotStatus: 'running',
      },
    });
    store.setCatInvocation('codex', {
      taskProgress: {
        tasks: [{ id: 't2', subject: 'reviewing', status: 'pending' }],
        lastUpdate: Date.now(),
        snapshotStatus: 'interrupted',
        interruptReason: 'canceled',
      },
    });

    store.clearCatStatuses();

    const state = useChatStore.getState();
    // Running → completed
    expect(state.catInvocations.opus?.taskProgress?.snapshotStatus).toBe('completed');
    // Interrupted → preserved (not overwritten to completed)
    expect(state.catInvocations.codex?.taskProgress?.snapshotStatus).toBe('interrupted');
    expect(state.catInvocations.codex?.taskProgress?.interruptReason).toBe('canceled');
  });

  it('clearCatStatuses handles empty catInvocations', () => {
    const store = useChatStore.getState();
    store.setCatStatus('opus', 'done');
    store.clearCatStatuses();
    const state = useChatStore.getState();
    expect(state.catStatuses).toEqual({});
    expect(state.catInvocations).toEqual({});
  });
});

describe('Issue #586 Bug 3: Ack-driven unread suppression', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      currentThreadId: 'thread-A',
      threadStates: {
        'thread-B': {
          messages: [],
          isLoading: false,
          isLoadingHistory: false,
          hasMore: true,
          hasActiveInvocation: false,
          activeInvocations: {},
          intentMode: null,
          targetCats: [],
          catStatuses: {},
          catInvocations: {},
          currentGame: null,
          unreadCount: 5,
          hasUserMention: false,
          lastActivity: Date.now(),
          queue: [],
          queuePaused: false,
          queueFull: false,
        },
      },
      _unreadSuppressedUntil: {},
      _pendingAckCount: {},
    });
  });

  it('clearUnread sets Infinity suppression (not 10s)', () => {
    const store = useChatStore.getState();
    store.clearUnread('thread-B');

    const state = useChatStore.getState();
    expect(state.threadStates['thread-B']?.unreadCount).toBe(0);
    expect(state._unreadSuppressedUntil['thread-B']).toBe(Infinity);
  });

  it('initThreadUnread is blocked while Infinity suppression is active', () => {
    const store = useChatStore.getState();
    store.clearUnread('thread-B');

    // Server returns stale unread count — should be blocked
    store.initThreadUnread('thread-B', 3, false);

    expect(useChatStore.getState().threadStates['thread-B']?.unreadCount).toBe(0);
  });

  it('confirmUnreadAck clears suppression when all acks resolve', () => {
    const store = useChatStore.getState();
    store.armUnreadSuppression('thread-B');
    store.confirmUnreadAck('thread-B');

    expect(useChatStore.getState()._unreadSuppressedUntil['thread-B']).toBeUndefined();

    store.initThreadUnread('thread-B', 2, false);
    expect(useChatStore.getState().threadStates['thread-B']?.unreadCount).toBe(2);
  });

  it('overlapping acks: suppression holds until ALL resolve (pending count)', () => {
    const store = useChatStore.getState();
    // User reads the thread
    store.clearUnread('thread-B');
    expect(useChatStore.getState().threadStates['thread-B']?.unreadCount).toBe(0);

    // Ack #1 fires
    store.armUnreadSuppression('thread-B');
    // Ack #2 fires (new message arrived)
    store.armUnreadSuppression('thread-B');

    // Ack #1 resolves — still 1 pending, suppression holds
    store.confirmUnreadAck('thread-B');
    expect(useChatStore.getState()._unreadSuppressedUntil['thread-B']).toBe(Infinity);

    // Stale re-hydration should still be blocked
    store.initThreadUnread('thread-B', 1, false);
    expect(useChatStore.getState().threadStates['thread-B']?.unreadCount).toBe(0);

    // Ack #2 resolves — 0 pending, suppression clears
    store.confirmUnreadAck('thread-B');
    expect(useChatStore.getState()._unreadSuppressedUntil['thread-B']).toBeUndefined();
  });

  it('full lifecycle: clear → arm → ack confirm → re-hydrate works', () => {
    const store = useChatStore.getState();

    // 1. User reads thread-B → clear unread
    store.clearUnread('thread-B');
    expect(useChatStore.getState().threadStates['thread-B']?.unreadCount).toBe(0);
    expect(useChatStore.getState()._unreadSuppressedUntil['thread-B']).toBe(Infinity);

    // 2. Ack effect arms suppression (simulating ChatContainer)
    store.armUnreadSuppression('thread-B');

    // 3. Server stale re-hydration attempt — blocked
    store.initThreadUnread('thread-B', 5, false);
    expect(useChatStore.getState().threadStates['thread-B']?.unreadCount).toBe(0);

    // 4. POST /read/latest succeeds → all acks done → suppression clears
    store.confirmUnreadAck('thread-B');
    expect(useChatStore.getState()._unreadSuppressedUntil['thread-B']).toBeUndefined();

    // 5. New real messages arrive (server correctly says 1 new)
    store.initThreadUnread('thread-B', 1, false);
    expect(useChatStore.getState().threadStates['thread-B']?.unreadCount).toBe(1);
  });
});

describe('Issue #586 Review P1-1: clearAllUnread uses finite suppression', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      currentThreadId: 'thread-A',
      threadStates: {
        'thread-B': {
          messages: [],
          isLoading: false,
          isLoadingHistory: false,
          hasMore: true,
          hasActiveInvocation: false,
          activeInvocations: {},
          intentMode: null,
          targetCats: [],
          catStatuses: {},
          catInvocations: {},
          currentGame: null,
          unreadCount: 3,
          hasUserMention: false,
          lastActivity: Date.now(),
          queue: [],
          queuePaused: false,
          queueFull: false,
        },
        'thread-C': {
          messages: [],
          isLoading: false,
          isLoadingHistory: false,
          hasMore: true,
          hasActiveInvocation: false,
          activeInvocations: {},
          intentMode: null,
          targetCats: [],
          catStatuses: {},
          catInvocations: {},
          currentGame: null,
          unreadCount: 5,
          hasUserMention: true,
          lastActivity: Date.now(),
          queue: [],
          queuePaused: false,
          queueFull: false,
        },
      },
      _unreadSuppressedUntil: {},
    });
  });

  it('clearAllUnread uses finite suppression, NOT Infinity', () => {
    const store = useChatStore.getState();
    store.clearAllUnread();

    const suppressed = useChatStore.getState()._unreadSuppressedUntil;
    // Must be finite — Infinity would permanently block threads the user never opens
    expect(suppressed['thread-B']).toBeDefined();
    expect(Number.isFinite(suppressed['thread-B'])).toBe(true);
    expect(suppressed['thread-C']).toBeDefined();
    expect(Number.isFinite(suppressed['thread-C'])).toBe(true);
  });

  it('clearUnread (single thread) still uses Infinity (needs ack)', () => {
    const store = useChatStore.getState();
    store.clearUnread('thread-B');

    expect(useChatStore.getState()._unreadSuppressedUntil['thread-B']).toBe(Infinity);
  });
});
