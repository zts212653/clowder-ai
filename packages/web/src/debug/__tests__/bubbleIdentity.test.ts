import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import {
  describeBubbleIdentity,
  getBubbleIdentityKey,
  getBubbleInvocationId,
  shouldForceReplaceHydrationForCachedMessages,
} from '../bubbleIdentity';

function makeAssistantMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg-1',
    type: 'assistant',
    catId: 'opus',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('bubbleIdentity', () => {
  it('extracts invocationId from extra.stream first', () => {
    const msg = makeAssistantMessage({
      extra: { stream: { invocationId: 'inv-1' } },
    });

    expect(getBubbleInvocationId(msg)).toBe('inv-1');
  });

  it('falls back to draft message id for invocationId', () => {
    const msg = makeAssistantMessage({
      id: 'draft-inv-2',
      isStreaming: false,
    });

    expect(getBubbleInvocationId(msg)).toBe('inv-2');
  });

  it('builds identity key from catId and invocationId', () => {
    const msg = makeAssistantMessage({
      catId: 'codex',
      extra: { stream: { invocationId: 'inv-3' } },
    });

    expect(getBubbleIdentityKey(msg)).toBe('codex:inv-3:text');
  });

  it('treats duplicate same-invocation assistant bubbles as unstable cached identity', () => {
    const messages: ChatMessage[] = [
      makeAssistantMessage({
        id: 'stream-1',
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-4' } },
      }),
      makeAssistantMessage({
        id: 'callback-1',
        origin: 'callback',
        extra: { stream: { invocationId: 'inv-4' } },
      }),
    ];

    expect(shouldForceReplaceHydrationForCachedMessages(messages)).toBe(true);
  });

  it('treats local draft or streaming bubbles as unstable cached identity', () => {
    const messages: ChatMessage[] = [
      makeAssistantMessage({
        id: 'draft-inv-5',
        isStreaming: false,
      }),
    ];

    expect(shouldForceReplaceHydrationForCachedMessages(messages)).toBe(true);
  });

  it('does not force replace hydration for stable cached history', () => {
    const messages: ChatMessage[] = [
      makeAssistantMessage({
        id: 'server-1',
        origin: 'callback',
        extra: { stream: { invocationId: 'inv-6' } },
      }),
    ];

    expect(shouldForceReplaceHydrationForCachedMessages(messages)).toBe(false);
  });

  it('describes draft bubbles as local text identities', () => {
    const msg = makeAssistantMessage({
      id: 'draft-inv-7',
      content: 'draft reply',
      isStreaming: false,
    });

    expect(describeBubbleIdentity(msg)).toEqual({
      bubbleKind: 'text',
      catId: 'opus',
      invocationId: 'inv-7',
      isAuthoritative: false,
      isLocalOnly: true,
      isUnstable: true,
      originPhase: 'draft',
      key: 'opus:inv-7:text',
    });
  });

  // F194 Phase Z3 (砚砚 catch 2026-05-09 17:32 — bubble identity uses parent id 合并 same-cat multi-turn)
  describe('F194 Phase Z3: dual id (parent vs turn) — turnInvocationId 优先', () => {
    it('prefers turnInvocationId over invocationId (parent) — same parent + same cat 多 turn 不合并', () => {
      const parentId = 'parent-chain-1';
      const opusTurn1 = makeAssistantMessage({
        id: 'msg-opus-1',
        catId: 'opus',
        extra: {
          stream: {
            invocationId: parentId,
            turnInvocationId: 'turn-opus-1',
          },
        },
      });
      const opusTurn3 = makeAssistantMessage({
        id: 'msg-opus-3',
        catId: 'opus',
        extra: {
          stream: {
            invocationId: parentId,
            turnInvocationId: 'turn-opus-3',
          },
        },
      });

      expect(getBubbleInvocationId(opusTurn1)).toBe('turn-opus-1');
      expect(getBubbleInvocationId(opusTurn3)).toBe('turn-opus-3');
      expect(getBubbleIdentityKey(opusTurn1)).not.toBe(getBubbleIdentityKey(opusTurn3));
    });

    it('falls back to invocationId (parent) when turnInvocationId absent — legacy compat', () => {
      const legacyMsg = makeAssistantMessage({
        extra: { stream: { invocationId: 'legacy-parent-id' } },
      });
      expect(getBubbleInvocationId(legacyMsg)).toBe('legacy-parent-id');
    });

    it('describeBubbleIdentity uses turnInvocationId in key (not parent)', () => {
      const msg = makeAssistantMessage({
        id: 'msg-z3-describe',
        catId: 'opus',
        extra: {
          stream: {
            invocationId: 'parent-z3',
            turnInvocationId: 'turn-z3',
          },
        },
      });
      const desc = describeBubbleIdentity(msg);
      expect(desc.invocationId).toBe('turn-z3');
      expect(desc.key).toBe('opus:turn-z3:text');
    });
  });

  it('describes callback history bubbles as authoritative text identities', () => {
    const msg = makeAssistantMessage({
      id: 'callback-2',
      origin: 'callback',
      deliveredAt: 123,
      extra: { stream: { invocationId: 'inv-8' } },
    });

    expect(describeBubbleIdentity(msg)).toEqual({
      bubbleKind: 'text',
      catId: 'opus',
      invocationId: 'inv-8',
      isAuthoritative: true,
      isLocalOnly: false,
      isUnstable: false,
      originPhase: 'callback',
      key: 'opus:inv-8:text',
    });
  });
});
