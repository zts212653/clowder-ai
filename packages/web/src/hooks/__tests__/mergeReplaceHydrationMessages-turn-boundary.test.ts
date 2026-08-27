import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/chat-types';
import { mergeReplaceHydrationMessages } from '../useChatHistory';

const PARENT_INVOCATION_ID = 'parent-active-turn';
const ACTIVE_TURN_INVOCATION_ID = 'turn-active';

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'message-default',
    type: 'assistant',
    catId: 'codex-sol',
    content: '',
    timestamp: 1_000,
    ...overrides,
  };
}

function makeStreamIdentity(turnInvocationId?: string) {
  return {
    stream: {
      invocationId: PARENT_INVOCATION_ID,
      ...(turnInvocationId ? { turnInvocationId } : {}),
    },
  };
}

function assistantMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.type === 'assistant');
}

describe('mergeReplaceHydrationMessages — user supplement turn boundary', () => {
  it('reconciles one live bubble with its same-turn server draft across a user supplement', () => {
    const liveBubble = makeMessage({
      id: `msg-${ACTIVE_TURN_INVOCATION_ID}-codex-sol`,
      origin: 'stream',
      content: 'still working',
      isStreaming: true,
      timestamp: 1_000,
      extra: makeStreamIdentity(ACTIVE_TURN_INVOCATION_ID),
    });
    const userSupplement = makeMessage({
      id: 'user-supplement',
      type: 'user',
      catId: undefined,
      content: 'one more detail for the active turn',
      timestamp: 2_000,
    });
    const serverDraft = makeMessage({
      id: `draft-${ACTIVE_TURN_INVOCATION_ID}`,
      origin: 'stream',
      content: 'still working from server',
      isStreaming: true,
      timestamp: 3_000,
      extra: makeStreamIdentity(ACTIVE_TURN_INVOCATION_ID),
    });

    const result = mergeReplaceHydrationMessages([serverDraft], [liveBubble, userSupplement], {});

    expect(assistantMessages(result.messages)).toHaveLength(1);
    expect(result.messages.some((message) => message.id === userSupplement.id)).toBe(true);
    expect(result.stats.preservedLocalCount).toBe(1);
  });

  it('keeps different exact turns separate across a user supplement', () => {
    const earlierTurn = makeMessage({
      id: 'history-earlier-turn',
      origin: 'callback',
      content: 'earlier response',
      timestamp: 1_000,
      extra: makeStreamIdentity('turn-earlier'),
    });
    const userSupplement = makeMessage({
      id: 'user-new-turn',
      type: 'user',
      catId: undefined,
      content: 'start another turn',
      timestamp: 2_000,
    });
    const laterTurn = makeMessage({
      id: 'live-later-turn',
      origin: 'stream',
      content: 'later response',
      isStreaming: true,
      timestamp: 3_000,
      extra: makeStreamIdentity('turn-later'),
    });

    const result = mergeReplaceHydrationMessages([earlierTurn], [userSupplement, laterTurn], {});

    expect(assistantMessages(result.messages)).toHaveLength(2);
  });

  it('keeps parent-only legacy bubbles separate across a user supplement', () => {
    const earlierLegacyBubble = makeMessage({
      id: 'history-parent-only',
      origin: 'callback',
      content: 'earlier legacy response',
      timestamp: 1_000,
      extra: makeStreamIdentity(),
    });
    const userSupplement = makeMessage({
      id: 'user-legacy-boundary',
      type: 'user',
      catId: undefined,
      content: 'legacy boundary',
      timestamp: 2_000,
    });
    const laterLegacyBubble = makeMessage({
      id: 'live-parent-only',
      origin: 'stream',
      content: 'later legacy response',
      isStreaming: true,
      timestamp: 3_000,
      extra: makeStreamIdentity(),
    });

    const result = mergeReplaceHydrationMessages([earlierLegacyBubble], [userSupplement, laterLegacyBubble], {});

    expect(assistantMessages(result.messages)).toHaveLength(2);
  });
});
