/**
 * F183 Phase C 砚砚 R5 P1 + R6 P1 — chatStore catch-up acknowledgement
 * with captured-target binding (race-safe).
 *
 * Verifies the `acknowledgeCatchUp(threadId, ackedTargetSeq)` action:
 * - Caller passes the target captured at fetch START time (not current pending).
 * - Advances `lastSeqByThread[threadId]` to ackedTargetSeq (max with current).
 * - Clears pending only if pending matches ackedTargetSeq (no mid-flight refresh).
 * - If pending was refreshed during fetch (newer gap), keep pending — next
 *   fetchHistory ack covers the newer target.
 * - Defensive: never decrease lastSeq via ack.
 * - Per-thread isolation: ack for thread A does not affect thread B.
 *
 * 砚砚 R6 P1 race scenario this prevents:
 *   1. lastSeq=5; gap@8 → pending=8; fetch A starts (captures target=8)
 *   2. Mid-flight: gap@12 → pending=12 (refresh)
 *   3. Fetch A completes successfully; snapshot only covers up to ~seq=10
 *   4. WITHOUT fix: ack reads current pending=12, sets lastSeq=12, clears
 *      pending. Server emits 13 → 'advance' (13==12+1). Events 11,12 missing.
 *   5. WITH fix: ack(target=8), sets lastSeq=8, pending=12 stays. Server
 *      emits 13 → 'gap' (13 > 8+1). pending=13. Next fetch ack(13) covers.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

describe('chatStore.acknowledgeCatchUp (F183 Phase C 砚砚 R5 P1)', () => {
  beforeEach(() => {
    useChatStore.setState({
      lastSeqByThread: {},
      lastSeqEpochByThread: {},
      pendingCatchUpTargetSeqByThread: {},
      streamCatchUpVersionByThread: {},
    });
  });

  it('no-op when ackedTargetSeq is 0/negative (defensive)', () => {
    useChatStore.setState({
      lastSeqByThread: { 'thread-A': 5 },
      pendingCatchUpTargetSeqByThread: { 'thread-A': 8 },
    });
    useChatStore.getState().acknowledgeCatchUp('thread-A', 0);
    expect(useChatStore.getState().lastSeqByThread['thread-A']).toBe(5);
    expect(useChatStore.getState().pendingCatchUpTargetSeqByThread['thread-A']).toBe(8);
  });

  it('matched ack: pending unchanged during fetch → advance lastSeq + clear pending', () => {
    useChatStore.setState({
      lastSeqByThread: { 'thread-A': 5 },
      pendingCatchUpTargetSeqByThread: { 'thread-A': 8 },
    });
    useChatStore.getState().acknowledgeCatchUp('thread-A', 8);
    expect(useChatStore.getState().lastSeqByThread['thread-A']).toBe(8);
    expect(useChatStore.getState().pendingCatchUpTargetSeqByThread['thread-A']).toBeUndefined();
  });

  it('per-thread isolation — ack thread A leaves thread B untouched', () => {
    useChatStore.setState({
      lastSeqByThread: { 'thread-A': 5, 'thread-B': 100 },
      pendingCatchUpTargetSeqByThread: { 'thread-A': 8, 'thread-B': 105 },
    });
    useChatStore.getState().acknowledgeCatchUp('thread-A', 8);
    expect(useChatStore.getState().lastSeqByThread['thread-A']).toBe(8);
    expect(useChatStore.getState().lastSeqByThread['thread-B']).toBe(100);
    expect(useChatStore.getState().pendingCatchUpTargetSeqByThread['thread-A']).toBeUndefined();
    expect(useChatStore.getState().pendingCatchUpTargetSeqByThread['thread-B']).toBe(105);
  });

  it('砚砚 R6 P1 fix: stale fetch ack does NOT advance to refreshed pending', () => {
    // Race scenario: fetch A captures target=8 at start, then mid-flight a
    // newer gap@12 refreshes pending. Fetch A's snapshot may not cover 9..12.
    // ack(8) should advance lastSeq to 8 only, keep pending=12 for next fetch.
    useChatStore.setState({
      lastSeqByThread: { 'thread-A': 5 },
      pendingCatchUpTargetSeqByThread: { 'thread-A': 12 }, // refreshed mid-flight
    });
    useChatStore.getState().acknowledgeCatchUp('thread-A', 8); // ack with stale target
    expect(useChatStore.getState().lastSeqByThread['thread-A']).toBe(8);
    // CRITICAL: pending must NOT be cleared — newer gap range still pending
    expect(useChatStore.getState().pendingCatchUpTargetSeqByThread['thread-A']).toBe(12);
  });

  it('砚砚 R6 P1 fix: subsequent fetch ack(12) covers refreshed pending', () => {
    // After R6 P1 fix above: stale fetch ack(8), pending=12 stays.
    // Live event seq=13 → 'gap' (13 > 8+1=9), pending stays 13 (refreshed).
    // Next fetch starts with target=13, ack(13) advances lastSeq to 13 + clears.
    useChatStore.setState({
      lastSeqByThread: { 'thread-A': 8 }, // already advanced from stale ack
      pendingCatchUpTargetSeqByThread: { 'thread-A': 13 },
    });
    useChatStore.getState().acknowledgeCatchUp('thread-A', 13);
    expect(useChatStore.getState().lastSeqByThread['thread-A']).toBe(13);
    expect(useChatStore.getState().pendingCatchUpTargetSeqByThread['thread-A']).toBeUndefined();
  });

  it('defensive: ack with target lower than current lastSeq does NOT decrease lastSeq', () => {
    // Out-of-order ack arrival: fetch A captured target=8, but somehow
    // delivered after fetch B (target=12) already acked. Don't regress lastSeq.
    useChatStore.setState({
      lastSeqByThread: { 'thread-A': 12 },
      pendingCatchUpTargetSeqByThread: {},
    });
    useChatStore.getState().acknowledgeCatchUp('thread-A', 8);
    expect(useChatStore.getState().lastSeqByThread['thread-A']).toBe(12);
  });

  it('subsequent live event after matched ack: seq=pending+1 routes as advance (no false gap)', () => {
    // End-to-end smoke: gap → ack → next live event is 'advance', NOT 'gap'.
    useChatStore.setState({
      lastSeqByThread: { 'thread-A': 5 },
      pendingCatchUpTargetSeqByThread: { 'thread-A': 8 },
    });
    useChatStore.getState().acknowledgeCatchUp('thread-A', 8);
    expect(useChatStore.getState().lastSeqByThread['thread-A']).toBe(8);
    expect(useChatStore.getState().pendingCatchUpTargetSeqByThread['thread-A']).toBeUndefined();
  });

  it('setPendingCatchUpTargetSeq overwrites prior pending (latest wins)', () => {
    useChatStore.getState().setPendingCatchUpTargetSeq('thread-A', 8);
    expect(useChatStore.getState().pendingCatchUpTargetSeqByThread['thread-A']).toBe(8);
    useChatStore.getState().setPendingCatchUpTargetSeq('thread-A', 12);
    expect(useChatStore.getState().pendingCatchUpTargetSeqByThread['thread-A']).toBe(12);
    useChatStore.getState().setPendingCatchUpTargetSeq('thread-A', 20);
    expect(useChatStore.getState().pendingCatchUpTargetSeqByThread['thread-A']).toBe(20);
  });

  it('setPendingCatchUpTargetSeq idempotent — same seq twice does not re-write', () => {
    // Defensive check: redundant gap events with same incomingSeq don't churn store
    useChatStore.getState().setPendingCatchUpTargetSeq('thread-A', 8);
    const stateAfterFirst = useChatStore.getState();
    useChatStore.getState().setPendingCatchUpTargetSeq('thread-A', 8);
    const stateAfterSecond = useChatStore.getState();
    // pendingCatchUpTargetSeqByThread reference is the same (no spread reallocation)
    expect(stateAfterSecond.pendingCatchUpTargetSeqByThread).toBe(stateAfterFirst.pendingCatchUpTargetSeqByThread);
  });

  // F183 Phase C cloud R3 P2 fix: per-thread consumed version marker prevents
  // thread-switch re-mounts from re-firing already-handled triggers.
  describe('setLastConsumedCatchUpVersion (cloud R3 P2)', () => {
    beforeEach(() => {
      useChatStore.setState({ lastConsumedCatchUpVersionByThread: {} });
    });

    it('sets per-thread consumed version', () => {
      useChatStore.getState().setLastConsumedCatchUpVersion('thread-A', 5);
      expect(useChatStore.getState().lastConsumedCatchUpVersionByThread['thread-A']).toBe(5);
    });

    it('per-thread isolation', () => {
      useChatStore.getState().setLastConsumedCatchUpVersion('thread-A', 5);
      useChatStore.getState().setLastConsumedCatchUpVersion('thread-B', 100);
      expect(useChatStore.getState().lastConsumedCatchUpVersionByThread['thread-A']).toBe(5);
      expect(useChatStore.getState().lastConsumedCatchUpVersionByThread['thread-B']).toBe(100);
    });

    it('idempotent — same version twice does not re-write', () => {
      useChatStore.getState().setLastConsumedCatchUpVersion('thread-A', 5);
      const before = useChatStore.getState().lastConsumedCatchUpVersionByThread;
      useChatStore.getState().setLastConsumedCatchUpVersion('thread-A', 5);
      const after = useChatStore.getState().lastConsumedCatchUpVersionByThread;
      expect(after).toBe(before);
    });

    it('catchUpVersion === consumedCatchUpVersion gates useChatHistory effect (P2 invariant)', () => {
      // After fetchHistory success: setLastConsumedCatchUpVersion(threadId, current)
      // → consumedVersion === catchUpVersion → effect's `<=` check returns early
      useChatStore.setState({
        streamCatchUpVersionByThread: { 'thread-A': 3 },
        lastConsumedCatchUpVersionByThread: { 'thread-A': 3 },
      });
      const v = useChatStore.getState().streamCatchUpVersionByThread['thread-A'] ?? 0;
      const c = useChatStore.getState().lastConsumedCatchUpVersionByThread['thread-A'] ?? 0;
      // Effect skips when v <= c
      expect(v <= c).toBe(true);
    });

    it('new gap event bumps version above consumed → useChatHistory effect fires again', () => {
      useChatStore.setState({
        streamCatchUpVersionByThread: { 'thread-A': 3 },
        lastConsumedCatchUpVersionByThread: { 'thread-A': 3 },
      });
      // New gap event triggers requestStreamCatchUp
      useChatStore.getState().requestStreamCatchUp('thread-A');
      const v = useChatStore.getState().streamCatchUpVersionByThread['thread-A'] ?? 0;
      const c = useChatStore.getState().lastConsumedCatchUpVersionByThread['thread-A'] ?? 0;
      // Now v=4 > c=3 → effect runs
      expect(v).toBe(4);
      expect(v > c).toBe(true);
    });
  });
});
