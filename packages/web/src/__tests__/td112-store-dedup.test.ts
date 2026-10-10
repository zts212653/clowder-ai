/**
 * Chat store: a message's identity is its server id, and nothing else.
 *
 * addMessage / addMessageToThread never fold two messages with different ids
 * into one bubble, whatever they share (cat, invocation, origin, timing,
 * arrival order). Every event names the message it belongs to, so a
 * post_message is always its own message beside the turn's response. The one
 * dedup left is an exact-id replay, which adds nothing.
 *
 * (Replaces the TD112 cross-id merge tests; the filename is historical.)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

const ACTIVE = 'thread-A';
const BG = 'thread-B';
const T0 = 1_760_000_000_000;
const INV_1 = { stream: { invocationId: 'inv-1', turnInvocationId: 'turn-1' } };
const INV_2 = { stream: { invocationId: 'inv-2', turnInvocationId: 'turn-2' } };

/** An assistant message from one cat; `at` = ms after T0 (every row sits inside 8s). */
function catMsg(id: string, origin: 'stream' | 'callback', at: number, extra?: ChatMessage['extra']): ChatMessage {
  return {
    id,
    type: 'assistant',
    catId: 'opus',
    origin,
    content: `${origin} body of ${id}`,
    timestamp: T0 + at,
    extra,
  };
}

function userMsg(id: string): ChatMessage {
  return { id, type: 'user', content: 'same words', timestamp: T0 };
}

/** Distinct ids, however alike: each must land as its own record, in arrival order. */
const DISTINCT_IDS: Array<[string, ChatMessage[]]> = [
  ['stream then callback of one invocation', [catMsg('s1', 'stream', 0, INV_1), catMsg('c1', 'callback', 1000, INV_1)]],
  ['callback then stream of one invocation', [catMsg('c1', 'callback', 0, INV_1), catMsg('s1', 'stream', 1000, INV_1)]],
  [
    'two callbacks (post_messages) of one invocation',
    [catMsg('c1', 'callback', 0, INV_1), catMsg('c2', 'callback', 500, INV_1)],
  ],
  ['invocationless stream then callback 3s later', [catMsg('s1', 'stream', 0), catMsg('c1', 'callback', 3000)]],
  [
    'an out-of-order inv-1 callback after the inv-2 stream',
    [catMsg('s1', 'stream', 0, INV_1), catMsg('s2', 'stream', 1000, INV_2), catMsg('c1', 'callback', 2000, INV_1)],
  ],
  ['user messages with identical text', [userMsg('u1'), userMsg('u2')]],
];

type Target = { name: string; add: (msg: ChatMessage) => void; read: () => ChatMessage[] | undefined };

const TARGETS: Target[] = [
  {
    name: 'active thread (addMessage)',
    add: (msg) => useChatStore.getState().addMessage(msg),
    read: () => useChatStore.getState().messages,
  },
  {
    name: 'background thread (addMessageToThread)',
    add: (msg) => useChatStore.getState().addMessageToThread(BG, msg),
    read: () => useChatStore.getState().threadStates[BG]?.messages,
  },
];

describe('chat store: message identity is the server id', () => {
  beforeEach(() => {
    useChatStore.setState({ messages: [], currentThreadId: ACTIVE, threadStates: {} });
  });

  describe.each(TARGETS)('$name', ({ add, read }) => {
    it.each(DISTINCT_IDS)('keeps %s as separate records', (_label, msgs) => {
      for (const msg of msgs) add(msg);
      // Same count and order; each record keeps its own id, origin and content.
      expect(read()).toEqual(msgs);
    });

    it('adds nothing for an exact-id replay', () => {
      const first = catMsg('s1', 'stream', 0, INV_1);
      const second = catMsg('c1', 'callback', 1000, INV_1);
      add(first);
      add(second);
      const before = useChatStore.getState();
      add({ ...first });
      // No write at all: no extra record, nothing overwritten, no unread bump.
      expect(useChatStore.getState()).toBe(before);
      expect(read()).toEqual([first, second]);
    });
  });

  it('background: a distinct message raises unread like any other (no merge suppression)', () => {
    const store = useChatStore.getState();
    store.addMessageToThread(BG, catMsg('s1', 'stream', 0, INV_1));
    store.addMessageToThread(BG, { ...catMsg('c1', 'callback', 1000, INV_1), mentionsUser: true });
    const thread = useChatStore.getState().threadStates[BG];
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.unreadCount).toBe(2);
    expect(thread?.hasUserMention).toBe(true);
  });
});
