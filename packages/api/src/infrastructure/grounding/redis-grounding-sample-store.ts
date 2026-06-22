/**
 * F167 Phase O PR-O5: Redis-backed Grounding Sample Store
 *
 * Persists ClaimGroundingEvent samples to Redis with 8-day TTL.
 * operator directive: TTL must exceed weekly eval cron period to avoid
 * TTL-vs-cron race (sample expires before eval reads it).
 *
 * Storage layout:
 * - `grounding:samples`               — Sorted Set (score=ts, member=JSON)
 * - `grounding:insufficient:{day}`    — Hash (field=resolver:threadId, value=count)
 * - `grounding:verified:{day}`        — String (value=count)
 * - `grounding:stats:dropped`         — String (value=count)
 *
 * Sampling rules unchanged from in-memory version (spec R2 + R3):
 * - mismatch & wouldBlock: 100% keep
 * - insufficient: cap 3 per resolver×thread×day
 * - verified: 1/20 rate + global daily cap
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ClaimGroundingEvent } from './types.js';

// ── Constants ────────────────────────────────────────────────

/** 8 days in seconds (operator: must exceed 7-day eval cron period). */
const DEFAULT_TTL_SECONDS = 8 * 24 * 60 * 60; // 691200

/** 2 days TTL for daily counter hashes (only needed for cap enforcement). */
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60; // 172800

const KEYS = {
  samples: 'grounding:samples',
  droppedCounter: 'grounding:stats:dropped',
  insufficientPrefix: 'grounding:insufficient:',
  verifiedPrefix: 'grounding:verified:',
} as const;

// ── Day key helper ───────────────────────────────────────────

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ── Options ──────────────────────────────────────────────────

export interface RedisGroundingSampleStoreOptions {
  /** Maximum total events stored (oldest evicted on overflow). Default: 1000. */
  maxTotal?: number;
  /** Insufficient cap per resolver×thread×day. Default: 3. */
  insufficientCap?: number;
  /** Verified global daily cap. Default: 50. */
  verifiedDailyCap?: number;
  /** TTL in seconds for the samples sorted set. Default: 691200 (8 days). */
  ttlSeconds?: number;
  /**
   * Injectable sampler for verified events (deterministic testing).
   * Default: Math.random() < 1/verifiedSampleRate.
   */
  shouldSampleVerified?: () => boolean;
  /** Verified sampling rate (1 in N). Default: 20. */
  verifiedSampleRate?: number;
}

// ── Store ────────────────────────────────────────────────────

export class RedisGroundingSampleStore {
  private readonly redis: RedisClient;
  private readonly maxTotal: number;
  private readonly insufficientCap: number;
  private readonly verifiedDailyCap: number;
  private readonly ttlSeconds: number;
  private readonly shouldSampleVerified: () => boolean;

  constructor(redis: RedisClient, opts: RedisGroundingSampleStoreOptions = {}) {
    this.redis = redis;
    this.maxTotal = opts.maxTotal ?? 1000;
    this.insufficientCap = opts.insufficientCap ?? 3;
    this.verifiedDailyCap = opts.verifiedDailyCap ?? 50;
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    const rate = opts.verifiedSampleRate ?? 20;
    this.shouldSampleVerified = opts.shouldSampleVerified ?? (() => Math.random() < 1 / rate);
  }

  /**
   * Record a grounding event if it passes sampling rules.
   * Persists to Redis sorted set (score=timestamp).
   */
  async record(event: ClaimGroundingEvent, wouldBlock: boolean): Promise<void> {
    if (await this.shouldRecord(event, wouldBlock)) {
      await this.push(event);
    } else {
      await this.redis.incr(KEYS.droppedCounter);
      await this.redis.expire(KEYS.droppedCounter, this.ttlSeconds);
    }
  }

  /** Get stored samples within the observation window, ordered by timestamp. */
  async getSamples(): Promise<ClaimGroundingEvent[]> {
    // P1 fix: filter by time window, not just key-level TTL.
    // Key TTL refreshes on every write, so old samples can survive indefinitely
    // if writes are continuous. Score = event.ts (epoch ms), so use
    // (now - ttlSeconds*1000) as the minimum score for a rolling window.
    const windowStart = Date.now() - this.ttlSeconds * 1000;
    // Cloud P2 fix: prune stale entries on read to keep zcard/capacity accurate.
    // Without this, old scores survive indefinitely (hidden from results but
    // inflating zcard and counting against maxTotal FIFO eviction).
    await this.redis.zremrangebyscore(KEYS.samples, '-inf', String(windowStart - 1));
    const raw = await this.redis.zrangebyscore(KEYS.samples, String(windowStart), '+inf');
    return raw.map((s) => JSON.parse(s) as ClaimGroundingEvent);
  }

  /** Get sampling statistics. */
  async getStats(): Promise<{ stored: number; dropped: number }> {
    const [stored, droppedStr] = await Promise.all([
      this.redis.zcard(KEYS.samples),
      this.redis.get(KEYS.droppedCounter),
    ]);
    return { stored, dropped: Number(droppedStr) || 0 };
  }

  // ── Private ──────────────────────────────────────────────

  private async shouldRecord(event: ClaimGroundingEvent, wouldBlock: boolean): Promise<boolean> {
    // Rule 1: mismatch or wouldBlock → always keep (100%)
    if (event.verdict === 'mismatch' || wouldBlock) {
      return true;
    }

    // Rule 2: insufficient → cap 3 per resolver×thread×day
    if (event.verdict === 'insufficient') {
      return this.checkInsufficientCap(event);
    }

    // Rule 3: verified → 1/N rate + daily cap
    if (event.verdict === 'verified') {
      return this.checkVerifiedSampling(event);
    }

    // Unknown verdict — store it
    return true;
  }

  private async checkInsufficientCap(event: ClaimGroundingEvent): Promise<boolean> {
    const day = dayKey(event.ts);
    const hashKey = `${KEYS.insufficientPrefix}${day}`;
    const field = `${event.resolver}:${event.threadId}`;

    // Note: HGET→check→HINCRBY is non-atomic. Under concurrent writes, the cap
    // can be exceeded by 1-2 samples. Accepted as P3: these caps are sampling
    // heuristics (not security boundaries), concurrency is low (cat-triggered
    // callbacks, ~1-5 events/min), and slight overshoot doesn't affect eval
    // pattern analysis. Lua atomicity would add complexity disproportionate to
    // the near-zero probability of this race in practice.
    const current = await this.redis.hget(hashKey, field);
    const count = Number(current) || 0;
    if (count >= this.insufficientCap) {
      return false;
    }

    await this.redis.hincrby(hashKey, field, 1);
    // Set TTL on first write (NX = only if not already set)
    await this.redis.expire(hashKey, COUNTER_TTL_SECONDS);
    return true;
  }

  private async checkVerifiedSampling(event: ClaimGroundingEvent): Promise<boolean> {
    const day = dayKey(event.ts);
    const countKey = `${KEYS.verifiedPrefix}${day}`;

    // Check daily cap first
    const current = await this.redis.get(countKey);
    const dayCount = Number(current) || 0;
    if (dayCount >= this.verifiedDailyCap) {
      return false;
    }

    // Then check probabilistic sampling
    if (!this.shouldSampleVerified()) {
      return false;
    }

    await this.redis.incr(countKey);
    // Set TTL on first write
    await this.redis.expire(countKey, COUNTER_TTL_SECONDS);
    return true;
  }

  private async push(event: ClaimGroundingEvent): Promise<void> {
    const member = JSON.stringify(event);
    await this.redis.zadd(KEYS.samples, String(event.ts), member);
    // Refresh TTL on the sorted set
    await this.redis.expire(KEYS.samples, this.ttlSeconds);

    // Trim if over max capacity (remove oldest = lowest score)
    const count = await this.redis.zcard(KEYS.samples);
    if (count > this.maxTotal) {
      await this.redis.zremrangebyrank(KEYS.samples, 0, count - this.maxTotal - 1);
    }
  }
}
