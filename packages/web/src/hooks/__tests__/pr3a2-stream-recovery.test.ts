/**
 * PR-3a2 (contract §3.11.4): the merged result a page shows after it returns to a thread, traced
 * through the production writers, the History merge and a real server MessageStore.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, RichBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { beginThreadRecovery, currentRecoveryGeneration } from '@/stores/thread-recovery';
import { MessageStore } from '../../../../api/dist/domains/cats/services/stores/ports/MessageStore.js';
import { writeStoredSnapshot, writeStreamText, writeToolEvent } from '../named-message-writer';
import { applyResponseStreamReplay, type StreamReplay } from '../response-stream-replay';
import { issueReplaceRead, mergeReplaceHydrationMessages } from '../useChatHistory';

const T = 'pr3a2-thread';
const OTHER = 'pr3a2-other';

function response(content: string, status: 'processing' | 'completed' = 'processing'): ChatMessage {
  return {
    id: 'r',
    type: 'assistant',
    catId: 'opus',
    origin: 'stream',
    timestamp: 100,
    content,
    isStreaming: status === 'processing',
    extra: { stream: { invocationId: 'parent', turnInvocationId: 'turn' } },
    lifecycle: {
      kind: 'response',
      orderKey: '100:turn',
      invocationId: 'turn',
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      status,
      startedAt: 100,
      ...(status === 'processing' ? {} : { completedAt: 200 }),
    },
  } as ChatMessage;
}

const target = {
  threadId: T,
  messageId: 'r',
  catId: 'opus',
  invocationId: 'parent',
  turnInvocationId: 'turn',
  timestamp: 100,
};

function textEvent(content: string) {
  return { type: 'text', catId: 'opus', messageId: 'r', content, invocationId: 'parent', timestamp: 100 } as const;
}

function replay(events: readonly Record<string, unknown>[], complete = true): StreamReplay {
  return {
    threadId: T,
    joinId: 'join-1',
    responses: [
      {
        messageId: 'r',
        catId: 'opus',
        timestamp: 100,
        events: events as unknown as StreamReplay['responses'][0]['events'],
        complete,
        nextIndex: events.length,
      },
    ],
  };
}

function statusOf(message: ChatMessage | undefined): string | undefined {
  return message?.lifecycle?.kind === 'response' ? message.lifecycle.status : undefined;
}

function shown(id = 'r'): ChatMessage | undefined {
  return useChatStore
    .getState()
    .getThreadState(T)
    .messages.find((message) => message.id === id);
}

/** A History read issued now, landed later exactly as `performFetchHistory` lands it. */
function issueRead() {
  const issue = issueReplaceRead(T);
  return (history: ChatMessage[]) => {
    const merged = mergeReplaceHydrationMessages(history, useChatStore.getState().getThreadState(T).messages, {
      ...issue,
      landedInGeneration: currentRecoveryGeneration(T),
    });
    useChatStore.getState().replaceThreadMessages(T, merged.messages);
    return merged.messages;
  };
}

beforeEach(() => {
  useChatStore.setState({
    currentThreadId: OTHER,
    messages: [],
    threadStates: {},
    catInvocations: {},
    activeInvocations: {},
  });
});

describe('returning to a thread while a reply still streams (§3.11.1)', () => {
  for (const [middle, tail] of [
    ['MISSED-MIDDLE|', 'C|'],
    ['B|', 'LONG-NEW-LIVE-TAIL|'],
  ] as const) {
    it(`rebuilds the missed ${middle} and appends the live ${tail} exactly once`, () => {
      writeStoredSnapshot(T, response('A|'));
      // Away: the server broadcast `middle` into R; this page received none of it.
      applyResponseStreamReplay(replay([textEvent('A|'), textEvent(middle)]));
      writeStreamText(target, { content: tail });
      expect(shown()?.content).toBe(`A|${middle}${tail}`);
      expect(shown()?.streamPrefix).toBe('complete');
    });
  }

  it('keeps the whole body when a read issued before the replay lands after the next live delta', () => {
    writeStoredSnapshot(T, response('A|'));
    const land = issueRead();
    applyResponseStreamReplay(replay([textEvent('A|'), textEvent('B|')]));
    writeStreamText(target, { content: 'C|' });
    land([response('A|')]);
    expect(shown()?.content).toBe('A|B|C|');
  });

  it('keeps the whole body when the read issued after the join lands after the next live delta', () => {
    writeStoredSnapshot(T, response('A|'));
    applyResponseStreamReplay(replay([textEvent('A|'), textEvent('B|')]));
    const land = issueRead();
    writeStreamText(target, { content: 'C|' });
    land([response('A|B|')]);
    expect(shown()?.content).toBe('A|B|C|');
    expect(statusOf(shown())).toBe('processing');
  });

  it('keeps a whole body the provider corrected shorter than the stale draft', () => {
    writeStoredSnapshot(T, response('A|'));
    applyResponseStreamReplay(replay([textEvent('A|'), textEvent('B|')]));
    const land = issueRead();
    writeStreamText(target, { content: 'X', textMode: 'replace' });
    land([response('A|B|')]);
    expect(shown()?.content).toBe('X');
  });

  it('shows the draft for a reply it cannot vouch for, even when its stale copy looks richer', () => {
    writeStoredSnapshot(T, response('A|B|C|'));
    applyResponseStreamReplay(replay([], false));
    issueRead()([response('X')]);
    expect(shown()?.content).toBe('X');
  });

  it('does not double what the page already held', () => {
    writeStoredSnapshot(T, response(''));
    writeStreamText(target, { content: 'A|' });
    writeStreamText(target, { content: 'B|' });
    applyResponseStreamReplay(replay([textEvent('A|B|')]));
    writeStreamText(target, { content: 'C|' });
    expect(shown()?.content).toBe('A|B|C|');
  });

  it('never lets a replay or a processing read take back a committed response', () => {
    writeStoredSnapshot(T, response('FINAL', 'completed'));
    applyResponseStreamReplay(replay([textEvent('A|'), textEvent('B|')]));
    expect(shown()?.content).toBe('FINAL');
    issueRead()([response('A|')]);
    expect(shown()?.content).toBe('FINAL');
    expect(statusOf(shown())).toBe('completed');
  });

  it('rebuilds tools, thinking and blocks once per join and counts no unread', () => {
    writeStoredSnapshot(T, response(''));
    const block = { id: 'b1', kind: 'card', v: 1, title: 'card' } as unknown as RichBlock;
    const events = [
      textEvent('A|'),
      { type: 'tool_use', catId: 'opus', messageId: 'r', toolName: 'Read', toolEventId: 'tool-1', timestamp: 101 },
      { type: 'tool_result', catId: 'opus', messageId: 'r', content: 'ok', toolEventId: 'tool-2', timestamp: 102 },
      {
        type: 'system_info',
        catId: 'opus',
        messageId: 'r',
        content: JSON.stringify({ type: 'thinking', text: 'pondering' }),
        timestamp: 103,
      },
      {
        type: 'system_info',
        catId: 'opus',
        messageId: 'r',
        content: JSON.stringify({ type: 'rich_block', block }),
        timestamp: 104,
      },
    ];
    const unreadBefore = useChatStore.getState().getThreadState(T).unreadCount;
    applyResponseStreamReplay(replay(events));
    applyResponseStreamReplay(replay(events));
    const message = shown()!;
    expect(message.content).toBe('A|');
    expect(message.toolEvents?.map((event) => event.id)).toEqual(['tool-1', 'tool-2']);
    expect(message.thinking).toBe('pondering');
    expect(message.extra?.rich?.blocks?.map((candidate) => candidate.id)).toEqual(['b1']);
    expect(useChatStore.getState().getThreadState(T).unreadCount).toBe(unreadBefore);
  });

  it('shows the same body whether the server joined adjacent deltas or not', () => {
    writeStoredSnapshot(T, response(''));
    const tool = { type: 'tool_use', catId: 'opus', messageId: 'r', toolName: 'Read', toolEventId: 't', timestamp: 1 };
    applyResponseStreamReplay(replay([textEvent('A'), textEvent('B'), tool, textEvent('C')]));
    const separate = shown()!;
    applyResponseStreamReplay(replay([textEvent('AB'), tool, textEvent('C')]));
    const joined = shown()!;
    expect(joined.content).toBe(separate.content);
    expect(joined.toolEvents).toEqual(separate.toolEvents);
  });

  const unknownStarts: Array<[string, StreamReplay]> = [
    ['the server cannot vouch for', replay([], false)],
    ['the server has no record of', { ...replay([]), responses: [] }],
  ];
  for (const [label, entries] of unknownStarts) {
    it(`does not splice live deltas into a reply ${label}`, () => {
      writeStoredSnapshot(T, response('A|'));
      applyResponseStreamReplay(entries);
      expect(shown()?.streamPrefix).toBe('incomplete');
      writeStreamText(target, { content: 'C|' });
      expect(shown()?.content).toBe('A|');
      issueRead()([response('A|B|')]);
      expect(shown()?.content).toBe('A|B|');
      writeStreamText(target, { content: 'D|' });
      expect(shown()?.content).toBe('A|B|');
      writeStoredSnapshot(T, response('A|B|C|D|', 'completed'));
      expect(shown()?.content).toBe('A|B|C|D|');
    });
  }

  it('gives a reply this page never saw a body only through its own replay', () => {
    applyResponseStreamReplay(replay([textEvent('A|'), textEvent('B|')]));
    expect(shown()?.content).toBe('A|B|');
    expect(shown()?.catId).toBe('opus');
    writeToolEvent(target, { id: 'live-tool', type: 'tool_use', label: 'Read', timestamp: 2 });
    expect(shown()?.toolEvents?.map((event) => event.id)).toEqual(['live-tool']);
  });
});

describe('changes missed while a thread was not subscribed (§3.11.2)', () => {
  function serverWith() {
    const server = new MessageStore();
    const saved = server.append({
      threadId: T,
      userId: 'owner',
      from: { kind: 'agent', catId: 'opus' },
      content: 'cached before leaving',
      mentions: [],
      timestamp: 100,
      origin: 'callback',
    });
    return { server, saved };
  }

  function history(server: MessageStore) {
    return server.getByThread(T, 100, 'owner') as unknown as ChatMessage[];
  }

  it('unloads a message deleted elsewhere while this page was away', () => {
    const { server, saved } = serverWith();
    useChatStore.getState().addMessageToThread(T, { ...saved, type: 'assistant' } as unknown as ChatMessage);
    server.softDelete(saved.id, 'owner');
    beginThreadRecovery(T);
    expect(issueRead()(history(server))).toEqual([]);
  });

  it('unloads a reply that arrived through the user room after leaving and was then deleted', () => {
    const server = new MessageStore();
    const r2 = server.append({
      threadId: T,
      userId: 'owner',
      from: { kind: 'agent', catId: 'opus' },
      content: 'R2 body',
      mentions: [],
      timestamp: 300,
      origin: 'stream',
    });
    // Left the thread room; the new reply's snapshot still reached the user room.
    writeStoredSnapshot(T, { ...r2, type: 'assistant' } as unknown as ChatMessage);
    server.softDelete(r2.id, 'owner');
    beginThreadRecovery(T);
    expect(issueRead()(history(server))).toEqual([]);
  });

  it('lets neither a late read from before the return clear a pending copy nor unload a live write', () => {
    const { server, saved } = serverWith();
    useChatStore.getState().addMessageToThread(T, { ...saved, type: 'assistant' } as unknown as ChatMessage);
    const landOld = issueRead();
    server.softDelete(saved.id, 'owner');
    beginThreadRecovery(T);
    // Live after the confirmation, not yet in any read.
    useChatStore.getState().addMessageToThread(T, {
      id: 'live-after-join',
      type: 'assistant',
      catId: 'opus',
      content: 'live',
      timestamp: 400,
    } as ChatMessage);
    const afterOld = landOld([]);
    expect(afterOld.map((message) => [message.id, message.cachedFrom ?? null])).toEqual([
      [saved.id, 'unsubscribed'],
      ['live-after-join', null],
    ]);
    const afterNew = issueRead()(history(server));
    expect(afterNew.map((message) => message.id)).toEqual(['live-after-join']);
  });

  it('unloads older pages for the server to page in again, and keeps what the read returns', () => {
    const server = new MessageStore();
    const all = Array.from({ length: 6 }, (_, index) =>
      server.append({
        threadId: T,
        userId: 'owner',
        from: { kind: 'agent', catId: 'opus' },
        content: `m${index}`,
        mentions: [],
        timestamp: 100 + index,
        origin: 'callback',
      }),
    );
    useChatStore
      .getState()
      .replaceThreadMessages(
        T,
        all.map((message) => ({ ...message, type: 'assistant' })) as unknown as ChatMessage[],
        false,
      );
    beginThreadRecovery(T);
    const latestPage = server.getByThread(T, 2, 'owner') as unknown as ChatMessage[];
    const merged = issueRead()(latestPage);
    expect(merged.map((message) => message.content)).toEqual(['m4', 'm5']);
    expect(merged.every((message) => message.cachedFrom === undefined)).toBe(true);
  });

  it('keeps the replayed reply whole when the read that decides the round lands', () => {
    writeStoredSnapshot(T, response('A|'));
    beginThreadRecovery(T);
    applyResponseStreamReplay(replay([textEvent('A|'), textEvent('B|')]));
    expect(shown()?.cachedFrom).toBeUndefined();
    writeStreamText(target, { content: 'C|' });
    issueRead()([response('A|')]);
    expect(shown()?.content).toBe('A|B|C|');
  });
});
