/**
 * HookOverrideStore — F237 Phase 2-D (AC-P2-15/16/17/18)
 *
 * Redis-backed runtime override layer for prompt hooks.
 * Operators (and future auto-eval) can enable/disable hooks, switch versions,
 * and edit templates — all gated by three constraint fields from the manifest:
 *   - disableable:    gates enable/disable override
 *   - safetyTier:     gates template content override
 *   - governanceTier: gates version override
 *
 * Overrides persist across restart (TTL=0, iron law #5 / LL-048).
 * Resolution: override ?? manifest baseline.
 */

import type { EffectiveHookState, HookOverride, OverrideConstraintError } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { HookRegistry } from './HookRegistry.js';

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'hook-override:';
const INDEX_KEY = 'hook-override:__index';

function overrideKey(hookId: string): string {
  return `${KEY_PREFIX}${hookId}`;
}

// ---------------------------------------------------------------------------
// Constraint validation error
// ---------------------------------------------------------------------------

export class HookOverrideConstraintError extends Error {
  public readonly hookId: string;
  public readonly constraint: OverrideConstraintError['constraint'];

  constructor(detail: OverrideConstraintError) {
    super(detail.message);
    this.name = 'HookOverrideConstraintError';
    this.hookId = detail.hookId;
    this.constraint = detail.constraint;
  }
}

// ---------------------------------------------------------------------------
// HookOverrideStore
// ---------------------------------------------------------------------------

export class HookOverrideStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly registry: HookRegistry,
  ) {}

  // -- Read -----------------------------------------------------------------

  async getOverride(hookId: string): Promise<HookOverride | null> {
    const raw = await this.redis.get(overrideKey(hookId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as HookOverride;
    } catch {
      return null;
    }
  }

  // -- Write (with constraint validation) -----------------------------------

  async setOverride(hookId: string, override: HookOverride): Promise<void> {
    const hook = this.registry.getHook(hookId);
    if (!hook) {
      throw new Error(`[HookOverrideStore] Unknown hook: ${hookId}`);
    }
    const { manifest } = hook;

    // AC-P2-18: Three constraint checks
    if (override.enabled === false && !manifest.disableable) {
      throw new HookOverrideConstraintError({
        hookId,
        constraint: 'disableable',
        message: `Cannot disable hook ${hookId}: manifest.disableable=false`,
      });
    }
    if (override.templateContent !== undefined && manifest.safetyTier === 'readonly') {
      throw new HookOverrideConstraintError({
        hookId,
        constraint: 'safetyTier',
        message: `Cannot override template for hook ${hookId}: manifest.safetyTier=readonly`,
      });
    }
    if (override.version !== undefined && manifest.governanceTier === 'immutable') {
      throw new HookOverrideConstraintError({
        hookId,
        constraint: 'governanceTier',
        message: `Cannot override version for hook ${hookId}: manifest.governanceTier=immutable`,
      });
    }

    // AC-P2-17: Ensure audit trail fields
    const record: HookOverride = {
      ...override,
      updatedAt: override.updatedAt || Date.now(),
    };

    // Persist (TTL=0 = no expiry, LL-048)
    await this.redis.set(overrideKey(hookId), JSON.stringify(record));
    // Track in index set for listOverrides
    await this.redis.sadd(INDEX_KEY, hookId);
  }

  // -- Clear ----------------------------------------------------------------

  async clearOverride(hookId: string): Promise<void> {
    await this.redis.del(overrideKey(hookId));
    await this.redis.srem(INDEX_KEY, hookId);
  }

  // -- List -----------------------------------------------------------------

  async listOverrides(): Promise<Array<{ hookId: string; override: HookOverride }>> {
    const hookIds = await this.redis.smembers(INDEX_KEY);
    if (hookIds.length === 0) return [];

    const results: Array<{ hookId: string; override: HookOverride }> = [];
    for (const hookId of hookIds) {
      const override = await this.getOverride(hookId);
      if (override) {
        results.push({ hookId, override });
      } else {
        // Stale index entry — clean up
        await this.redis.srem(INDEX_KEY, hookId);
      }
    }
    return results;
  }

  // -- Effective state resolution (AC-P2-15) --------------------------------

  async resolveEffective(hookId: string): Promise<EffectiveHookState> {
    const hook = this.registry.getHook(hookId);
    if (!hook) {
      throw new Error(`[HookOverrideStore] Unknown hook: ${hookId}`);
    }
    const { manifest } = hook;
    const override = await this.getOverride(hookId);

    if (!override) {
      return {
        enabled: manifest.enabled,
        version: manifest.version,
        templateOverride: null,
        source: 'baseline',
      };
    }

    return {
      enabled: override.enabled ?? manifest.enabled,
      version: override.version ?? manifest.version,
      templateOverride: override.templateContent ?? null,
      source: override.source,
    };
  }
}
