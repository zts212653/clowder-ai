/**
 * F183 Phase E AC-E2 — chatStore mutation path coverage audit.
 *
 * 砚砚 R1 P1 → R2 P1 closure: writers gated end-to-end. Three layers:
 *   1. Pre-set TD112 in-store dedup (addMessage / addMessageToThread)
 *   2. Pre-set strict-mode runtime gate (replaceMessages /
 *      replaceThreadMessages / hydrateThread via
 *      `forwardStoreInvariantViolationsStrict`) — strict OFF = no-op,
 *      strict ON = scan + throw before set() so bad state never lands
 *   3. Reducer-driven paths additionally forward violations from
 *      `applyBubbleEvent` results to `recordBubbleInvariantViolation`
 *      in useAgentMessages.ts (existing wire-up)
 *
 * COVERAGE TABLE (chatStore.ts mutation entry → invariant gating):
 *
 * | Entry                     | Gating mechanism                                   | Status |
 * |---------------------------|----------------------------------------------------|--------|
 * | addMessage                | TD112 dedup (findAssistantDuplicate, line ~1330)   | ✓ in-store |
 * | addMessageToThread        | TD112 dedup (line ~1932)                            | ✓ in-store |
 * | replaceMessages           | Pre-set strict gate (forwardStoreInvariantViolationsStrict) | ✓ writer-self |
 * | replaceThreadMessages     | Pre-set strict gate (same, runs before current/bg branch split) | ✓ writer-self |
 * | hydrateThread             | Pre-set strict gate (after merge, before set())     | ✓ writer-self |
 * | prependHistory            | Caller-driven (history fetch payload trusted)       | ✓ caller |
 * | replaceMessageId          | Id swap (cannot create new identity)                | N/A |
 * | patchMessage              | Patches existing msg (no new bubble)                | N/A |
 * | appendToMessage           | Appends content (no new bubble)                     | N/A |
 * | removeMessage             | Removes (cannot create duplicate)                   | N/A |
 * | clearMessages             | Empties (cannot create duplicate)                   | N/A |
 *
 * "writer-self" gate fires under strict mode (BUBBLE_INVARIANT_STRICT=1 /
 * NEXT_PUBLIC_BUBBLE_INVARIANT_STRICT=1 / localStorage flag) and is a
 * 1-instruction early-out otherwise — zero cost in production default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findBubbleStoreInvariantViolations } from '@/stores/bubble-invariants';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

function makeBubble(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm-test',
    type: 'assistant',
    catId: 'opus',
    content: 'streaming',
    timestamp: 1,
    origin: 'stream',
    extra: { stream: { invocationId: 'inv-test' } },
    ...overrides,
  };
}

describe('F183 Phase E AC-E2 — chatStore mutation path invariant coverage', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // addMessage: TD112 dedup must keep the store free of duplicate stable identity
  // even when the caller blindly pushes a second bubble for the same invocation.
  it('addMessage: TD112 dedup prevents duplicate stable identity from landing', () => {
    useChatStore.setState({
      messages: [],
      currentThreadId: 'thread-A',
    });
    const first = makeBubble({ id: 'msg-stream', origin: 'stream', content: 'first' });
    const second = makeBubble({ id: 'msg-callback', origin: 'callback', content: 'callback' });
    useChatStore.getState().addMessage(first);
    useChatStore.getState().addMessage(second);
    const state = useChatStore.getState();
    const violations = findBubbleStoreInvariantViolations(state.messages, {
      threadId: 'thread-A',
      eventType: 'callback_final',
      sourcePath: 'callback',
    });
    expect(violations).toHaveLength(0);
    // TD112 dedup either merged in place or filtered — either way, no duplicate
    // stable identity in store.
  });

  // addMessageToThread (active thread): TD112 dedup applies the same way.
  it('addMessageToThread (active thread): TD112 dedup prevents duplicate stable identity', () => {
    useChatStore.setState({
      messages: [],
      currentThreadId: 'thread-A',
    });
    const first = makeBubble({ id: 'msg-bg-1', origin: 'stream', content: 'bg first' });
    const second = makeBubble({ id: 'msg-bg-2', origin: 'callback', content: 'bg callback' });
    useChatStore.getState().addMessageToThread('thread-A', first);
    useChatStore.getState().addMessageToThread('thread-A', second);
    const state = useChatStore.getState();
    const violations = findBubbleStoreInvariantViolations(state.messages, {
      threadId: 'thread-A',
      eventType: 'callback_final',
      sourcePath: 'callback',
    });
    expect(violations).toHaveLength(0);
  });

  // replaceMessages: caller-driven; if a buggy caller passes duplicates, the
  // post-mutation invariant check (which production wires from useAgentMessages)
  // detects them. Test proves the detection works on the resulting state.
  it('replaceMessages: caller-driven path; post-mutation invariant catches duplicate identity', () => {
    useChatStore.setState({ messages: [], currentThreadId: 'thread-A' });
    // Simulate a buggy caller that didn't run reducer dedup
    const dup1 = makeBubble({ id: 'msg-stream', origin: 'stream' });
    const dup2 = makeBubble({ id: 'msg-callback', origin: 'callback' });
    useChatStore.getState().replaceMessages([dup1, dup2], false);
    const state = useChatStore.getState();
    const violations = findBubbleStoreInvariantViolations(state.messages, {
      threadId: 'thread-A',
      eventType: 'history_hydrate',
      sourcePath: 'hydration',
    });
    // replaceMessages does NOT auto-dedup (caller responsibility); under
    // strict mode the writer-self gate (forwardStoreInvariantViolationsStrict)
    // throws before set() lands — see strict-mode regression tests below.
    // Under prod default (strict OFF) the bad state lands and detection is
    // up to the caller / outer reducer wire-up.
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      violationKind: 'duplicate',
      threadId: 'thread-A',
      actorId: 'opus',
      canonicalInvocationId: 'inv-test',
      bubbleKind: 'assistant_text',
    });
  });

  // hydrateThread: writer mirrors replaceMessages then saves IDB; same caller
  // contract. Verify violations on the resulting state are detectable.
  it('hydrateThread: writer mirror; post-mutation invariant catches duplicate identity', () => {
    useChatStore.setState({ messages: [], currentThreadId: 'thread-A' });
    const dup1 = makeBubble({ id: 'msg-stream', origin: 'stream' });
    const dup2 = makeBubble({ id: 'msg-callback', origin: 'callback' });
    useChatStore.getState().hydrateThread('thread-A', [dup1, dup2], false);
    const state = useChatStore.getState();
    const violations = findBubbleStoreInvariantViolations(state.messages, {
      threadId: 'thread-A',
      eventType: 'history_hydrate',
      sourcePath: 'hydration',
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  // 砚砚 R2 P1 closure — these tests prove the chatStore writers actively
  // throw under strict mode when caller passes input that would land
  // duplicate stable identity. This is the runtime gate (not just "test
  // can detect afterward") that AC-E2 requires.
  describe('砚砚 R2 P1: strict-mode runtime gate on caller-driven writers', () => {
    it('replaceMessages throws under BUBBLE_INVARIANT_STRICT=1 when input has duplicate identity', () => {
      vi.stubEnv('BUBBLE_INVARIANT_STRICT', '1');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      useChatStore.setState({ messages: [], currentThreadId: 'thread-A' });
      const dup1 = makeBubble({ id: 'msg-stream', origin: 'stream' });
      const dup2 = makeBubble({ id: 'msg-callback', origin: 'callback' });
      expect(() => useChatStore.getState().replaceMessages([dup1, dup2], false)).toThrow(/bubble invariant violation/);
    });

    it('replaceThreadMessages throws under strict mode for current thread', () => {
      vi.stubEnv('BUBBLE_INVARIANT_STRICT', '1');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      useChatStore.setState({ messages: [], currentThreadId: 'thread-A' });
      const dup1 = makeBubble({ id: 'msg-stream', origin: 'stream' });
      const dup2 = makeBubble({ id: 'msg-callback', origin: 'callback' });
      expect(() => useChatStore.getState().replaceThreadMessages('thread-A', [dup1, dup2], false)).toThrow(
        /bubble invariant violation/,
      );
    });

    it('hydrateThread throws under strict mode when input has duplicate identity', () => {
      vi.stubEnv('BUBBLE_INVARIANT_STRICT', '1');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      useChatStore.setState({ messages: [], currentThreadId: 'thread-A' });
      const dup1 = makeBubble({ id: 'msg-stream', origin: 'stream' });
      const dup2 = makeBubble({ id: 'msg-callback', origin: 'callback' });
      expect(() => useChatStore.getState().hydrateThread('thread-A', [dup1, dup2], false)).toThrow(
        /bubble invariant violation/,
      );
    });

    it('strict OFF (default): writers do NOT throw on duplicate input (prod default)', () => {
      // No stubEnv — strict is off
      useChatStore.setState({ messages: [], currentThreadId: 'thread-A' });
      const dup1 = makeBubble({ id: 'msg-stream', origin: 'stream' });
      const dup2 = makeBubble({ id: 'msg-callback', origin: 'callback' });
      expect(() => useChatStore.getState().replaceMessages([dup1, dup2], false)).not.toThrow();
    });
  });
});
