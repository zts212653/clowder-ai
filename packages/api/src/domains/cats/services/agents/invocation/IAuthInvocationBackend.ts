/**
 * F174 Phase B — Backend port for callback auth invocation storage.
 *
 * MemoryAuthInvocationBackend (in-memory Map, current default for tests) and
 * RedisAuthInvocationBackend (Redis Hash + Lua, restart-resilient) both implement
 * this interface. The InvocationRegistry facade delegates to whichever backend
 * the factory wires up based on CAT_CAFE_INVOCATION_REGISTRY env.
 *
 * All methods are async to allow Redis IO uniformly; memory backend wraps in
 * `Promise.resolve` (negligible overhead).
 */

import type { InvocationRecord, VerifyResult } from './InvocationRegistry.js';

/** Subset of InvocationRecord fields the backend stores; expiresAt is computed by ttlMs. */
export type AuthInvocationInput = Omit<InvocationRecord, 'expiresAt'>;

export interface IAuthInvocationBackend {
  /** Persist a new invocation record with a TTL relative to now. */
  create(input: AuthInvocationInput, ttlMs: number): Promise<void>;

  /**
   * Validate token + slide TTL (extend expiresAt by ttlMs from now on success).
   * Returns VerifyResult so callers can branch on typed reason.
   */
  verify(invocationId: string, callbackToken: string, ttlMs: number): Promise<VerifyResult>;

  /**
   * F174-C — verify token WITHOUT sliding TTL. Used by refresh-token endpoint
   * to validate auth before claiming cooldown (otherwise unauthenticated
   * requests could burn the cooldown slot via DoS — gpt52 P1 #2 #1368).
   * Same VerifyResult contract as verify() but never extends expiresAt.
   */
  peek(invocationId: string, callbackToken: string): Promise<VerifyResult>;

  /**
   * F174-C — atomic verify + isLatest + slide. Returns stale_invocation if
   * the record has been superseded; otherwise behaves like verify() (slides
   * TTL on success). Closes the race window between preValidation isLatest
   * check and preHandler verify slide (cloud Codex P2 #1368, 05de7c98b).
   */
  verifyLatest(invocationId: string, callbackToken: string, ttlMs: number): Promise<VerifyResult>;

  /** Read-only fetch (does NOT slide TTL). Returns null when missing or expired. */
  getRecord(invocationId: string): Promise<InvocationRecord | null>;

  /**
   * F174 D2b-1 — Read raw record metadata, ignoring TTL. Used by the in-context
   * observability surface (notifier) to recover threadId/catId/userId for a
   * 401-causing invocation even when it's just expired — both verify() and
   * getRecord() delete the record on `expired`, so the only way to associate
   * the failure back to a thread is to peek before verify runs (or after, if
   * Redis TTL hasn't yet evicted the hash). Returns null only when the record
   * was never present or has already been Redis-TTL-evicted.
   */
  peekRecord(invocationId: string): Promise<InvocationRecord | null>;

  /** Whether the invocationId is the latest for its (threadId, catId) slot. */
  isLatest(invocationId: string): Promise<boolean>;

  /** Latest invocationId for a (threadId, catId) slot, if any. */
  getLatestId(threadId: string, catId: string): Promise<string | undefined>;

  /**
   * Claim a clientMessageId for an invocation. Returns true on first claim,
   * false on duplicate or unknown invocation.
   */
  claimClientMessageId(invocationId: string, clientMessageId: string): Promise<boolean>;

  /**
   * F174 Phase C — Atomic claim of a per-invocation refresh cooldown.
   * Returns true if the cooldown was claimed (caller may proceed with refresh),
   * false if a previous claim is still active (caller must reject as 429).
   * Implementation must be racy-safe (Redis SET NX EX, or per-key Map check).
   */
  tryClaimRefreshCooldown(invocationId: string, cooldownMs: number): Promise<boolean>;
}
