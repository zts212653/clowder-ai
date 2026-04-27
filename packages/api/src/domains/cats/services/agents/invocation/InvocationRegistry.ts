/**
 * Invocation Registry
 * 管理 MCP 回传工具的调用鉴权
 *
 * F174 Phase B — facade over IAuthInvocationBackend (memory or redis).
 * Public API stays stable; storage swappable via constructor injection.
 *
 * 安全契约:
 * - invocationId → { userId, catId, callbackToken, expiresAt }
 * - verify() 同时检查 token 匹配 + TTL 过期 (typed reason on failure)
 * - 持久化 + LRU + TTL 由 backend 实现
 */

import { randomUUID } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import type { IAuthInvocationBackend } from './IAuthInvocationBackend.js';
import { MemoryAuthInvocationBackend } from './MemoryAuthInvocationBackend.js';

export interface InvocationRecord {
  invocationId: string;
  callbackToken: string;
  userId: string;
  catId: CatId;
  /** Thread this invocation belongs to (for WebSocket room scoping) */
  threadId: string;
  /** F108 fix: InvocationRecordStore's parent invocation ID for worklist key alignment */
  parentInvocationId?: string;
  /** F121: The A2A trigger message ID — the @mention message that caused this cat to be invoked */
  a2aTriggerMessageId?: string;
  /** In-invocation idempotency keys for callback post-message de-duplication. */
  clientMessageIds: Set<string>;
  createdAt: number;
  expiresAt: number;
}

/** Default TTL: 2 hours (was 10 min — cats routinely run 20-40 min, first callback was 401) */
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * F174-B P2 (cloud Codex review #1363) — pure helper that picks the backend kind
 * given the env var + Redis availability, throwing on unknown values so typos
 * (e.g. `REDUS=...`) don't silently fall back to in-memory and defeat Phase B.
 *
 * Returns 'redis' | 'memory'. Caller is responsible for actually wiring the
 * matching backend instance.
 */
export function selectInvocationBackendKind(envValue: string | undefined, redisAvailable: boolean): 'redis' | 'memory' {
  if (envValue !== undefined && envValue !== 'redis' && envValue !== 'memory') {
    throw new Error(
      `Invalid CAT_CAFE_INVOCATION_REGISTRY="${envValue}". ` +
        `Allowed values: 'redis' (default when Redis available), 'memory' (fallback / opt-out).`,
    );
  }
  if (envValue === 'redis' && !redisAvailable) {
    // Explicit redis selection but no client available — degrade with warning
    // but don't throw (some test envs need this).
    return 'memory';
  }
  return (envValue ?? (redisAvailable ? 'redis' : 'memory')) as 'redis' | 'memory';
}

/**
 * F174 Phase A — Structured auth failure reasons.
 *
 * Discriminated union returned by verify() so downstream telemetry (Phase D)
 * and degradation (Phase E) can branch on a typed reason instead of regex-matching
 * error strings.
 *
 * F174 Phase C (cloud Codex P2 #1368, 05de7c98b) added `stale_invocation` to
 * the union so verifyLatest() can return it atomically alongside the verify
 * + slide step (closing the preValidation/preHandler race window). Existing
 * isLatest() call sites at post_message / schedule continue using their own
 * ad-hoc 401 path; this just centralizes the refresh-token case.
 */
export type AuthFailureReason = 'expired' | 'invalid_token' | 'unknown_invocation' | 'stale_invocation';

export type VerifyResult = { ok: true; record: InvocationRecord } | { ok: false; reason: AuthFailureReason };

/**
 * Registry for managing invocation auth tokens.
 *
 * Backend (memory / redis) is injected via constructor; default is
 * MemoryAuthInvocationBackend so existing tests work unchanged.
 */
export class InvocationRegistry {
  private readonly backend: IAuthInvocationBackend;
  private readonly ttlMs: number;

  constructor(options?: { ttlMs?: number; maxRecords?: number; backend?: IAuthInvocationBackend }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.backend = options?.backend ?? new MemoryAuthInvocationBackend({ maxRecords: options?.maxRecords ?? 500 });
  }

  /**
   * Create a new invocation and return the auth credentials.
   * The caller should pass these as env vars to the CLI subprocess.
   */
  async create(
    userId: string,
    catId: CatId,
    threadId: string = 'default',
    parentInvocationId?: string,
    a2aTriggerMessageId?: string,
  ): Promise<{ invocationId: string; callbackToken: string }> {
    const invocationId = randomUUID();
    const callbackToken = randomUUID();
    const now = Date.now();

    await this.backend.create(
      {
        invocationId,
        callbackToken,
        userId,
        catId,
        threadId,
        ...(parentInvocationId ? { parentInvocationId } : {}),
        ...(a2aTriggerMessageId ? { a2aTriggerMessageId } : {}),
        clientMessageIds: new Set<string>(),
        createdAt: now,
      },
      this.ttlMs,
    );

    return { invocationId, callbackToken };
  }

  /**
   * Verify invocationId + callbackToken binding.
   * Returns a discriminated VerifyResult — on failure, includes a typed reason
   * so callers (preHandler / telemetry / degradation) can branch precisely
   * instead of regex-matching error strings. (F174 Phase A — KD-4)
   */
  async verify(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    return this.backend.verify(invocationId, callbackToken, this.ttlMs);
  }

  /**
   * Check if an invocationId is the latest for its thread+cat slot.
   * Stale callbacks from preempted invocations return false.
   * (Cloud Codex P1 + 缅因猫 R3 suggestion)
   */
  async isLatest(invocationId: string): Promise<boolean> {
    return this.backend.isLatest(invocationId);
  }

  /** Get the latest invocationId for a given thread+cat slot, if any. */
  async getLatestId(threadId: string, catId: string): Promise<string | undefined> {
    return this.backend.getLatestId(threadId, catId);
  }

  /**
   * Claim a callback clientMessageId for an invocation.
   * Returns true if this ID is first-seen, false if duplicate or invocation missing.
   */
  async claimClientMessageId(invocationId: string, clientMessageId: string): Promise<boolean> {
    return this.backend.claimClientMessageId(invocationId, clientMessageId);
  }

  /**
   * F174 Phase C — claim per-invocation refresh cooldown atomically.
   * Returns true if cooldown was claimed (refresh may proceed),
   * false if a previous claim is still active (caller should reject 429).
   */
  async tryClaimRefreshCooldown(invocationId: string, cooldownMs: number): Promise<boolean> {
    return this.backend.tryClaimRefreshCooldown(invocationId, cooldownMs);
  }

  /**
   * Read-only fetch (does NOT slide TTL). Returns null when missing or expired.
   * Used by Phase C refresh endpoint to read post-slide expiresAt without
   * triggering another slide.
   */
  async getRecord(invocationId: string): Promise<InvocationRecord | null> {
    return this.backend.getRecord(invocationId);
  }

  /**
   * F174 D2b-1 — pure record read (ignores TTL, never deletes). Used by the
   * callback auth in-context surface to recover threadId/catId for failures
   * whose record verify() has just deleted on `expired` (砚砚 P1 #1397 review).
   */
  async peekRecord(invocationId: string): Promise<InvocationRecord | null> {
    return this.backend.peekRecord(invocationId);
  }

  /**
   * F174-C — verify token without sliding TTL (gpt52 P1 #2). Used by
   * refresh-token onRequest hook so bad-auth requests can't burn cooldown.
   */
  async peek(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    return this.backend.peek(invocationId, callbackToken);
  }

  /**
   * F174-C — atomic verify + isLatest + slide. Used by refresh-token route
   * to close the race window between preValidation isLatest check and
   * preHandler verify slide (cloud Codex P2 #1368).
   */
  async verifyLatest(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    return this.backend.verifyLatest(invocationId, callbackToken, this.ttlMs);
  }
}
