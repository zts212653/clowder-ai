/**
 * F183 Phase C — thread-scoped sequence number tracking + gap detection (KD-9).
 *
 * `processThreadSeq` is the dispatch-level seq tracker that runs before
 * active/background routing in handleAgentMessage. Pure function over a store
 * shim — these tests verify state transitions without React harness.
 *
 * Decision tree:
 *   - msg.seq undefined / 0 → no-op (legacy producer)
 *   - msg.seq present, lastSeq=0 → seed (first event for thread)
 *   - msg.seq === lastSeq+1 → advance (monotonic)
 *   - msg.seq <= lastSeq → late (out-of-order; downstream handles dedup)
 *   - msg.seq > lastSeq+1 → gap (fire catchup, advance lastSeq to incomingSeq)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processThreadSeq } from '../useAgentMessages';

interface MockStore {
  lastSeqByThread: Record<string, number>;
  lastSeqEpochByThread: Record<string, string>;
  pendingCatchUpTargetSeqByThread: Record<string, number>;
  setLastSeq: (threadId: string, seq: number) => void;
  setLastSeqEpoch: (threadId: string, epoch: string) => void;
  setPendingCatchUpTargetSeq: (threadId: string, seq: number) => void;
  requestStreamCatchUp: (threadId: string) => void;
}

function makeStore(
  initial: Record<string, number> = {},
  initialEpoch: Record<string, string> = {},
  initialPending: Record<string, number> = {},
): MockStore & {
  setLastSeqMock: ReturnType<typeof vi.fn>;
  setLastSeqEpochMock: ReturnType<typeof vi.fn>;
  setPendingCatchUpTargetSeqMock: ReturnType<typeof vi.fn>;
  catchupMock: ReturnType<typeof vi.fn>;
} {
  const lastSeqByThread = { ...initial };
  const lastSeqEpochByThread = { ...initialEpoch };
  const pendingCatchUpTargetSeqByThread = { ...initialPending };
  const setLastSeqMock = vi.fn((threadId: string, seq: number) => {
    lastSeqByThread[threadId] = seq;
  });
  const setLastSeqEpochMock = vi.fn((threadId: string, epoch: string) => {
    lastSeqEpochByThread[threadId] = epoch;
  });
  const setPendingCatchUpTargetSeqMock = vi.fn((threadId: string, seq: number) => {
    pendingCatchUpTargetSeqByThread[threadId] = seq;
  });
  const catchupMock = vi.fn();
  return {
    lastSeqByThread,
    lastSeqEpochByThread,
    pendingCatchUpTargetSeqByThread,
    setLastSeq: setLastSeqMock,
    setLastSeqEpoch: setLastSeqEpochMock,
    setPendingCatchUpTargetSeq: setPendingCatchUpTargetSeqMock,
    requestStreamCatchUp: catchupMock,
    setLastSeqMock,
    setLastSeqEpochMock,
    setPendingCatchUpTargetSeqMock,
    catchupMock,
  };
}

describe('processThreadSeq (F183 Phase C — gap detection)', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  describe('no-op cases', () => {
    it('returns no-op when msg has no threadId', () => {
      const action = processThreadSeq({ seq: 1 }, store);
      expect(action).toBe('no-op');
      expect(store.setLastSeqMock).not.toHaveBeenCalled();
      expect(store.catchupMock).not.toHaveBeenCalled();
    });

    it('returns no-op when msg has no seq (legacy producer)', () => {
      const action = processThreadSeq({ threadId: 'thread-A' }, store);
      expect(action).toBe('no-op');
      expect(store.setLastSeqMock).not.toHaveBeenCalled();
    });

    it('returns no-op when seq=0 (sentinel for legacy/initial)', () => {
      const action = processThreadSeq({ threadId: 'thread-A', seq: 0 }, store);
      expect(action).toBe('no-op');
      expect(store.setLastSeqMock).not.toHaveBeenCalled();
    });

    it('returns no-op when seq is negative (defensive)', () => {
      const action = processThreadSeq({ threadId: 'thread-A', seq: -5 }, store);
      expect(action).toBe('no-op');
      expect(store.setLastSeqMock).not.toHaveBeenCalled();
    });
  });

  describe('seed (first event for thread)', () => {
    it('returns seed and writes lastSeq when threadId never seen', () => {
      const action = processThreadSeq({ threadId: 'thread-A', seq: 5 }, store);
      expect(action).toBe('seed');
      expect(store.setLastSeqMock).toHaveBeenCalledWith('thread-A', 5);
      expect(store.catchupMock).not.toHaveBeenCalled();
      expect(store.lastSeqByThread['thread-A']).toBe(5);
    });

    it('seeds lastSeq even when seq jumps from 0 to high (no gap detection at seed)', () => {
      // Rationale: at seed time we don't know prior history. Could be 100 events
      // missed, but we have no anchor. Server-side hydration handles initial load.
      const action = processThreadSeq({ threadId: 'thread-B', seq: 1000 }, store);
      expect(action).toBe('seed');
      expect(store.setLastSeqMock).toHaveBeenCalledWith('thread-B', 1000);
      expect(store.catchupMock).not.toHaveBeenCalled();
    });

    it('seeds independently for different threads', () => {
      processThreadSeq({ threadId: 'thread-A', seq: 5 }, store);
      processThreadSeq({ threadId: 'thread-B', seq: 100 }, store);
      expect(store.lastSeqByThread['thread-A']).toBe(5);
      expect(store.lastSeqByThread['thread-B']).toBe(100);
      expect(store.catchupMock).not.toHaveBeenCalled();
    });
  });

  describe('advance (monotonic)', () => {
    it('returns advance when seq=lastSeq+1', () => {
      store.lastSeqByThread['thread-A'] = 5;
      const action = processThreadSeq({ threadId: 'thread-A', seq: 6 }, store);
      expect(action).toBe('advance');
      expect(store.setLastSeqMock).toHaveBeenCalledWith('thread-A', 6);
      expect(store.catchupMock).not.toHaveBeenCalled();
    });

    it('handles long monotonic chain', () => {
      processThreadSeq({ threadId: 'thread-A', seq: 1 }, store); // seed
      for (let i = 2; i <= 50; i++) {
        const action = processThreadSeq({ threadId: 'thread-A', seq: i }, store);
        expect(action).toBe('advance');
      }
      expect(store.lastSeqByThread['thread-A']).toBe(50);
      expect(store.catchupMock).not.toHaveBeenCalled();
    });
  });

  describe('late (out-of-order or duplicate)', () => {
    it('returns late when seq < lastSeq', () => {
      store.lastSeqByThread['thread-A'] = 10;
      const action = processThreadSeq({ threadId: 'thread-A', seq: 7 }, store);
      expect(action).toBe('late');
      expect(store.setLastSeqMock).not.toHaveBeenCalled();
      expect(store.catchupMock).not.toHaveBeenCalled();
      // lastSeq UNCHANGED — preserves monotonicity invariant
      expect(store.lastSeqByThread['thread-A']).toBe(10);
    });

    it('returns late when seq === lastSeq (duplicate)', () => {
      store.lastSeqByThread['thread-A'] = 10;
      const action = processThreadSeq({ threadId: 'thread-A', seq: 10 }, store);
      expect(action).toBe('late');
      expect(store.setLastSeqMock).not.toHaveBeenCalled();
    });

    it('does not fire catchup on late (downstream dedup handles content)', () => {
      store.lastSeqByThread['thread-A'] = 10;
      processThreadSeq({ threadId: 'thread-A', seq: 5 }, store);
      expect(store.catchupMock).not.toHaveBeenCalled();
    });
  });

  describe('gap (catchup trigger) — cloud P1: preserve watermark', () => {
    it('returns gap and fires catchup when seq > lastSeq+1', () => {
      store.lastSeqByThread['thread-A'] = 5;
      const action = processThreadSeq({ threadId: 'thread-A', seq: 8 }, store);
      expect(action).toBe('gap');
      // Catchup is unconditional full fetch (no fromSeq parameter)
      expect(store.catchupMock).toHaveBeenCalledWith('thread-A');
    });

    it('cloud P1 fix: gap does NOT advance lastSeq (preserves watermark)', () => {
      store.lastSeqByThread['thread-A'] = 5;
      processThreadSeq({ threadId: 'thread-A', seq: 8 }, store);
      // Cloud P1: lastSeq STAYS at 5. If subsequent fetchHistory fails or is
      // canceled, the missing range is NOT behind the watermark — future
      // events still trigger 'gap' and re-fire requestStreamCatchUp.
      expect(store.setLastSeqMock).not.toHaveBeenCalled();
      expect(store.lastSeqByThread['thread-A']).toBe(5);
    });

    it('砚砚 R5 P1 fix: gap records pending target seq for acknowledgeCatchUp', () => {
      // Pending target lets useChatHistory's fetchHistory.then() advance lastSeq
      // to incomingSeq once HTTP catch-up succeeds. Without this, lastSeq stays
      // stuck forever (perpetual catchup storm).
      store.lastSeqByThread['thread-A'] = 5;
      processThreadSeq({ threadId: 'thread-A', seq: 8 }, store);
      expect(store.setPendingCatchUpTargetSeqMock).toHaveBeenCalledWith('thread-A', 8);
    });

    it('砚砚 R5 P1 fix: multiple gaps update pending to latest incomingSeq', () => {
      // Each new gap event refreshes pending target to its incomingSeq. When
      // catch-up finally succeeds, lastSeq advances to the latest pending
      // target — covers ALL pending gaps in one ack.
      store.lastSeqByThread['thread-A'] = 5;
      processThreadSeq({ threadId: 'thread-A', seq: 8 }, store); // pending=8
      processThreadSeq({ threadId: 'thread-A', seq: 12 }, store); // pending=12
      processThreadSeq({ threadId: 'thread-A', seq: 20 }, store); // pending=20
      expect(store.setPendingCatchUpTargetSeqMock).toHaveBeenNthCalledWith(1, 'thread-A', 8);
      expect(store.setPendingCatchUpTargetSeqMock).toHaveBeenNthCalledWith(2, 'thread-A', 12);
      expect(store.setPendingCatchUpTargetSeqMock).toHaveBeenNthCalledWith(3, 'thread-A', 20);
    });

    it('cloud P1 fix: subsequent events keep retriggering catchup until reseed', () => {
      // Watermark stays at 5; useChatHistory's 600ms timer cancel-restart
      // collapses these into one fetchHistory call after the stream settles.
      store.lastSeqByThread['thread-A'] = 5;
      const a1 = processThreadSeq({ threadId: 'thread-A', seq: 8 }, store);
      const a2 = processThreadSeq({ threadId: 'thread-A', seq: 9 }, store);
      const a3 = processThreadSeq({ threadId: 'thread-A', seq: 10 }, store);
      expect(a1).toBe('gap');
      expect(a2).toBe('gap');
      expect(a3).toBe('gap');
      // 3 catchup triggers (debounced downstream by useChatHistory)
      expect(store.catchupMock).toHaveBeenCalledTimes(3);
      // Watermark unchanged through the storm
      expect(store.lastSeqByThread['thread-A']).toBe(5);
      expect(store.setLastSeqMock).not.toHaveBeenCalled();
    });

    it('large gap fires single catchup', () => {
      store.lastSeqByThread['thread-A'] = 5;
      processThreadSeq({ threadId: 'thread-A', seq: 100 }, store);
      expect(store.catchupMock).toHaveBeenCalledTimes(1);
      expect(store.catchupMock).toHaveBeenCalledWith('thread-A');
    });

    it('multiple gaps fire multiple catchups (each new gap independent)', () => {
      store.lastSeqByThread['thread-A'] = 5;
      processThreadSeq({ threadId: 'thread-A', seq: 8 }, store); // gap at 6-7
      processThreadSeq({ threadId: 'thread-A', seq: 12 }, store); // still gap from 6
      expect(store.catchupMock).toHaveBeenCalledTimes(2);
      expect(store.catchupMock).toHaveBeenNthCalledWith(1, 'thread-A');
      expect(store.catchupMock).toHaveBeenNthCalledWith(2, 'thread-A');
    });

    it('cloud P1 fix: out-of-order replay events fill gap and advance watermark', () => {
      // With P1 fix: lastSeq stays at 5 on gap. If WebSocket somehow delivers
      // the missing seqs (e.g. transient out-of-order rather than true drop),
      // they advance normally — recovering the watermark.
      // Note: in production, catchup is HTTP fetch (doesn't go through
      // processThreadSeq), but processThreadSeq must handle the OOO case
      // correctly if it ever happens via WebSocket.
      store.lastSeqByThread['thread-A'] = 5;
      processThreadSeq({ threadId: 'thread-A', seq: 8 }, store); // gap, lastSeq stays 5
      const replay6 = processThreadSeq({ threadId: 'thread-A', seq: 6 }, store);
      const replay7 = processThreadSeq({ threadId: 'thread-A', seq: 7 }, store);
      // P1 fix: lastSeq=5 → 6 is advance (5+1), 7 is advance (6+1)
      expect(replay6).toBe('advance');
      expect(replay7).toBe('advance');
      expect(store.lastSeqByThread['thread-A']).toBe(7);
    });
  });

  // F183 Phase C 砚砚 R1 P1 fix: server restart resets seq, but client lastSeq
  // can be high — without epoch comparison, all incoming events route to 'late'
  // and gap detection silently breaks until server catches back up.
  describe('epoch-change (砚砚 R1 P1: server restart detection)', () => {
    it('cloud R2 P1-B fix: epoch-change resets lastSeq=0 + sets pending + fires catchup (no premature advance)', () => {
      // Setup: thread at lastSeq=500 with old epoch
      store.lastSeqByThread['thread-A'] = 500;
      store.lastSeqEpochByThread['thread-A'] = 'epoch-OLD';

      // Server restart → new epoch, first packet seq=5 (events 1-4 may have been dropped)
      const action = processThreadSeq({ threadId: 'thread-A', seq: 5, seqEpoch: 'epoch-NEW' }, store);

      expect(action).toBe('epoch-change');
      expect(store.setLastSeqEpochMock).toHaveBeenCalledWith('thread-A', 'epoch-NEW');
      // Cloud R2 P1-B: lastSeq resets to 0 (NOT incomingSeq) — new epoch space,
      // old watermark meaningless. Avoids premature advance before catchup ack.
      expect(store.setLastSeqMock).toHaveBeenCalledWith('thread-A', 0);
      // Pending recorded so acknowledgeCatchUp can advance lastSeq on success
      expect(store.setPendingCatchUpTargetSeqMock).toHaveBeenCalledWith('thread-A', 5);
      expect(store.catchupMock).toHaveBeenCalledWith('thread-A');
    });

    it('seed path captures epoch alongside seq when both present', () => {
      // First seq-bearing event for this thread
      const action = processThreadSeq({ threadId: 'thread-A', seq: 7, seqEpoch: 'epoch-A' }, store);
      expect(action).toBe('seed');
      expect(store.setLastSeqMock).toHaveBeenCalledWith('thread-A', 7);
      expect(store.setLastSeqEpochMock).toHaveBeenCalledWith('thread-A', 'epoch-A');
      // No catchup at seed (we don't know prior history exists)
      expect(store.catchupMock).not.toHaveBeenCalled();
    });

    it('does not trigger epoch-change when lastEpoch is empty (fresh start)', () => {
      // No prior epoch tracked → epoch-change rule doesn't fire; falls through
      // to seq-only logic. This avoids spurious catchups on first-ever event.
      store.lastSeqByThread['thread-A'] = 0;
      const action = processThreadSeq({ threadId: 'thread-A', seq: 1, seqEpoch: 'epoch-NEW' }, store);
      expect(action).toBe('seed');
      expect(store.catchupMock).not.toHaveBeenCalled();
    });

    it('does not trigger epoch-change when incomingEpoch is empty (legacy emitter)', () => {
      // Server emitter that doesn't include epoch field → fall through to
      // seq-only logic for graceful degradation (bw-compat).
      store.lastSeqByThread['thread-A'] = 5;
      store.lastSeqEpochByThread['thread-A'] = 'epoch-OLD';
      const action = processThreadSeq({ threadId: 'thread-A', seq: 6 }, store);
      expect(action).toBe('advance');
      expect(store.setLastSeqMock).toHaveBeenCalledWith('thread-A', 6);
      // Old epoch preserved (we don't clear it on legacy events)
      expect(store.setLastSeqEpochMock).not.toHaveBeenCalled();
      expect(store.catchupMock).not.toHaveBeenCalled();
    });

    it('does not trigger epoch-change when same epoch + monotonic advance', () => {
      store.lastSeqByThread['thread-A'] = 5;
      store.lastSeqEpochByThread['thread-A'] = 'epoch-A';
      const action = processThreadSeq({ threadId: 'thread-A', seq: 6, seqEpoch: 'epoch-A' }, store);
      expect(action).toBe('advance');
      expect(store.catchupMock).not.toHaveBeenCalled();
    });

    it('cloud R2 P1-B fix: after epoch-change, subsequent events route as gap (pending recovery in progress)', () => {
      // After epoch-change with pending=incomingSeq: until ack closes the loop,
      // ALL incoming events route as 'gap' to keep retriggering catchup.
      // This ensures missed early range eventually gets fetched even if
      // initial catchup transient-failed.
      store.lastSeqByThread['thread-A'] = 500;
      store.lastSeqEpochByThread['thread-A'] = 'epoch-OLD';
      processThreadSeq({ threadId: 'thread-A', seq: 1, seqEpoch: 'epoch-NEW' }, store); // epoch-change
      // After epoch-change: lastSeq=0, pending=1.
      const a2 = processThreadSeq({ threadId: 'thread-A', seq: 2, seqEpoch: 'epoch-NEW' }, store);
      const a3 = processThreadSeq({ threadId: 'thread-A', seq: 3, seqEpoch: 'epoch-NEW' }, store);
      // Cloud R2 P1-B: events go 'gap' (lastSeq=0 + pending>0 path), not 'advance'
      expect(a2).toBe('gap');
      expect(a3).toBe('gap');
      // Each event refires catchup → 1 (epoch-change) + 2 (gap) = 3 calls
      // (debounced by useChatHistory's 600ms timer to single fetchHistory in practice)
      expect(store.catchupMock).toHaveBeenCalledTimes(3);
      // Pending refreshes to latest incomingSeq for ack target
      expect(store.setPendingCatchUpTargetSeqMock).toHaveBeenLastCalledWith('thread-A', 3);
    });

    it('cloud R2 P1-B fix: after epoch-change + ack clears pending, subsequent events advance normally', () => {
      // Simulates: epoch-change sets pending=1, lastSeq=0; HTTP fetchHistory
      // succeeds; acknowledgeCatchUp advances lastSeq + clears pending; then
      // live events route normally (advance / gap based on new-epoch monotonicity).
      store.lastSeqByThread['thread-A'] = 0;
      store.lastSeqEpochByThread['thread-A'] = 'epoch-NEW';
      // pending was cleared by ack — simulate post-ack state
      store.lastSeqByThread['thread-A'] = 1; // ack advanced to pending target
      // Pending CLEARED (not in pendingCatchUpTargetSeqByThread)
      const a2 = processThreadSeq({ threadId: 'thread-A', seq: 2, seqEpoch: 'epoch-NEW' }, store);
      const a3 = processThreadSeq({ threadId: 'thread-A', seq: 3, seqEpoch: 'epoch-NEW' }, store);
      expect(a2).toBe('advance');
      expect(a3).toBe('advance');
      // No catchup — recovery already complete
      expect(store.catchupMock).not.toHaveBeenCalled();
    });

    it('cloud R2 P1-B fix: gap during pending recovery refreshes pending to higher value', () => {
      // Setup: post-epoch-change state with pending=5
      store.lastSeqByThread['thread-A'] = 0;
      store.lastSeqEpochByThread['thread-A'] = 'epoch-NEW';
      store.pendingCatchUpTargetSeqByThread['thread-A'] = 5;

      // New event seq=10 arrives: should refresh pending to 10
      const action = processThreadSeq({ threadId: 'thread-A', seq: 10, seqEpoch: 'epoch-NEW' }, store);
      expect(action).toBe('gap');
      expect(store.setPendingCatchUpTargetSeqMock).toHaveBeenCalledWith('thread-A', 10);
    });

    it('cloud R2 P1-B fix: incoming seq lower than pending does NOT decrease pending', () => {
      // Pending=10, new event seq=7 arrives (out-of-order or dup)
      store.lastSeqByThread['thread-A'] = 0;
      store.lastSeqEpochByThread['thread-A'] = 'epoch-NEW';
      store.pendingCatchUpTargetSeqByThread['thread-A'] = 10;

      const action = processThreadSeq({ threadId: 'thread-A', seq: 7, seqEpoch: 'epoch-NEW' }, store);
      expect(action).toBe('gap');
      // pending NOT updated (7 < 10) — preserves higher target
      expect(store.setPendingCatchUpTargetSeqMock).not.toHaveBeenCalled();
      expect(store.catchupMock).toHaveBeenCalledTimes(1); // still refires catchup
    });
  });

  describe('cross-thread isolation', () => {
    it('thread A gap does not affect thread B lastSeq', () => {
      store.lastSeqByThread['thread-A'] = 5;
      store.lastSeqByThread['thread-B'] = 100;
      processThreadSeq({ threadId: 'thread-A', seq: 10 }, store); // gap (P1 fix: no advance)
      // Cloud P1: gap preserves watermark
      expect(store.lastSeqByThread['thread-A']).toBe(5);
      expect(store.lastSeqByThread['thread-B']).toBe(100);
      expect(store.catchupMock).toHaveBeenCalledWith('thread-A');
    });

    it('thread A and thread B can have overlapping seq values without confusion', () => {
      processThreadSeq({ threadId: 'thread-A', seq: 1 }, store);
      processThreadSeq({ threadId: 'thread-B', seq: 1 }, store);
      processThreadSeq({ threadId: 'thread-A', seq: 2 }, store);
      processThreadSeq({ threadId: 'thread-B', seq: 2 }, store);
      // Both threads at seq=2; no gap; no catchup
      expect(store.lastSeqByThread['thread-A']).toBe(2);
      expect(store.lastSeqByThread['thread-B']).toBe(2);
      expect(store.catchupMock).not.toHaveBeenCalled();
    });
  });
});
