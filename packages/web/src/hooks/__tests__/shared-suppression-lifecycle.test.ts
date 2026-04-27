/**
 * F173 A.12 — invocation-driven suppression cleanup invariants.
 *
 * 砚砚 round 5 review pinned two regression points:
 *   1) thread switch / non-queue send must NOT clear suppression for an in-flight
 *      invocation (codex round 2/4 case)
 *   2) invocationless stream must NOT be permanently dropped by an old suppression
 *      marker (codex round 3 case)
 *
 * Both surfaces (active = useAgentMessages, background = useAgentMessages) read
 * the same shared module Map; we exercise the background-handler path here because
 * it's the simpler integration point — the active-handler path goes through the
 * same shouldSuppressLateStreamChunk semantics with identical fail-open and
 * invocation-driven cleanup behavior.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { configureDebug } from '@/debug/invocationEventDebug';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import {
  getReplacedInvocation,
  markReplacedInvocation,
  resetSharedReplacedInvocations,
} from '../shared-replaced-invocations';
import { type BackgroundAgentMessage, handleBackgroundAgentMessage } from '../useAgentMessages';

let testBgSeq = 0;
const testBgStreamRefs = new Map<string, { id: string; threadId: string; catId: string }>();
const testBgFinalizedRefs = new Map<string, string>();

function dispatchBg(msg: BackgroundAgentMessage) {
  handleBackgroundAgentMessage(msg, {
    store: useChatStore.getState(),
    bgStreamRefs: testBgStreamRefs,
    finalizedBgRefs: testBgFinalizedRefs,
    nextBgSeq: () => testBgSeq++,
    addToast: () => {},
    clearDoneTimeout: () => {},
  });
}

describe('F173 A.12 — invocation-driven suppression cleanup', () => {
  beforeEach(() => {
    configureDebug({ enabled: false });
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
      activeInvocations: {},
      currentGame: null,
      threadStates: {},
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentThreadId: 'thread-active',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
    useToastStore.setState({ toasts: [] });
    testBgSeq = 0;
    testBgStreamRefs.clear();
    testBgFinalizedRefs.clear();
    resetSharedReplacedInvocations();
  });

  describe('Invariant 1: same-invocation suppression survives navigation', () => {
    it('marker for invocation X drops late stream chunk with same invocationId X', () => {
      markReplacedInvocation('thread-bg', 'opus', 'inv-1');

      // Late stream chunk with matching invocationId → must drop
      dispatchBg({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'late stream chunk that should be dropped',
        invocationId: 'inv-1',
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages.length).toBe(0);
      // Marker should still be there (suppression survives until invocation actually changes)
      expect(getReplacedInvocation('thread-bg', 'opus')).toBe('inv-1');
    });
  });

  describe('Invariant 2: per-invocation suppression (cloud P2 PR#1352 — multi-value)', () => {
    it('marker for invocation X stays — chunk with different invocation Y is independently un-suppressed', () => {
      // Cloud P2 update: storage is now Set<invocationId> per (thread, cat). Different
      // invocations are independent entries. Marker for inv-1 is NOT auto-cleared just
      // because inv-2 arrived; inv-2 simply isn't in the set so it passes through.
      // This preserves suppression for any other late inv-1 chunks that may follow.
      markReplacedInvocation('thread-bg', 'opus', 'inv-1');

      dispatchBg({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'new invocation legitimate output',
        invocationId: 'inv-2',
        timestamp: Date.now(),
      });

      // Marker for inv-1 is preserved (auto-clear-on-different is gone).
      expect(getReplacedInvocation('thread-bg', 'opus')).toBe('inv-1');
      // inv-2 message processed (new bubble created) — inv-2 isn't in the suppression set.
      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages.length).toBe(1);
    });
  });

  describe('Invariant 3: invocationless flow fail-open (codex round 3 P2)', () => {
    it('marker for invocation X does NOT drop chunk that has no invocationId (legacy /api/messages)', () => {
      markReplacedInvocation('thread-bg', 'opus', 'inv-1');

      dispatchBg({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'legacy invocationless message — must pass',
        // no invocationId
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages.length).toBe(1);
      expect(ts.messages[0].content).toBe('legacy invocationless message — must pass');
      // Marker survives (only invocation-driven cleanup or explicit stop clears it)
      expect(getReplacedInvocation('thread-bg', 'opus')).toBe('inv-1');
    });
  });

  describe('Invariant 4: cross-thread isolation', () => {
    it('marker for thread A does NOT affect thread B', () => {
      markReplacedInvocation('thread-a', 'opus', 'inv-1');

      dispatchBg({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-b',
        content: 'thread-b independent stream',
        invocationId: 'inv-1', // same invocationId but different thread
        timestamp: Date.now(),
      });

      const tsB = useChatStore.getState().getThreadState('thread-b');
      expect(tsB.messages.length).toBe(1);
      // thread-a's marker untouched
      expect(getReplacedInvocation('thread-a', 'opus')).toBe('inv-1');
    });
  });
});
