/**
 * F167 Phase O PR-O5: Grounding sample store singleton.
 *
 * Provides a unified async interface for grounding sample storage.
 * Uses Redis-backed store when a Redis client is wired (production),
 * falls back to in-memory store (tests / no-Redis environments).
 *
 * Consumers import { groundingSampleStore, wireRedisGroundingSampleStore }
 * and call methods with `await`.
 */

import { GroundingSampleStore } from './grounding-sample-store.js';
import { RedisGroundingSampleStore } from './redis-grounding-sample-store.js';
import type { ClaimGroundingEvent } from './types.js';

// ── Async interface (consumers use this) ─────────────────────

export interface IGroundingSampleStore {
  record(event: ClaimGroundingEvent, wouldBlock: boolean): void | Promise<void>;
  getSamples(): ClaimGroundingEvent[] | Promise<ClaimGroundingEvent[]>;
  getStats(): { stored: number; dropped: number } | Promise<{ stored: number; dropped: number }>;
}

// ── Singleton ────────────────────────────────────────────────

/** Start with in-memory; replaced by Redis version via wireRedisGroundingSampleStore(). */
let store: IGroundingSampleStore = new GroundingSampleStore();

/**
 * Wire Redis-backed store at startup. Called from index.ts after Redis client
 * is created. Replaces the in-memory fallback — any samples recorded before
 * wiring (during startup) are lost (acceptable: startup has no grounding checks).
 */
export function wireRedisGroundingSampleStore(redis: import('@cat-cafe/shared/utils').RedisClient): void {
  store = new RedisGroundingSampleStore(redis);
}

/** Get the current store instance (in-memory or Redis-backed). */
export function getGroundingSampleStore(): IGroundingSampleStore {
  return store;
}

/**
 * @deprecated Use getGroundingSampleStore() for the async-compatible interface.
 * Kept for backward compatibility during migration — new code should use the getter.
 */
export const groundingSampleStore = {
  get record() {
    return store.record.bind(store);
  },
  get getSamples() {
    return store.getSamples.bind(store);
  },
  get getStats() {
    return store.getStats.bind(store);
  },
};
