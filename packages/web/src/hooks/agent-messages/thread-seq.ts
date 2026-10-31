/**
 * F183 Phase C — thread-scoped sequence tracking + gap detection (KD-9).
 *
 * Pure function over the chat store: reads `lastSeqByThread` / `lastSeqEpochByThread`,
 * decides the action and writes back. Returns the action for diagnostics and tests.
 *
 * - seq absent / <= 0 → no-op (legacy producer, graceful degradation)
 * - epoch differs from the tracked one → server restart: reset lastSeq, record the pending
 *   target and request catch-up (砚砚 R1 P1)
 * - lastSeq 0 → seed, unless a catch-up is still pending (then keep firing 'gap')
 * - seq <= lastSeq → late (out-of-order / duplicate); callers decide what to do with it
 * - seq === lastSeq + 1 → advance
 * - seq > lastSeq + 1 → gap: record the pending target and request catch-up WITHOUT advancing
 *   lastSeq, so a failed fetch keeps retrying. useChatHistory acknowledges the captured target
 *   on success (`acknowledgeCatchUp`), which is what finally advances lastSeq.
 */
export type ThreadSeqAction = 'no-op' | 'seed' | 'advance' | 'late' | 'gap' | 'epoch-change';

export interface ThreadSeqStore {
  readonly lastSeqByThread: Record<string, number>;
  readonly lastSeqEpochByThread: Record<string, string>;
  /** Pending lookup detects an ongoing recovery in the seed branch (cloud R2 P1-B). */
  readonly pendingCatchUpTargetSeqByThread: Record<string, number>;
  setLastSeq: (threadId: string, seq: number) => void;
  setLastSeqEpoch: (threadId: string, epoch: string) => void;
  /** Pending target lets acknowledgeCatchUp advance lastSeq on success (砚砚 R5 P1). */
  setPendingCatchUpTargetSeq: (threadId: string, seq: number) => void;
  requestStreamCatchUp: (threadId: string) => void;
}

/** Server restart (sequencer epoch changed): reset the watermark and recover the new epoch's range. */
function restartEpoch(threadId: string, incomingSeq: number, incomingEpoch: string, store: ThreadSeqStore) {
  // Do not advance to incomingSeq before catch-up confirms (cloud R2 P1-B): the new epoch's
  // missing early range would otherwise sit behind the watermark forever.
  store.setLastSeqEpoch(threadId, incomingEpoch);
  store.setLastSeq(threadId, 0);
  store.setPendingCatchUpTargetSeq(threadId, incomingSeq);
  store.requestStreamCatchUp(threadId);
  return 'epoch-change' as const;
}

/** First seq-bearing event: seed — unless a recovery is still in flight, which keeps routing as 'gap'. */
function seedOrKeepRecovering(
  threadId: string,
  incomingSeq: number,
  incomingEpoch: string,
  store: ThreadSeqStore,
): ThreadSeqAction {
  const pendingTarget = store.pendingCatchUpTargetSeqByThread[threadId] ?? 0;
  if (pendingTarget > 0) {
    // Seeding would skip the missing range; only acknowledgeCatchUp closes the loop.
    if (incomingSeq > pendingTarget) store.setPendingCatchUpTargetSeq(threadId, incomingSeq);
    store.requestStreamCatchUp(threadId);
    return 'gap';
  }
  store.setLastSeq(threadId, incomingSeq);
  if (incomingEpoch) store.setLastSeqEpoch(threadId, incomingEpoch);
  return 'seed';
}

export function processThreadSeq(
  msg: { threadId?: string; seq?: number; seqEpoch?: string },
  store: ThreadSeqStore,
): ThreadSeqAction {
  const threadId = msg.threadId;
  const incomingSeq = msg.seq;
  if (!threadId || typeof incomingSeq !== 'number' || incomingSeq <= 0) return 'no-op';

  const lastSeq = store.lastSeqByThread[threadId] ?? 0;
  const lastEpoch = store.lastSeqEpochByThread[threadId] ?? '';
  const incomingEpoch = msg.seqEpoch ?? '';
  // Only a tracked epoch can change; a legacy emitter without an epoch falls through to seq-only logic.
  if (lastSeq > 0 && lastEpoch && incomingEpoch && lastEpoch !== incomingEpoch) {
    return restartEpoch(threadId, incomingSeq, incomingEpoch, store);
  }
  if (lastSeq === 0) return seedOrKeepRecovering(threadId, incomingSeq, incomingEpoch, store);
  if (incomingSeq <= lastSeq) return 'late';
  if (incomingSeq > lastSeq + 1) {
    // Gap: never advance optimistically (cloud P1) — a failed or canceled fetch must keep retrying.
    store.setPendingCatchUpTargetSeq(threadId, incomingSeq);
    store.requestStreamCatchUp(threadId);
    return 'gap';
  }
  store.setLastSeq(threadId, incomingSeq);
  return 'advance';
}
