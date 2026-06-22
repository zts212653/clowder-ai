/**
 * F168 Phase D D0.2 — Redis-backed NarratorDedupStore
 *
 * Replaces the former process-local Set in NarratorDriver for INV-3
 * idempotency. Multiple NarratorDriver instances (across restarts or
 * parallel workers) share dedup state via Redis.
 *
 * Key format: f168:narrator-dedup:{sourceEventId}
 * TTL: none (persistent by default, per D-PR1 packet).
 *
 * Atomicity: uses SET NX (atomic claim) so that exactly one concurrent
 * caller wins the race. Split has()+add() was racy — P1 fix per review.
 */

import type { NarratorDedupStore } from './NarratorDriver.js';

/** Minimal Redis subset — explicit overload matching ioredis SET NX. */
export interface NarratorDedupRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, nxToken: 'NX'): Promise<string | null>;
}

const KEY_PREFIX = 'f168:narrator-dedup:';

export class RedisNarratorDedupStore implements NarratorDedupStore {
  constructor(private readonly redis: NarratorDedupRedisLike) {}

  /**
   * Atomically claim this sourceEventId using SET NX.
   * Returns true if this call set the key (first claimer), false otherwise.
   */
  async claim(sourceEventId: string): Promise<boolean> {
    const result = await this.redis.set(`${KEY_PREFIX}${sourceEventId}`, '1', 'NX');
    return result === 'OK';
  }
}

/**
 * In-memory fallback for environments without Redis (e.g. tests, dev without Redis).
 * NOT suitable for multi-process production — use RedisNarratorDedupStore there.
 */
export class InMemoryNarratorDedupStore implements NarratorDedupStore {
  readonly #store = new Set<string>();

  async claim(sourceEventId: string): Promise<boolean> {
    if (this.#store.has(sourceEventId)) return false;
    this.#store.add(sourceEventId);
    return true;
  }
}
