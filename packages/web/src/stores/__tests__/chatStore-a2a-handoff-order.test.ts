/**
 * F173 a2a-handoff bug fix: timestamp-aware insert for a2a_routing system
 * messages. Covers both active-thread (addMessage) and background-thread
 * (addMessageToThread) paths.
 *
 * Bug repro: 缅因猫 → 布偶猫 routing pill arrives over WebSocket AFTER the
 * next cat's stream bubble already entered the store. Without timestamp-aware
 * insert, the pill appends to the end, showing up visually after the bubble
 * it should precede.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat-types';
import { useChatStore } from '../chatStore';

function makeUserMsg(id: string, ts: number, content = 'hi'): ChatMessage {
  return { id, type: 'user', content, timestamp: ts };
}

function makeAssistantMsg(id: string, catId: string, ts: number): ChatMessage {
  return { id, type: 'assistant', catId, content: 'response', timestamp: ts };
}

function makeA2AHandoffMsg(id: string, ts: number, content = '缅因猫 → 布偶猫'): ChatMessage {
  return {
    id,
    type: 'system',
    variant: 'info',
    content,
    timestamp: ts,
    extra: { systemKind: 'a2a_routing' },
  };
}

const INITIAL_FLAT_STATE = {
  messages: [],
  isLoading: false,
  isLoadingHistory: false,
  hasMore: true,
  hasActiveInvocation: false,
  hasDraft: false,
  intentMode: null,
  targetCats: [],
  catStatuses: {},
  catInvocations: {},
  currentGame: null,
  threadStates: {},
  viewMode: 'single' as const,
  splitPaneThreadIds: [],
  splitPaneTargetId: null,
  currentThreadId: 'thread-a',
  currentProjectPath: 'default',
  threads: [],
  isLoadingThreads: false,
};

describe('chatStore a2a_handoff timestamp-aware insert (F173 bug fix)', () => {
  beforeEach(() => {
    useChatStore.setState(INITIAL_FLAT_STATE);
  });

  afterEach(() => {
    useChatStore.setState(INITIAL_FLAT_STATE);
  });

  it('addMessage: a2a_routing arrives late, inserts at correct position not appended', () => {
    // Simulate bug: codex stream bubble (ts=200) already appended,
    // a2a_handoff pill (server ts=150) arrives later.
    useChatStore.getState().addMessage(makeUserMsg('user-1', 100));
    useChatStore.getState().addMessage(makeAssistantMsg('codex-1', 'codex', 200));
    useChatStore.getState().addMessage(makeA2AHandoffMsg('handoff-late', 150));

    const ids = useChatStore.getState().messages.map((m) => m.id);
    // Correct: handoff-late (ts=150) inserted between user-1 (100) and codex-1 (200)
    expect(ids).toEqual(['user-1', 'handoff-late', 'codex-1']);
  });

  it('addMessage: a2a_routing without late arrival appends normally', () => {
    useChatStore.getState().addMessage(makeUserMsg('user-1', 100));
    useChatStore.getState().addMessage(makeAssistantMsg('codex-1', 'codex', 200));
    useChatStore.getState().addMessage(makeA2AHandoffMsg('handoff', 250));

    const ids = useChatStore.getState().messages.map((m) => m.id);
    expect(ids).toEqual(['user-1', 'codex-1', 'handoff']);
  });

  it('addMessage: regular assistant messages are NOT touched by insert (preserves streaming hot path)', () => {
    // Late assistant should still append; we only timestamp-insert a2a_routing.
    useChatStore.getState().addMessage(makeUserMsg('user-1', 100));
    useChatStore.getState().addMessage(makeAssistantMsg('opus-1', 'opus', 300));
    useChatStore.getState().addMessage(makeAssistantMsg('codex-1', 'codex', 200));

    const ids = useChatStore.getState().messages.map((m) => m.id);
    // codex-1 still appended at end (preserves streaming append behavior).
    expect(ids).toEqual(['user-1', 'opus-1', 'codex-1']);
  });

  it('addMessage: a2a_routing newer than all existing inserts at end', () => {
    useChatStore.getState().addMessage(makeUserMsg('user-1', 100));
    useChatStore.getState().addMessage(makeAssistantMsg('codex-1', 'codex', 200));
    useChatStore.getState().addMessage(makeA2AHandoffMsg('handoff-newer', 999));

    const ids = useChatStore.getState().messages.map((m) => m.id);
    expect(ids).toEqual(['user-1', 'codex-1', 'handoff-newer']);
  });

  it('addMessage: a2a_routing older than all existing inserts at front', () => {
    useChatStore.getState().addMessage(makeUserMsg('user-1', 100));
    useChatStore.getState().addMessage(makeAssistantMsg('codex-1', 'codex', 200));
    useChatStore.getState().addMessage(makeA2AHandoffMsg('handoff-oldest', 50));

    const ids = useChatStore.getState().messages.map((m) => m.id);
    expect(ids).toEqual(['handoff-oldest', 'user-1', 'codex-1']);
  });

  it('R2 P2-1: a2a_routing equal timestamp inserts BEFORE the bubble (routing precedes)', () => {
    // Cloud Codex P2: when handoff & next bubble share same ms (fast back-to-back),
    // routing should bias earlier (semantically routing happens first).
    useChatStore.getState().addMessage(makeUserMsg('user-1', 100));
    useChatStore.getState().addMessage(makeAssistantMsg('codex-1', 'codex', 200));
    // Handoff with EQUAL timestamp 200 — must insert BEFORE codex-1, not after
    useChatStore.getState().addMessage(makeA2AHandoffMsg('handoff-equal', 200));

    const ids = useChatStore.getState().messages.map((m) => m.id);
    expect(ids).toEqual(['user-1', 'handoff-equal', 'codex-1']);
  });

  it('R2 P2-2: two same-ms handoff messages with different IDs both retained (no dedup loss)', () => {
    // Cloud Codex P2: foreground id was `a2a-${ts}-${catId}` → same-ms cat handoff
    // collided on addMessage's id-based dedup. Now id includes a monotonic suffix.
    useChatStore.getState().addMessage(makeUserMsg('user-1', 100));
    useChatStore.getState().addMessage(makeAssistantMsg('codex-1', 'codex', 200));
    // Two handoffs sharing same ts=150 must both make it into store.
    useChatStore.getState().addMessage(makeA2AHandoffMsg('a2a-150-codex-1', 150));
    useChatStore.getState().addMessage(makeA2AHandoffMsg('a2a-150-codex-2', 150));

    const ids = useChatStore.getState().messages.map((m) => m.id);
    expect(ids).toContain('a2a-150-codex-1');
    expect(ids).toContain('a2a-150-codex-2');
    // Both must be ordered before codex-1 (ts=200)
    const codexIdx = ids.indexOf('codex-1');
    expect(ids.indexOf('a2a-150-codex-1')).toBeLessThan(codexIdx);
    expect(ids.indexOf('a2a-150-codex-2')).toBeLessThan(codexIdx);
  });

  it('R3 P2 (砚砚): same-ts handoffs preserve arrival order (multi-target backend yield)', () => {
    // 砚砚 R2 P2: backend yields handoff1 → handoff2 to multiple targets in
    // same ms. Visual order must match emit order: handoff1 BEFORE handoff2.
    // Earlier strict-< from-end scan reversed them.
    useChatStore.getState().addMessage(makeUserMsg('user-1', 100));
    useChatStore.getState().addMessage(makeAssistantMsg('codex-1', 'codex', 200));
    useChatStore.getState().addMessage(makeA2AHandoffMsg('handoff-first', 150, '布偶猫 → 缅因猫'));
    useChatStore.getState().addMessage(makeA2AHandoffMsg('handoff-second', 150, '布偶猫 → 暹罗猫'));

    const ids = useChatStore.getState().messages.map((m) => m.id);
    expect(ids).toEqual(['user-1', 'handoff-first', 'handoff-second', 'codex-1']);
  });

  it('addMessageToThread: background path also inserts a2a_routing by timestamp', () => {
    // Use a non-current thread so we hit the background branch.
    useChatStore.getState().addMessageToThread('thread-bg', makeUserMsg('user-1', 100));
    useChatStore.getState().addMessageToThread('thread-bg', makeAssistantMsg('codex-1', 'codex', 200));
    useChatStore.getState().addMessageToThread('thread-bg', makeA2AHandoffMsg('handoff-late', 150));

    const ids = useChatStore.getState().threadStates['thread-bg']?.messages.map((m) => m.id) ?? [];
    expect(ids).toEqual(['user-1', 'handoff-late', 'codex-1']);
  });
});
