/**
 * F173 Phase A.6 — Shared `replaced invocations` runtime state (bidirectional handoff).
 * F173 Phase B AC-B6 (integration step 5) — internally delegates to the
 * thread-runtime-ledger singleton. The exported API surface stays identical
 * so existing callers (useAgentMessages, useAgentMessages, useSocket,
 * tests) keep working unchanged.
 *
 * Why the rewrite (砚砚 LGTM-5 non-blocking observation): the previous
 * `Map<key, Set<invocationId>>` had no TTL — long sessions accumulated
 * replaced invocationIds and only cleared on full thread-level cleanup.
 * The ledger uses `Map<threadId, Map<catId, Map<invocationId, {expiresAt}>>>`
 * with explicit TTL so each marker can be evicted independently.
 *
 * TTL choice: SHARED_REPLACED_TTL_MS (10 min) — long enough that no realistic
 * late-event reorder window misses suppression, short enough that abandoned
 * sessions don't grow ledger memory unbounded.
 *
 * Lifetime: process-singleton (delegates to thread-runtime-singleton). Tests
 * still call `resetSharedReplacedInvocations()` to wipe ledger between
 * fixtures — preserves the BeforeEach pattern used across the codebase.
 */

import {
  clearAllReplacedForThread,
  isInvocationReplaced as isInvocationReplacedLedger,
  markInvocationReplaced as markInvocationReplacedLedger,
  removeReplacedInvocationFromLedger,
} from './thread-runtime-ledger';
import { getThreadRuntimeLedger, resetThreadRuntimeSingleton } from './thread-runtime-singleton';

/** Late-event suppression window for replaced invocations. */
const SHARED_REPLACED_TTL_MS = 10 * 60 * 1000;

/** Compose the canonical stream key shared between active + background handlers. */
export function makeReplacedKey(threadId: string, catId: string): string {
  return `${threadId}::${catId}`;
}

/** Mark an invocation as replaced (by callback or boundary closure). Idempotent. */
export function markReplacedInvocation(threadId: string, catId: string, invocationId: string): void {
  markInvocationReplacedLedger(getThreadRuntimeLedger(), threadId, catId, invocationId, SHARED_REPLACED_TTL_MS);
}

/** Membership check: is this specific invocationId replaced for the (threadId, catId) pair? */
export function isInvocationReplaced(threadId: string, catId: string, invocationId: string): boolean {
  return isInvocationReplacedLedger(getThreadRuntimeLedger(), threadId, catId, invocationId);
}

/**
 * Read any one stored invocationId (legacy single-value API).
 * Returns the most recently added value (insertion order). Prefer
 * `isInvocationReplaced` for membership checks.
 *
 * Returns the latest non-expired invocationId in insertion order; undefined
 * if no live entries.
 */
export function getReplacedInvocation(threadId: string, catId: string): string | undefined {
  const entry = getThreadRuntimeLedger().getOrCreate(threadId);
  const perCat = entry.replaced.get(catId);
  if (!perCat || perCat.size === 0) return undefined;
  const now = Date.now();
  let last: string | undefined;
  for (const [invocationId, marker] of perCat) {
    if (marker.expiresAt > now) last = invocationId;
  }
  return last;
}

/** Clear ALL replaced invocations for a (threadId, catId) pair. */
export function clearReplacedInvocation(threadId: string, catId: string): void {
  const entry = getThreadRuntimeLedger().getOrCreate(threadId);
  entry.replaced.delete(catId);
}

/** Remove a single invocationId from the replaced set (cloud P2 — surgical clear). */
export function removeReplacedInvocation(threadId: string, catId: string, invocationId: string): void {
  removeReplacedInvocationFromLedger(getThreadRuntimeLedger(), threadId, catId, invocationId);
}

/** Test-only: reset all entries (call from beforeEach). */
export function resetSharedReplacedInvocations(): void {
  resetThreadRuntimeSingleton();
}

/**
 * F173 receive-review fix for砚砚 P1 round 3 — clear ONLY the entries that belong to a
 * specific thread, leaving suppression set for other threads intact. Used by `handleStop`
 * and `resetRefs` (thread switch) — global reset would erase background threads' active
 * suppression and let late stream chunks overwrite their authoritative callback content.
 */
export function clearReplacedInvocationsForThread(threadId: string): void {
  clearAllReplacedForThread(getThreadRuntimeLedger(), threadId);
}

/** Read-only snapshot for debug / observability. Set entries cloned per key. */
export function snapshotSharedReplacedInvocations(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const ledger = getThreadRuntimeLedger();
  const now = Date.now();
  for (const [threadId, entry] of ledger.entries()) {
    for (const [catId, perCat] of entry.replaced) {
      const live: string[] = [];
      for (const [invocationId, marker] of perCat) {
        if (marker.expiresAt > now) live.push(invocationId);
      }
      if (live.length > 0) {
        out.set(makeReplacedKey(threadId, catId), new Set(live));
      }
    }
  }
  return out;
}
