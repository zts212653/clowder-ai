/**
 * F33 Phase 3: Runtime session strategy overrides.
 *
 * Redis-backed with sync in-memory cache.
 * - initRuntimeOverrides() at startup: hydrate cache from Redis
 * - setRuntimeOverride() / deleteRuntimeOverride(): write-through (Redis first, then cache)
 * - getRuntimeOverride() / getAllRuntimeOverrides(): read from sync cache
 *
 * This keeps getSessionStrategy() synchronous while having persistent storage.
 *
 * IMPORTANT: ioredis keyPrefix does NOT auto-apply to SCAN MATCH patterns.
 * We must manually prefix MATCH, then strip prefix from results before using
 * them with normal commands (which DO auto-prefix). See RedisSessionChainStore.scanKeys().
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SessionStrategyConfig } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../infrastructure/logger.js';
import { SessionStrategyKeys } from './session-strategy-keys.js';

const log = createModuleLogger('session-strategy-overrides');

let _redis: RedisClient | undefined;

export interface RuntimeStrategyOverride {
  config: Partial<SessionStrategyConfig>;
  revision: string;
  changedAt: number;
}

const _cache = new Map<string, RuntimeStrategyOverride>();

function stableLegacyRevision(config: Partial<SessionStrategyConfig>): string {
  const input = JSON.stringify(config);
  return `legacy:${createHash('sha256').update(input).digest('hex')}`;
}

function isRevisionedOverride(value: unknown): value is RuntimeStrategyOverride {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RuntimeStrategyOverride>;
  return (
    candidate.config != null &&
    typeof candidate.config === 'object' &&
    typeof candidate.revision === 'string' &&
    typeof candidate.changedAt === 'number'
  );
}

function normalizeStoredOverride(value: unknown): RuntimeStrategyOverride | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (isRevisionedOverride(value)) return value;
  const config = value as Partial<SessionStrategyConfig>;
  return { config, revision: stableLegacyRevision(config), changedAt: 0 };
}

/**
 * Initialize the runtime override layer with a Redis client.
 * Call once at startup (index.ts). Hydrates the in-memory cache from Redis.
 */
export async function initRuntimeOverrides(redis: RedisClient): Promise<void> {
  _redis = redis;
  await hydrateFromRedis();
}

/** Get the runtime override for a specific cat (sync, from cache). */
export function getRuntimeOverride(catId: string): Partial<SessionStrategyConfig> | undefined {
  return _cache.get(catId)?.config;
}

/** Get the revision metadata used to snapshot policy at invocation boundaries. */
export function getRuntimeOverrideEntry(catId: string): RuntimeStrategyOverride | undefined {
  return _cache.get(catId);
}

/** Get all runtime overrides (sync, from cache). */
export function getAllRuntimeOverrides(): ReadonlyMap<string, Partial<SessionStrategyConfig>> {
  return new Map([..._cache].map(([catId, entry]) => [catId, entry.config]));
}

/**
 * Set a runtime strategy override for a variant cat.
 * Write-through: Redis first, then cache on success (P1-3: no cache split on Redis failure).
 */
export async function setRuntimeOverride(
  catId: string,
  override: Partial<SessionStrategyConfig>,
): Promise<RuntimeStrategyOverride> {
  const entry: RuntimeStrategyOverride = {
    config: override,
    revision: randomUUID(),
    changedAt: Date.now(),
  };
  if (_redis) {
    await _redis.set(SessionStrategyKeys.override(catId), JSON.stringify(entry));
  }
  _cache.set(catId, entry);
  return entry;
}

/**
 * Delete a runtime strategy override for a variant cat.
 * Redis DEL result is the source of truth for existence (not cache).
 * Falls back to cache check only when Redis is unavailable.
 */
export async function deleteRuntimeOverride(catId: string): Promise<boolean> {
  let existed: boolean;
  if (_redis) {
    const deleted = await _redis.del(SessionStrategyKeys.override(catId));
    existed = deleted > 0;
  } else {
    existed = _cache.has(catId);
  }
  _cache.delete(catId);
  return existed;
}

/** @internal Test-only: clear cache without touching Redis. */
export function _clearRuntimeOverrides(): void {
  _cache.clear();
  _redis = undefined;
}

/**
 * Hydrate the in-memory cache by scanning Redis for all override keys.
 *
 * IMPORTANT: ioredis keyPrefix does NOT auto-apply to SCAN MATCH patterns.
 * We must manually add the prefix for matching, then strip it from results
 * so that subsequent get() calls (which DO auto-prefix) work correctly.
 * Reference: RedisSessionChainStore.scanKeys()
 */
async function hydrateFromRedis(): Promise<void> {
  if (!_redis) return;
  const prefix = (_redis.options as { keyPrefix?: string }).keyPrefix ?? '';
  const barePattern = SessionStrategyKeys.override('*');
  const matchPattern = `${prefix}${barePattern}`;
  const keyPrefix = `${prefix}session-strategy:override:`;
  // Build into a temporary map — only swap to _cache on full success.
  // If SCAN fails mid-way, _cache stays empty (clean fallback) rather than
  // holding a partial subset that silently drops some overrides.
  const tempCache = new Map<string, RuntimeStrategyOverride>();
  let cursor = '0';
  do {
    const [nextCursor, keys] = await _redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
    cursor = nextCursor;
    for (const key of keys) {
      // Strip prefix so ioredis auto-prefix on get() doesn't double-prefix
      const bareKey = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
      const raw = await _redis.get(bareKey);
      if (raw) {
        const catId = key.slice(keyPrefix.length);
        try {
          const normalized = normalizeStoredOverride(JSON.parse(raw));
          if (normalized) tempCache.set(catId, normalized);
        } catch {
          log.warn({ key }, 'invalid JSON in Redis key, skipping');
        }
      }
    }
  } while (cursor !== '0');
  // Atomic swap: replace cache contents (not append) so deleted Redis keys
  // don't linger in memory after re-hydration.
  _cache.clear();
  for (const [catId, override] of tempCache) {
    _cache.set(catId, override);
  }
}
