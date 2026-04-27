/**
 * F173 Phase B AC-B1: thread-scoped runtime ledger pure tests.
 *
 * Ledger is the per-thread, runtime-only state container that replaces the
 * scattered top-level Maps in useAgentMessages.ts (active/finalized/replaced/
 * sawStreamData/pendingTimeoutDiag/timeoutHandle/lastObservedExplicitInvocationId).
 *
 * These are PURE tests — no React, no zustand, no socket. The ledger is a
 * standalone module with explicit ownership and TTL semantics.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearActiveBubble,
  clearFinalized,
  clearStreamData,
  createThreadRuntimeLedger,
  decideTerminalEventTarget,
  evictExpiredReplaced,
  getActiveBubble,
  getFinalizedMessageId,
  getLastObservedExplicit,
  hadStreamData,
  hasThread,
  isInvocationReplaced,
  markExplicitInvocationObserved,
  markInvocationReplaced,
  markStreamData,
  removeThread,
  setActiveBubble,
  setFinalizedBubble,
  sweepIdleThreads,
  type ThreadRuntimeLedger,
} from '../thread-runtime-ledger';

describe('F173 Phase B: ThreadRuntimeLedger — getOrCreate', () => {
  let ledger: ThreadRuntimeLedger;

  beforeEach(() => {
    ledger = createThreadRuntimeLedger();
  });

  it('returns a fresh entry for an unknown threadId', () => {
    const entry = ledger.getOrCreate('thread-1');
    expect(entry.active.size).toBe(0);
    expect(entry.finalized.size).toBe(0);
    expect(entry.replaced.size).toBe(0);
    expect(entry.sawStreamData.size).toBe(0);
    expect(entry.lastObservedExplicitInvocationId.size).toBe(0);
    expect(entry.timeoutHandle).toBeNull();
  });

  it('returns the same entry on subsequent getOrCreate for the same threadId', () => {
    const a = ledger.getOrCreate('thread-1');
    const b = ledger.getOrCreate('thread-1');
    expect(a).toBe(b);
  });

  it('returns different entries for different threadIds', () => {
    const a = ledger.getOrCreate('thread-1');
    const b = ledger.getOrCreate('thread-2');
    expect(a).not.toBe(b);
  });

  it('touches lastTouched on getOrCreate', () => {
    const before = Date.now();
    const entry = ledger.getOrCreate('thread-1');
    expect(entry.lastTouched).toBeGreaterThanOrEqual(before);
  });
});

/**
 * AC-B9: lastObservedExplicitInvocationId replaces catInvocations fallback.
 *
 * shouldSuppressLateStreamChunk needs a "what's the most recent explicit
 * invocationId we've seen for this (thread, cat)" lookup that is ledger-local
 * (not global UI state like catInvocations). When a stream chunk arrives without
 * an explicit msg.invocationId, this is the trusted fallback for deciding
 * whether the chunk belongs to a replaced/active invocation.
 */
describe('F173 Phase B AC-B9: explicit invocation observation', () => {
  let ledger: ThreadRuntimeLedger;

  beforeEach(() => {
    ledger = createThreadRuntimeLedger();
  });

  it('returns undefined when no explicit invocation has been observed', () => {
    expect(getLastObservedExplicit(ledger, 'thread-1', 'opus')).toBeUndefined();
  });

  it('returns the last observed invocationId for a (thread, cat)', () => {
    markExplicitInvocationObserved(ledger, 'thread-1', 'opus', 'inv-A');
    expect(getLastObservedExplicit(ledger, 'thread-1', 'opus')).toBe('inv-A');
  });

  it('updates the observation when a newer invocationId arrives for same (thread, cat)', () => {
    markExplicitInvocationObserved(ledger, 'thread-1', 'opus', 'inv-A');
    markExplicitInvocationObserved(ledger, 'thread-1', 'opus', 'inv-B');
    expect(getLastObservedExplicit(ledger, 'thread-1', 'opus')).toBe('inv-B');
  });

  it('isolates observations per (thread, cat)', () => {
    markExplicitInvocationObserved(ledger, 'thread-1', 'opus', 'inv-A');
    markExplicitInvocationObserved(ledger, 'thread-1', 'codex', 'inv-B');
    markExplicitInvocationObserved(ledger, 'thread-2', 'opus', 'inv-C');
    expect(getLastObservedExplicit(ledger, 'thread-1', 'opus')).toBe('inv-A');
    expect(getLastObservedExplicit(ledger, 'thread-1', 'codex')).toBe('inv-B');
    expect(getLastObservedExplicit(ledger, 'thread-2', 'opus')).toBe('inv-C');
    expect(getLastObservedExplicit(ledger, 'thread-2', 'codex')).toBeUndefined();
  });
});

/**
 * AC-B6: replaced map with explicit TTL (no naked Set).
 *
 * 砚砚 LGTM-5 non-blocking observation: long sessions accumulate replaced
 * invocationIds because the old shared-replaced-invocations module only cleared
 * on full thread-level cleanup. Phase B uses Map<invocationId, {expiresAt}> so
 * each replaced marker has its own TTL and can be evicted independently.
 */
describe('F173 Phase B AC-B6: replaced map with explicit TTL', () => {
  let ledger: ThreadRuntimeLedger;

  beforeEach(() => {
    ledger = createThreadRuntimeLedger();
  });

  it('isInvocationReplaced returns false before any mark', () => {
    expect(isInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-A')).toBe(false);
  });

  it('isInvocationReplaced returns true after markInvocationReplaced for same key', () => {
    markInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-A', 60_000);
    expect(isInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-A')).toBe(true);
  });

  it('different invocationIds for the same (thread, cat) tracked independently', () => {
    markInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-A', 60_000);
    expect(isInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-A')).toBe(true);
    expect(isInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-B')).toBe(false);
  });

  it('isolates replaced markers per (thread, cat)', () => {
    markInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-A', 60_000);
    expect(isInvocationReplaced(ledger, 'thread-2', 'opus', 'inv-A')).toBe(false);
    expect(isInvocationReplaced(ledger, 'thread-1', 'codex', 'inv-A')).toBe(false);
  });

  it('isInvocationReplaced returns false after the marker has expired', () => {
    markInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-A', -1); // expired immediately
    expect(isInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-A')).toBe(false);
  });

  it('evictExpiredReplaced drops only expired entries and returns count', () => {
    markInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-old', -1); // expired
    markInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-fresh', 60_000); // fresh
    markInvocationReplaced(ledger, 'thread-1', 'codex', 'inv-also-old', -1); // expired
    const evicted = evictExpiredReplaced(ledger, 'thread-1');
    expect(evicted).toBe(2);
    expect(isInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-old')).toBe(false);
    expect(isInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-fresh')).toBe(true);
    expect(isInvocationReplaced(ledger, 'thread-1', 'codex', 'inv-also-old')).toBe(false);
  });

  it('evictExpiredReplaced returns 0 when nothing is expired', () => {
    markInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-A', 60_000);
    expect(evictExpiredReplaced(ledger, 'thread-1')).toBe(0);
  });
});

/**
 * AC-B10: isStaleTerminalEvent returns a decision object, not a boolean.
 *
 * 砚砚 hard requirement (Phase B kickoff): callers should not have to recompute
 * slot-fresh / fallback decisions at the call site. The decision function must
 * surface what it found:
 *   { stale, source, targetMessageId? }
 *   source ∈ 'explicit' | 'active' | 'slotFresh' | 'none'
 *
 * Decision rules — ledger only short-circuits with POSITIVE signal:
 *   - explicit invocationId AND in replaced map → stale=true, source='explicit'
 *   - explicit invocationId AND matches active bubble for that cat →
 *     stale=false, source='explicit', targetMessageId=active.messageId
 *   - no explicit invocationId AND active bubble exists for cat →
 *     stale=false, source='active', targetMessageId=active.messageId
 *   - nothing matched → stale=false, source='none' (defer to caller's
 *     legacy 4-source resolver for invocationless terminals)
 *
 * (slotFresh is reserved for future InvocationTracker integration; not wired
 * in pure ledger. Earlier 'unboundFallback' branch was removed in Codex P1
 * round 2 — see TerminalDecisionSource type docblock.)
 */
describe('F173 Phase B AC-B10: decideTerminalEventTarget decision object', () => {
  let ledger: ThreadRuntimeLedger;

  beforeEach(() => {
    ledger = createThreadRuntimeLedger();
  });

  it('explicit invocationId + replaced → stale=true, source=explicit, no targetMessageId', () => {
    markInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-old', 60_000);
    const decision = decideTerminalEventTarget(ledger, 'thread-1', 'opus', 'inv-old');
    expect(decision.stale).toBe(true);
    expect(decision.source).toBe('explicit');
    expect(decision.targetMessageId).toBeUndefined();
  });

  it('explicit invocationId + matches active bubble → stale=false, source=explicit, targetMessageId set', () => {
    setActiveBubble(ledger, 'thread-1', 'opus', { messageId: 'msg-1', invocationId: 'inv-A' });
    const decision = decideTerminalEventTarget(ledger, 'thread-1', 'opus', 'inv-A');
    expect(decision.stale).toBe(false);
    expect(decision.source).toBe('explicit');
    expect(decision.targetMessageId).toBe('msg-1');
  });

  it('no explicit invocationId + lastObservedExplicit replaced + no active → defer to legacy (source=none)', () => {
    // Cloud Codex P1 (2026-04-24 round 2): unboundFallback branch removed.
    // lastObservedExplicit alone is not enough to mark stale — callback-only
    // runs never update it, so relying on it would skip legitimate cleanup
    // for the new invocation. Defer to caller's 4-source resolver.
    markExplicitInvocationObserved(ledger, 'thread-1', 'opus', 'inv-stale');
    markInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-stale', 60_000);
    const decision = decideTerminalEventTarget(ledger, 'thread-1', 'opus', undefined);
    expect(decision.stale).toBe(false);
    expect(decision.source).toBe('none');
    expect(decision.targetMessageId).toBeUndefined();
  });

  it('no explicit invocationId + active bubble exists → stale=false, source=active, targetMessageId set', () => {
    setActiveBubble(ledger, 'thread-1', 'opus', { messageId: 'msg-2', invocationId: 'inv-B' });
    const decision = decideTerminalEventTarget(ledger, 'thread-1', 'opus', undefined);
    expect(decision.stale).toBe(false);
    expect(decision.source).toBe('active');
    expect(decision.targetMessageId).toBe('msg-2');
  });

  it('no match anywhere → stale=false, source=none', () => {
    const decision = decideTerminalEventTarget(ledger, 'thread-1', 'opus', undefined);
    expect(decision.stale).toBe(false);
    expect(decision.source).toBe('none');
    expect(decision.targetMessageId).toBeUndefined();
  });

  it('explicit invocationId mismatches active bubble → falls through to none, not stale', () => {
    setActiveBubble(ledger, 'thread-1', 'opus', { messageId: 'msg-3', invocationId: 'inv-X' });
    const decision = decideTerminalEventTarget(ledger, 'thread-1', 'opus', 'inv-Y');
    expect(decision.stale).toBe(false);
    expect(decision.source).toBe('none');
  });

  it('Cloud Codex P1 (2026-04-24): active bubble wins over replaced lastObservedExplicit', () => {
    // Repro: inv-A is callback-replaced, inv-B starts running with active bubble,
    // terminal arrives WITHOUT invocationId. Old logic returned source='unboundFallback'
    // stale=true (because lastObserved=inv-A was replaced) → dropped legitimate inv-B
    // terminal → bubble stuck streaming. Active bubble must take precedence.
    markExplicitInvocationObserved(ledger, 'thread-1', 'opus', 'inv-A');
    markInvocationReplaced(ledger, 'thread-1', 'opus', 'inv-A', 60_000);
    setActiveBubble(ledger, 'thread-1', 'opus', { messageId: 'msg-B', invocationId: 'inv-B' });
    const decision = decideTerminalEventTarget(ledger, 'thread-1', 'opus', undefined);
    expect(decision.stale).toBe(false);
    expect(decision.source).toBe('active');
    expect(decision.targetMessageId).toBe('msg-B');
  });
});

/**
 * AC-B3: GC sweep + thread removal.
 *
 * 砚砚 GC requirements (Phase B kickoff):
 *  - idle sweep threshold: 1h, refs are small, 10min too aggressive
 *  - sweep predicate: !hasActive && !pendingFinalized && lastTouched < cutoff
 *  - event handler 进来第一步 touch (sweep 不会吃刚到的事件)
 *  - delete 硬删 only on "thread record really deleted" (not UI close)
 *  - "done+empty 立刻删" — finalized callback merge window 还占用就不算 empty
 */
describe('F173 Phase B AC-B3: GC sweep + removeThread', () => {
  let ledger: ThreadRuntimeLedger;

  beforeEach(() => {
    ledger = createThreadRuntimeLedger();
  });

  it('removeThread drops the thread entry entirely', () => {
    ledger.getOrCreate('thread-1');
    expect(hasThread(ledger, 'thread-1')).toBe(true);
    removeThread(ledger, 'thread-1');
    expect(hasThread(ledger, 'thread-1')).toBe(false);
  });

  it('removeThread on unknown threadId is a no-op (no throw)', () => {
    removeThread(ledger, 'thread-unknown');
    expect(hasThread(ledger, 'thread-unknown')).toBe(false);
  });

  it('sweepIdleThreads keeps fresh entries (lastTouched > cutoff)', () => {
    ledger.getOrCreate('thread-fresh'); // just touched
    const cutoff = Date.now() - 1000; // 1s ago — fresh entry's lastTouched > cutoff
    const dropped = sweepIdleThreads(ledger, cutoff);
    expect(dropped).toBe(0);
    expect(hasThread(ledger, 'thread-fresh')).toBe(true);
  });

  it('sweepIdleThreads drops idle entries with no active bubbles + no finalized', () => {
    const entry = ledger.getOrCreate('thread-idle');
    entry.lastTouched = Date.now() - 7_200_000; // 2h ago
    const cutoff = Date.now() - 3_600_000; // 1h cutoff
    const dropped = sweepIdleThreads(ledger, cutoff);
    expect(dropped).toBe(1);
    expect(hasThread(ledger, 'thread-idle')).toBe(false);
  });

  it('sweepIdleThreads keeps idle entries that still have active bubbles', () => {
    const entry = ledger.getOrCreate('thread-active');
    setActiveBubble(ledger, 'thread-active', 'opus', { messageId: 'msg-1', invocationId: 'inv-A' });
    entry.lastTouched = Date.now() - 7_200_000; // 2h ago
    const cutoff = Date.now() - 3_600_000;
    const dropped = sweepIdleThreads(ledger, cutoff);
    expect(dropped).toBe(0);
    expect(hasThread(ledger, 'thread-active')).toBe(true);
  });

  it('sweepIdleThreads keeps idle entries with finalized bubbles still in callback merge window', () => {
    setFinalizedBubble(ledger, 'thread-merge', 'opus', { messageId: 'msg-1', invocationId: 'inv-A' }, 60_000);
    const entry = ledger.getOrCreate('thread-merge');
    entry.lastTouched = Date.now() - 7_200_000;
    const cutoff = Date.now() - 3_600_000;
    const dropped = sweepIdleThreads(ledger, cutoff);
    expect(dropped).toBe(0);
    expect(hasThread(ledger, 'thread-merge')).toBe(true);
  });

  it('sweepIdleThreads drops entries whose finalized bubbles have all expired', () => {
    setFinalizedBubble(ledger, 'thread-stale', 'opus', { messageId: 'msg-1', invocationId: 'inv-A' }, -1); // expired
    const entry = ledger.getOrCreate('thread-stale');
    entry.lastTouched = Date.now() - 7_200_000;
    const cutoff = Date.now() - 3_600_000;
    const dropped = sweepIdleThreads(ledger, cutoff);
    expect(dropped).toBe(1);
    expect(hasThread(ledger, 'thread-stale')).toBe(false);
  });

  it('sweepIdleThreads sweeps multiple threads in one pass and returns total count', () => {
    const t1 = ledger.getOrCreate('t-1');
    const t2 = ledger.getOrCreate('t-2');
    const t3 = ledger.getOrCreate('t-3');
    t1.lastTouched = Date.now() - 7_200_000;
    t2.lastTouched = Date.now() - 7_200_000;
    t3.lastTouched = Date.now(); // fresh
    const cutoff = Date.now() - 3_600_000;
    const dropped = sweepIdleThreads(ledger, cutoff);
    expect(dropped).toBe(2);
    expect(hasThread(ledger, 't-1')).toBe(false);
    expect(hasThread(ledger, 't-2')).toBe(false);
    expect(hasThread(ledger, 't-3')).toBe(true);
  });
});

/**
 * Active bubble lifecycle helpers — clearActiveBubble + getActiveBubble.
 *
 * These complete the active bubble surface: set on stream start, get for
 * routing, clear on terminal/replace. AC-B5/B7 selection logic depends on
 * accurate active state; AC-B3 sweep depends on clear-after-finalize so
 * empty-and-idle threads can be dropped.
 */
describe('F173 Phase B: active bubble lifecycle', () => {
  let ledger: ThreadRuntimeLedger;

  beforeEach(() => {
    ledger = createThreadRuntimeLedger();
  });

  it('getActiveBubble returns undefined before any setActiveBubble', () => {
    expect(getActiveBubble(ledger, 'thread-1', 'opus')).toBeUndefined();
  });

  it('getActiveBubble returns the bubble that was set', () => {
    setActiveBubble(ledger, 'thread-1', 'opus', { messageId: 'msg-1', invocationId: 'inv-A' });
    const got = getActiveBubble(ledger, 'thread-1', 'opus');
    expect(got?.messageId).toBe('msg-1');
    expect(got?.invocationId).toBe('inv-A');
  });

  it('clearActiveBubble removes the bubble for a (thread, cat)', () => {
    setActiveBubble(ledger, 'thread-1', 'opus', { messageId: 'msg-1', invocationId: 'inv-A' });
    clearActiveBubble(ledger, 'thread-1', 'opus');
    expect(getActiveBubble(ledger, 'thread-1', 'opus')).toBeUndefined();
  });

  it('clearActiveBubble on unknown (thread, cat) is a no-op', () => {
    clearActiveBubble(ledger, 'thread-x', 'opus');
    expect(getActiveBubble(ledger, 'thread-x', 'opus')).toBeUndefined();
  });
});

/**
 * sawStreamData tracking — replaces top-level Set in useAgentMessages.ts:127.
 *
 * Used by terminal handlers to distinguish "stream genuinely produced text"
 * vs "stream produced no text and we should fallback to error/diagnostic".
 */
describe('F173 Phase B: stream data observation', () => {
  let ledger: ThreadRuntimeLedger;

  beforeEach(() => {
    ledger = createThreadRuntimeLedger();
  });

  it('hadStreamData returns false before any markStreamData', () => {
    expect(hadStreamData(ledger, 'thread-1', 'opus')).toBe(false);
  });

  it('hadStreamData returns true after markStreamData for same (thread, cat)', () => {
    markStreamData(ledger, 'thread-1', 'opus');
    expect(hadStreamData(ledger, 'thread-1', 'opus')).toBe(true);
  });

  it('isolates per (thread, cat)', () => {
    markStreamData(ledger, 'thread-1', 'opus');
    expect(hadStreamData(ledger, 'thread-1', 'codex')).toBe(false);
    expect(hadStreamData(ledger, 'thread-2', 'opus')).toBe(false);
  });

  it('markStreamData with explicit invocationId records it for cross-checking', () => {
    markStreamData(ledger, 'thread-1', 'opus', 'inv-A');
    const entry = ledger.getOrCreate('thread-1');
    expect(entry.sawStreamData.get('opus')?.invocationId).toBe('inv-A');
  });

  it('clearStreamData removes the marker for (thread, cat)', () => {
    markStreamData(ledger, 'thread-1', 'opus');
    clearStreamData(ledger, 'thread-1', 'opus');
    expect(hadStreamData(ledger, 'thread-1', 'opus')).toBe(false);
  });

  it('clearStreamData on unknown (thread, cat) is a no-op', () => {
    clearStreamData(ledger, 'thread-x', 'opus');
    expect(hadStreamData(ledger, 'thread-x', 'opus')).toBe(false);
  });
});

/**
 * Finalized bubble lookup + clear — used by integration of finalizedStreamRef.
 */
describe('F173 Phase B: finalized bubble lookup', () => {
  let ledger: ThreadRuntimeLedger;

  beforeEach(() => {
    ledger = createThreadRuntimeLedger();
  });

  it('getFinalizedMessageId returns undefined before any setFinalizedBubble', () => {
    expect(getFinalizedMessageId(ledger, 'thread-1', 'opus')).toBeUndefined();
  });

  it('getFinalizedMessageId returns the messageId set within TTL', () => {
    setFinalizedBubble(ledger, 'thread-1', 'opus', { messageId: 'msg-1' }, 60_000);
    expect(getFinalizedMessageId(ledger, 'thread-1', 'opus')).toBe('msg-1');
  });

  it('getFinalizedMessageId returns undefined after TTL expires', () => {
    setFinalizedBubble(ledger, 'thread-1', 'opus', { messageId: 'msg-1' }, -1);
    expect(getFinalizedMessageId(ledger, 'thread-1', 'opus')).toBeUndefined();
  });

  it('clearFinalized removes the entry for (thread, cat)', () => {
    setFinalizedBubble(ledger, 'thread-1', 'opus', { messageId: 'msg-1' }, 60_000);
    clearFinalized(ledger, 'thread-1', 'opus');
    expect(getFinalizedMessageId(ledger, 'thread-1', 'opus')).toBeUndefined();
  });
});
