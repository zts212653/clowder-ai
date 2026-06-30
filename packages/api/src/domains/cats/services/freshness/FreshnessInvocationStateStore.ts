/**
 * F254 FreshnessInvocationStateStore (Phase B — B0b)
 *
 * Per-invocation operational state (hot path) for freshness decisions.
 * Consumed by B1 (notice frequency gating) and B3 (re-invoke trigger).
 *
 * Uses Redis HASH per invocation (key: freshness:state:{invocationId}).
 * TTL = 30 minutes (invocation timeout, auto-cleanup — not permanent like
 * BallCustodyEventLog). This is operational state, not user-visible data.
 *
 * Design decision (opus-47 insight, KD-7): hot path counters are separated
 * from the cold path event log (FreshnessAttentionEventLog). B3 re-invoke
 * decisions read these counters, not the full event log.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';

// --- Types ---

export interface FreshnessInvocationState {
  toolCallCount: number;
  noticeDeliveredCount: number;
  lastNoticeToolCallNum: number;
  ackedNoticeIds: string[];
  reinvokeTriggered: boolean;
  /**
   * F254 AC-C2: The carrier tier active when this invocation started.
   * Stored at invocation init so callback routes can derive a
   * RuntimeCapabilityDescriptor without access to the AgentService.
   */
  carrierTier?: string;
}

// --- Constants ---

/** TTL for per-invocation state: 30 minutes in seconds */
const STATE_TTL_SECONDS = 30 * 60; // 1800

/** Redis key prefix for per-invocation state */
function stateKey(invocationId: string): string {
  return `freshness:state:${invocationId}`;
}

// --- HASH field names ---

const FIELD = {
  toolCallCount: 'toolCallCount',
  noticeDeliveredCount: 'noticeDeliveredCount',
  lastNoticeToolCallNum: 'lastNoticeToolCallNum',
  ackedNoticeIds: 'ackedNoticeIds',
  reinvokeTriggered: 'reinvokeTriggered',
  carrierTier: 'carrierTier',
} as const;

// --- Store ---

export class FreshnessInvocationStateStore {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Get the full state for an invocation. Returns null if no state exists.
   */
  async get(invocationId: string): Promise<FreshnessInvocationState | null> {
    const key = stateKey(invocationId);
    const raw = await this.redis.hgetall(key);

    // hgetall returns {} for non-existent keys in ioredis
    if (!raw || Object.keys(raw).length === 0) return null;

    return {
      toolCallCount: parseInt(raw[FIELD.toolCallCount] || '0', 10),
      noticeDeliveredCount: parseInt(raw[FIELD.noticeDeliveredCount] || '0', 10),
      lastNoticeToolCallNum: parseInt(raw[FIELD.lastNoticeToolCallNum] || '0', 10),
      ackedNoticeIds: raw[FIELD.ackedNoticeIds] ? JSON.parse(raw[FIELD.ackedNoticeIds]) : [],
      reinvokeTriggered: raw[FIELD.reinvokeTriggered] === '1',
      carrierTier: raw[FIELD.carrierTier] || undefined,
    };
  }

  /**
   * Increment tool call count. Creates state if it doesn't exist.
   * Returns the new count.
   */
  async incrementToolCallCount(invocationId: string): Promise<number> {
    const key = stateKey(invocationId);

    // HINCRBY creates the field if it doesn't exist (returns 1 on first call)
    const count = await this.redis.hincrby(key, FIELD.toolCallCount, 1);

    // Initialize other fields on first call (idempotent — HSETNX only sets if not exists)
    if (count === 1) {
      await this.redis.hsetnx(key, FIELD.noticeDeliveredCount, '0');
      await this.redis.hsetnx(key, FIELD.lastNoticeToolCallNum, '0');
      await this.redis.hsetnx(key, FIELD.ackedNoticeIds, '[]');
      await this.redis.hsetnx(key, FIELD.reinvokeTriggered, '0');
    }

    // Reset TTL on every write
    await this.redis.expire(key, STATE_TTL_SECONDS);
    return count;
  }

  /**
   * Record that a notice was delivered at the given tool call number.
   * Increments noticeDeliveredCount and sets lastNoticeToolCallNum.
   */
  async recordNoticeDelivered(invocationId: string, toolCallNum: number): Promise<void> {
    const key = stateKey(invocationId);
    await this.redis.hincrby(key, FIELD.noticeDeliveredCount, 1);
    await this.redis.hset(key, FIELD.lastNoticeToolCallNum, String(toolCallNum));
    await this.redis.expire(key, STATE_TTL_SECONDS);
  }

  /**
   * Record that a notice was acknowledged (via seenCursor advance).
   * Adds to ackedNoticeIds (idempotent — no duplicates).
   */
  async recordNoticeAcked(invocationId: string, noticeId: string): Promise<void> {
    const key = stateKey(invocationId);
    const raw = await this.redis.hget(key, FIELD.ackedNoticeIds);
    const ids: string[] = raw ? JSON.parse(raw) : [];

    if (!ids.includes(noticeId)) {
      ids.push(noticeId);
      await this.redis.hset(key, FIELD.ackedNoticeIds, JSON.stringify(ids));
    }

    await this.redis.expire(key, STATE_TTL_SECONDS);
  }

  /**
   * Mark that a re-invoke has been triggered for this invocation.
   * Prevents duplicate re-invokes (B3 checks this flag).
   */
  async markReinvokeTriggered(invocationId: string): Promise<void> {
    const key = stateKey(invocationId);
    await this.redis.hset(key, FIELD.reinvokeTriggered, '1');
    await this.redis.expire(key, STATE_TTL_SECONDS);
  }

  /**
   * F254 AC-C2: Store the carrier tier at invocation start.
   *
   * Called once per invocation by invoke-single-cat.ts so that callback
   * routes can later read it (via get()) and construct a
   * RuntimeCapabilityDescriptor without needing AgentService access.
   *
   * Idempotent: HSETNX only sets if field doesn't exist yet.
   */
  async setCarrierTier(invocationId: string, carrierTier: string): Promise<void> {
    const key = stateKey(invocationId);
    await this.redis.hsetnx(key, FIELD.carrierTier, carrierTier);
    await this.redis.expire(key, STATE_TTL_SECONDS);
  }
}
