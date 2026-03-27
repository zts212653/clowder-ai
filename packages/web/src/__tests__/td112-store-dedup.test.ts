/**
 * TD112: Store-level assistant bubble dedup invariant
 *
 * Tests that addMessage / addMessageToThread prevent two assistant text
 * bubbles from the same (catId, invocationId) from coexisting in the store.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

function makMsg(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, type: 'assistant', content: `msg-${id}`, timestamp: Date.now(), ...overrides };
}

describe('TD112: addMessage store-level dedup', () => {
  beforeEach(() => {
    useChatStore.setState({ messages: [], currentThreadId: 'thread-A' });
  });

  it('hard rule: merges when catId + invocationId match (different msg IDs)', () => {
    const store = useChatStore.getState();

    // Stream bubble with invocationId
    store.addMessage(
      makMsg('msg-stream-1', {
        catId: 'gpt52',
        origin: 'stream',
        content: 'stream text...',
        extra: { stream: { invocationId: 'inv-42' } },
      }),
    );

    // Callback with different ID but same catId + invocationId
    store.addMessage(
      makMsg('cb-1', {
        catId: 'gpt52',
        origin: 'callback',
        content: 'final callback text',
        extra: { stream: { invocationId: 'inv-42' } },
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    // Merged: callback content wins, original ID preserved
    expect(msgs[0]!.content).toBe('final callback text');
    expect(msgs[0]!.id).toBe('msg-stream-1');
    expect(msgs[0]!.origin).toBe('callback');
  });

  it('hard rule: allows different invocationIds from same cat', () => {
    const store = useChatStore.getState();

    store.addMessage(
      makMsg('msg-1', {
        catId: 'gpt52',
        origin: 'callback',
        content: 'first response',
        extra: { stream: { invocationId: 'inv-1' } },
      }),
    );
    store.addMessage(
      makMsg('msg-2', {
        catId: 'gpt52',
        origin: 'callback',
        content: 'second response',
        extra: { stream: { invocationId: 'inv-2' } },
      }),
    );

    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  it('soft rule: merges callback→stream upgrade (invocationless, within 8s)', () => {
    const store = useChatStore.getState();
    const now = Date.now();

    // Stream placeholder without invocationId
    store.addMessage(
      makMsg('msg-stream-noid', {
        catId: 'opus',
        origin: 'stream',
        content: 'streaming...',
        timestamp: now,
      }),
    );

    // Callback arrives 3s later, no invocationId
    store.addMessage(
      makMsg('cb-noid', {
        catId: 'opus',
        origin: 'callback',
        content: 'final text',
        timestamp: now + 3000,
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('final text');
    expect(msgs[0]!.origin).toBe('callback');
  });

  it('soft rule: does NOT merge if time gap > 8s', () => {
    const store = useChatStore.getState();
    const now = Date.now();

    store.addMessage(
      makMsg('msg-old', {
        catId: 'opus',
        origin: 'stream',
        content: 'old message',
        timestamp: now,
      }),
    );

    // Callback arrives 10s later → too far, should NOT merge
    store.addMessage(
      makMsg('cb-late', {
        catId: 'opus',
        origin: 'callback',
        content: 'late callback',
        timestamp: now + 10_000,
      }),
    );

    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  it('soft rule: does NOT merge two callbacks (no stream→callback upgrade)', () => {
    const store = useChatStore.getState();
    const now = Date.now();

    store.addMessage(
      makMsg('cb-1', {
        catId: 'opus',
        origin: 'callback',
        content: '收到，我看下',
        timestamp: now,
      }),
    );

    // Another callback within 8s — should NOT merge (both are callback)
    store.addMessage(
      makMsg('cb-2', {
        catId: 'opus',
        origin: 'callback',
        content: '收到，我看下另一个问题',
        timestamp: now + 2000,
      }),
    );

    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  it('soft rule: does NOT merge if visibility differs', () => {
    const store = useChatStore.getState();
    const now = Date.now();

    store.addMessage(
      makMsg('msg-public', {
        catId: 'opus',
        origin: 'stream',
        content: 'public stream',
        visibility: 'public',
        timestamp: now,
      }),
    );

    store.addMessage(
      makMsg('cb-whisper', {
        catId: 'opus',
        origin: 'callback',
        content: 'whisper callback',
        visibility: 'whisper',
        timestamp: now + 2000,
      }),
    );

    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  it('hard rule: merges out-of-order callback past newer stream (cloud P1)', () => {
    const store = useChatStore.getState();

    // Stream inv-1, then stream inv-2 (different invocations)
    store.addMessage(
      makMsg('stream-1', {
        catId: 'gpt52',
        origin: 'stream',
        content: 'first invocation',
        extra: { stream: { invocationId: 'inv-1' } },
      }),
    );
    store.addMessage(
      makMsg('stream-2', {
        catId: 'gpt52',
        origin: 'stream',
        content: 'second invocation',
        extra: { stream: { invocationId: 'inv-2' } },
      }),
    );

    // Callback for inv-1 arrives AFTER inv-2's stream — must scan past inv-2
    store.addMessage(
      makMsg('cb-inv1', {
        catId: 'gpt52',
        origin: 'callback',
        content: 'callback for first',
        extra: { stream: { invocationId: 'inv-1' } },
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(2);
    // inv-1 was merged, inv-2 untouched
    expect(msgs[0]!.content).toBe('callback for first');
    expect(msgs[0]!.id).toBe('stream-1');
    expect(msgs[1]!.content).toBe('second invocation');
  });

  it('hard rule takes priority over bridge rule (cloud P1 round 3)', () => {
    const store = useChatStore.getState();
    const now = Date.now();

    // 1. Callback with inv-1
    store.addMessage(
      makMsg('cb-first', {
        catId: 'gpt52',
        origin: 'callback',
        content: 'first callback',
        extra: { stream: { invocationId: 'inv-1' } },
        timestamp: now,
      }),
    );
    // 2. Stream without invocationId (newer)
    store.addMessage(
      makMsg('stream-noid', {
        catId: 'gpt52',
        origin: 'stream',
        content: 'invocationless stream',
        timestamp: now + 1000,
      }),
    );
    // 3. Another callback with inv-1 → should merge into #1 (hard rule),
    //    NOT into #2 (bridge rule)
    store.addMessage(
      makMsg('cb-second', {
        catId: 'gpt52',
        origin: 'callback',
        content: 'second callback for inv-1',
        extra: { stream: { invocationId: 'inv-1' } },
        timestamp: now + 2000,
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(2);
    // Hard rule merged into first bubble (inv-1)
    expect(msgs[0]!.id).toBe('cb-first');
    expect(msgs[0]!.content).toBe('second callback for inv-1');
    // Invocationless stream untouched
    expect(msgs[1]!.id).toBe('stream-noid');
    expect(msgs[1]!.content).toBe('invocationless stream');
  });

  it('bridge rule: callback with invocationId merges into invocationless stream (codex P1)', () => {
    const store = useChatStore.getState();
    const now = Date.now();

    // Stream placeholder created before invocation_created (no invocationId)
    store.addMessage(
      makMsg('stream-noid', {
        catId: 'gpt52',
        origin: 'stream',
        content: 'streaming...',
        timestamp: now,
      }),
    );

    // Callback arrives with invocationId (late bind)
    store.addMessage(
      makMsg('cb-with-id', {
        catId: 'gpt52',
        origin: 'callback',
        content: 'final text',
        extra: { stream: { invocationId: 'inv-late' } },
        timestamp: now + 3000,
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('final text');
    expect(msgs[0]!.id).toBe('stream-noid');
    // Bridge rule backfills invocationId
    expect(msgs[0]!.extra?.stream?.invocationId).toBe('inv-late');
  });

  it('bridge rule: does NOT merge if time gap > 8s', () => {
    const store = useChatStore.getState();
    const now = Date.now();

    store.addMessage(
      makMsg('old-stream', {
        catId: 'gpt52',
        origin: 'stream',
        content: 'old',
        timestamp: now,
      }),
    );

    store.addMessage(
      makMsg('late-cb', {
        catId: 'gpt52',
        origin: 'callback',
        content: 'late',
        extra: { stream: { invocationId: 'inv-x' } },
        timestamp: now + 10_000,
      }),
    );

    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  it('bridge rule: scans past intervening callback to find stream (cloud P1 round 4)', () => {
    const store = useChatStore.getState();
    const now = Date.now();

    // 1. Stream placeholder (no invocationId)
    store.addMessage(
      makMsg('stream-noid', {
        catId: 'gpt52',
        origin: 'stream',
        content: 'streaming...',
        replyTo: 'u1',
        timestamp: now,
      }),
    );
    // 2. Unrelated callback from same cat (different replyTo)
    store.addMessage(
      makMsg('cb-unrelated', {
        catId: 'gpt52',
        origin: 'callback',
        content: 'unrelated response',
        extra: { stream: { invocationId: 'inv-b' } },
        replyTo: 'u2',
        timestamp: now + 1000,
      }),
    );
    // 3. Target callback → should bridge-merge into #1, skipping #2
    store.addMessage(
      makMsg('cb-target', {
        catId: 'gpt52',
        origin: 'callback',
        content: 'final for stream',
        extra: { stream: { invocationId: 'inv-a' } },
        replyTo: 'u1',
        timestamp: now + 2000,
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(2);
    // Bridge merged #3 into #1
    expect(msgs[0]!.id).toBe('stream-noid');
    expect(msgs[0]!.content).toBe('final for stream');
    expect(msgs[0]!.extra?.stream?.invocationId).toBe('inv-a');
    // Unrelated callback untouched
    expect(msgs[1]!.id).toBe('cb-unrelated');
  });

  it('does not affect non-assistant messages', () => {
    const store = useChatStore.getState();
    store.addMessage(makMsg('u1', { type: 'user', content: 'hello' }));
    store.addMessage(makMsg('u2', { type: 'user', content: 'hello again' }));
    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  it('still deduplicates by exact ID', () => {
    const store = useChatStore.getState();
    store.addMessage(makMsg('same-id', { catId: 'opus' }));
    store.addMessage(makMsg('same-id', { catId: 'opus' }));
    expect(useChatStore.getState().messages).toHaveLength(1);
  });
});

describe('TD112: addMessageToThread store-level dedup', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      currentThreadId: 'thread-A',
      threadStates: {},
    });
  });

  it('hard rule: merges in background thread', () => {
    const store = useChatStore.getState();

    store.addMessageToThread(
      'thread-B',
      makMsg('bg-stream', {
        catId: 'gpt52',
        origin: 'stream',
        content: 'stream...',
        extra: { stream: { invocationId: 'inv-99' } },
      }),
    );
    store.addMessageToThread(
      'thread-B',
      makMsg('bg-cb', {
        catId: 'gpt52',
        origin: 'callback',
        content: 'final',
        extra: { stream: { invocationId: 'inv-99' } },
      }),
    );

    const msgs = useChatStore.getState().threadStates['thread-B']?.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs![0]!.content).toBe('final');
  });

  it('hard rule: merges in active thread via addMessageToThread', () => {
    const store = useChatStore.getState();

    store.addMessageToThread(
      'thread-A',
      makMsg('active-stream', {
        catId: 'opus',
        origin: 'stream',
        content: 'streaming...',
        extra: { stream: { invocationId: 'inv-77' } },
      }),
    );
    store.addMessageToThread(
      'thread-A',
      makMsg('active-cb', {
        catId: 'opus',
        origin: 'callback',
        content: 'done!',
        extra: { stream: { invocationId: 'inv-77' } },
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('done!');
  });

  it('background dedup does NOT increment unreadCount', () => {
    const store = useChatStore.getState();

    store.addMessageToThread(
      'thread-B',
      makMsg('bg-s', {
        catId: 'gpt52',
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-100' } },
      }),
    );
    // This second message merges → should NOT increment unread
    store.addMessageToThread(
      'thread-B',
      makMsg('bg-c', {
        catId: 'gpt52',
        origin: 'callback',
        extra: { stream: { invocationId: 'inv-100' } },
      }),
    );

    expect(useChatStore.getState().threadStates['thread-B']?.unreadCount).toBe(1);
  });

  it('background dedup propagates hasUserMention on merge (cloud P1)', () => {
    const store = useChatStore.getState();

    // Stream without mention
    store.addMessageToThread(
      'thread-B',
      makMsg('bg-no-mention', {
        catId: 'gpt52',
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-mention' } },
      }),
    );

    // Callback with mention — merged, but hasUserMention must propagate
    store.addMessageToThread(
      'thread-B',
      makMsg('bg-mention', {
        catId: 'gpt52',
        origin: 'callback',
        mentionsUser: true,
        extra: { stream: { invocationId: 'inv-mention' } },
      }),
    );

    const ts = useChatStore.getState().threadStates['thread-B'];
    expect(ts?.messages).toHaveLength(1);
    expect(ts?.hasUserMention).toBe(true);
  });
});
