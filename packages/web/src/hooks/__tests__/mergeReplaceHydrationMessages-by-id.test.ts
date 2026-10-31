/**
 * Fetched history and local records share one identity: the message id. Nothing pairs
 * records by cat or turn — the response a turn streams into and a post_message are two
 * messages because they have two ids.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { mergeReplaceHydrationMessages } from '../useChatHistory';

const TURN = 'turn-1';

function response(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'response-1',
    type: 'assistant',
    catId: 'opus',
    content: '',
    origin: 'stream',
    timestamp: 1000,
    extra: { stream: { invocationId: 'parent-1', turnInvocationId: TURN } },
    lifecycle: {
      kind: 'response',
      orderKey: `1000:${TURN}`,
      invocationId: TURN,
      targetId: 'opus',
      inputEntryIds: ['entry-1'],
      inputMessageIds: ['source-1'],
      status: 'processing',
      startedAt: 1000,
    },
    ...overrides,
  };
}

function completed(content: string): ChatMessage {
  const base = response();
  if (base.lifecycle?.kind !== 'response') throw new Error('expected response lifecycle');
  return { ...base, content, lifecycle: { ...base.lifecycle, status: 'completed', completedAt: 2000 } };
}

describe('mergeReplaceHydrationMessages — by id only', () => {
  it('lets a committed response win over a richer local copy that still looks processing', () => {
    const local = response({ content: 'partial live text that ran longer', isStreaming: true });

    const [merged] = mergeReplaceHydrationMessages([completed('final')], [local]).messages;

    expect(merged?.content).toBe('final');
    expect(merged?.lifecycle).toMatchObject({ kind: 'response', status: 'completed' });
    expect(merged?.isStreaming).toBe(false);
  });

  it('keeps the live body of a processing response but takes the server lifecycle', () => {
    const local = response({ content: 'live body', isStreaming: true });
    const server = response({ content: 'draft' });

    const [merged] = mergeReplaceHydrationMessages([server], [local]).messages;

    expect(merged?.content).toBe('live body');
    expect(merged?.lifecycle).toEqual(server.lifecycle);
  });

  it('never pairs a local record with a history record of the same cat and turn under another id', () => {
    const post: ChatMessage = {
      id: 'post-1',
      type: 'assistant',
      catId: 'opus',
      content: 'posted mid-turn',
      origin: 'callback',
      timestamp: 1500,
      extra: { isExplicitPost: true, stream: { invocationId: 'parent-1', turnInvocationId: TURN } },
    };

    const merged = mergeReplaceHydrationMessages([completed('final')], [post]).messages;

    expect(merged.map((message) => message.id)).toEqual(['response-1', 'post-1']);
  });
});
