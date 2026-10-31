/**
 * F33: Session Strategy Configuration
 *
 * Configurable per-cat session lifecycle strategies:
 *   - handoff: seal at threshold → new session (current default behavior)
 *   - compress: let CLI compress, don't intervene
 *   - hybrid: allow N compressions, then seal (hook-capable providers only)
 *
 * Lookup order (Phase 3):
 *   test override → runtime override (Redis, per-variant) → resolved cat config (breed) → STRATEGY_BY_BREED → provider default → global default
 *
 * Phase 2: seal-thresholds.ts merged into this file; runtime config integration added.
 * Phase 3: Runtime override via Redis + settings UI.
 */

import { createHash } from 'node:crypto';
import type { ContextHealthConfig, SessionPolicySource, SessionStrategyConfig, StrategyAction } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { resolveBreedId } from './breed-resolver.js';
import { getConfigSessionStrategy, isSessionChainEnabled } from './cat-config-loader.js';
import { getRuntimeOverrideEntry } from './session-strategy-overrides.js';

// ── Default Configurations ──

const GLOBAL_DEFAULT_STRATEGY: SessionStrategyConfig = {
  strategy: 'handoff',
  thresholds: { warn: 0.75, action: 0.85 },
  turnBudget: 12_000,
  safetyMargin: 4_000,
};

const DEFAULT_STRATEGY_BY_PROVIDER: Record<string, SessionStrategyConfig> = {
  anthropic: {
    strategy: 'handoff',
    thresholds: { warn: 0.8, action: 0.9 },
    turnBudget: 12_000,
    safetyMargin: 4_000,
  },
  openai: {
    strategy: 'handoff',
    thresholds: { warn: 0.75, action: 0.85 },
    turnBudget: 12_000,
    safetyMargin: 4_000,
  },
  google: {
    strategy: 'handoff',
    thresholds: { warn: 0.55, action: 0.65 },
    turnBudget: 12_000,
    safetyMargin: 4_000,
  },
  // clowder#915: opencode (golden chinchilla / GLM-5.1) was falling through to
  // GLOBAL_DEFAULT_STRATEGY because it had no entry here. The fallback values
  // happened to be correct (handoff @ 0.75/0.85) but the gap masked an
  // architectural issue: opencode had no first-class strategy provenance, and
  // tuning would silently be dropped. Make it a peer of anthropic/openai/google.
  opencode: {
    strategy: 'handoff',
    thresholds: { warn: 0.75, action: 0.85 },
    turnBudget: 12_000,
    safetyMargin: 4_000,
  },
};

/** breedId-keyed overrides (same breed's variants share strategy) */
const STRATEGY_BY_BREED: Record<string, Partial<SessionStrategyConfig>> = {
  // Example: ragdoll hybrid — allow 1 compression then handoff
  // ragdoll: {
  //   strategy: 'hybrid',
  //   hybrid: { maxCompressions: 1 },
  // },
};

/**
 * Test-only: per-cat strategy override. Cleared between tests.
 * Use _setTestStrategyOverride / _clearTestStrategyOverrides.
 */
const _testOverrides = new Map<string, SessionStrategyConfig>();

/** @internal Test-only: set a strategy override for a specific cat. */
export function _setTestStrategyOverride(catName: string, config: SessionStrategyConfig): void {
  _testOverrides.set(catName, config);
}

/** @internal Test-only: clear all test overrides. */
export function _clearTestStrategyOverrides(): void {
  _testOverrides.clear();
}

// ── Lookup ──

/** Source of the effective strategy config — tells the UI where the value came from. */
export type StrategySource = SessionPolicySource;

function stablePolicyRevision(source: SessionPolicySource, config: SessionStrategyConfig, seed = ''): string {
  const input = `${source}:${seed}:${JSON.stringify(config)}`;
  return `${source}:${createHash('sha256').update(input).digest('hex')}`;
}

/**
 * Get session strategy config for a cat.
 *
 * Lookup order (Phase 3):
 * 1. Test override (testing only)
 * 2. Runtime override (Redis, per-variant) — Phase 3 UI writes here
 * 3. Resolved cat config features.sessionStrategy (Phase 2: config-driven, breed level)
 * 4. STRATEGY_BY_BREED code override
 * 5. Provider default → global default
 */
export function getSessionStrategy(catName: string): SessionStrategyConfig {
  return getSessionStrategyWithSource(catName).effective;
}

/**
 * Get session strategy + its source. Used by the settings UI API to show
 * where the effective config comes from.
 */
export function getSessionStrategyWithSource(catName: string): {
  effective: SessionStrategyConfig;
  source: StrategySource;
  revision: string;
  changedAt: number;
} {
  // Test-only override (highest priority)
  const testOverride = _testOverrides.get(catName);
  if (testOverride) {
    return {
      effective: testOverride,
      source: 'runtime_override',
      revision: stablePolicyRevision('runtime_override', testOverride, 'test'),
      changedAt: 0,
    };
  }

  // Resolve the full fallback chain first (config-file → breed → provider → global)
  const fallback = resolveFallbackStrategy(catName);

  // Phase 3: Runtime override layers ON TOP of the resolved fallback,
  // so partial runtime overrides preserve lower-layer values.
  const runtimeOverride = getRuntimeOverrideEntry(catName);
  if (runtimeOverride) {
    const merged = mergeStrategyConfig(fallback.effective, runtimeOverride.config);
    return {
      effective: merged,
      source: 'runtime_override',
      revision: stablePolicyRevision('runtime_override', merged, runtimeOverride.revision),
      changedAt: runtimeOverride.changedAt,
    };
  }

  return fallback;
}

/**
 * Resolve the non-runtime fallback chain:
 *   config-file (breed sessionStrategy) → breed code → provider default → global default
 *
 * clowder-ai#1208: the former contextPolicy.lifecycle path was removed — session
 * lifecycle is configured through breed features.sessionStrategy, not through
 * the context window scalar.
 */
function resolveFallbackStrategy(catName: string): {
  effective: SessionStrategyConfig;
  source: StrategySource;
  revision: string;
  changedAt: number;
} {
  const base = getBaseStrategy(catName);

  // Phase 2: resolved cat config features.sessionStrategy (breed level)
  const configOverride = getConfigSessionStrategy(catName);
  if (configOverride) {
    const effective = mergeStrategyConfig(base, configOverride);
    return {
      effective,
      source: 'config_file',
      revision: stablePolicyRevision('config_file', effective),
      changedAt: 0,
    };
  }

  // Code-level breedId override
  const breedId = resolveBreedId(catName);
  const breedOverride = (breedId ? STRATEGY_BY_BREED[breedId] : undefined) ?? STRATEGY_BY_BREED[catName];
  if (breedOverride) {
    const effective = mergeStrategyConfig(base, breedOverride);
    return {
      effective,
      source: 'breed_code',
      revision: stablePolicyRevision('breed_code', effective),
      changedAt: 0,
    };
  }

  const legacy = deriveLegacySessionStrategy(base, isSessionChainEnabled(catName));
  if (legacy) {
    return {
      effective: legacy,
      source: 'legacy_session_chain_false',
      revision: stablePolicyRevision('legacy_session_chain_false', legacy),
      changedAt: 0,
    };
  }

  // Provider default or global default
  const provider = catRegistry.tryGet(catName)?.config.clientId;
  if (provider && DEFAULT_STRATEGY_BY_PROVIDER[provider]) {
    return {
      effective: base,
      source: 'provider_default',
      revision: stablePolicyRevision('provider_default', base),
      changedAt: 0,
    };
  }
  return {
    effective: base,
    source: 'global_default',
    revision: stablePolicyRevision('global_default', base),
    changedAt: 0,
  };
}

/**
 * #1329 read-time migration. The legacy byte remains untouched for rollback;
 * only an absent explicit policy may derive the passive compress intent.
 */
export function deriveLegacySessionStrategy(
  base: SessionStrategyConfig,
  sessionChainEnabled: boolean,
): SessionStrategyConfig | undefined {
  return sessionChainEnabled ? undefined : { ...base, strategy: 'compress' };
}

/**
 * Deep-merge a partial override into a base config.
 * Nested objects (thresholds, handoff, compress, hybrid) are merged individually
 * so that a partial override of e.g. { thresholds: { action: 0.88 } } preserves warn.
 */
export function mergeStrategyConfig(
  base: SessionStrategyConfig,
  override: Partial<SessionStrategyConfig>,
): SessionStrategyConfig {
  return {
    ...base,
    ...override,
    thresholds: { ...base.thresholds, ...override.thresholds },
    ...(override.handoff || base.handoff ? { handoff: { ...base.handoff, ...override.handoff } } : {}),
    ...(override.compress || base.compress ? { compress: { ...base.compress, ...override.compress } } : {}),
    ...(override.hybrid || base.hybrid ? { hybrid: { ...base.hybrid, ...override.hybrid } } : {}),
  } as SessionStrategyConfig;
}

function getBaseStrategy(catName: string): SessionStrategyConfig {
  // Read from catRegistry (.cat-cafe/cat-catalog.json)
  const provider = catRegistry.tryGet(catName)?.config.clientId;
  if (provider) {
    const providerDefault = DEFAULT_STRATEGY_BY_PROVIDER[provider];
    if (providerDefault) return providerDefault;
  }
  return GLOBAL_DEFAULT_STRATEGY;
}

// ── Strategy Decision ──

/**
 * Pure function: determine what action to take based on context health + strategy.
 *
 * Replaces the boolean shouldSeal() from seal-thresholds.ts with a
 * discriminated union that supports compress/hybrid strategies.
 *
 * #1208 denominator fix: `inputCeiling` is the effective input token ceiling
 * (window - output reserve), NOT the raw window. Fill ratio and remaining
 * budget are both relative to what's actually available for input tokens.
 */
export function shouldTakeAction(
  fillRatio: number,
  inputCeiling: number,
  usedTokens: number,
  hybridProgressCount: number | null,
  strategy: SessionStrategyConfig,
): StrategyAction {
  const turnBudget = strategy.turnBudget ?? 12_000;
  const safetyMargin = strategy.safetyMargin ?? 4_000;
  const remaining = inputCeiling - usedTokens;

  // Budget exhausted — strategy-aware:
  // - compress: CLI will free space by compressing, don't pre-emptively seal
  // - hybrid: allow compress if compressions remain, seal only when max reached
  // - handoff: seal immediately
  if (remaining < turnBudget + safetyMargin) {
    if (strategy.strategy === 'compress') {
      return { type: 'allow_compress' };
    }
    if (strategy.strategy === 'hybrid') {
      const max = strategy.hybrid?.maxCompressions ?? 2;
      if (hybridProgressCount === null || hybridProgressCount < max) {
        return { type: 'allow_compress' };
      }
    }
    return { type: 'seal', reason: 'budget_exhausted' };
  }

  // Below action threshold
  if (fillRatio < strategy.thresholds.action) {
    if (fillRatio >= strategy.thresholds.warn) {
      return { type: 'warn' };
    }
    return { type: 'none' };
  }

  // At or above action threshold — branch by strategy
  switch (strategy.strategy) {
    case 'handoff':
      return { type: 'seal', reason: 'threshold' };

    case 'compress':
      return { type: 'allow_compress' };

    case 'hybrid': {
      const max = strategy.hybrid?.maxCompressions ?? 2;
      if (hybridProgressCount !== null && hybridProgressCount >= max) {
        return { type: 'seal_after_compress', reason: 'max_compressions' };
      }
      return { type: 'allow_compress' };
    }
  }
}

// ── Backward Compatibility (merged from seal-thresholds.ts in Phase 2) ──

/**
 * Get seal threshold config for a cat.
 * Thin adapter: converts SessionStrategyConfig → ContextHealthConfig format.
 *
 * @deprecated Prefer getSessionStrategy() + shouldTakeAction() for new code.
 * Kept for existing tests and consumers during migration.
 */
export function getSealConfig(catName: string): ContextHealthConfig {
  const strategy = getSessionStrategy(catName);
  return {
    warnThreshold: strategy.thresholds.warn,
    sealThreshold: strategy.thresholds.action,
    turnBudget: strategy.turnBudget ?? 12_000,
    safetyMargin: strategy.safetyMargin ?? 4_000,
  };
}

/**
 * Pure function: should this session be sealed?
 *
 * @deprecated Prefer shouldTakeAction() which supports compress/hybrid strategies.
 * Kept for existing tests during migration.
 */
export function shouldSeal(
  fillRatio: number,
  windowTokens: number,
  usedTokens: number,
  config: ContextHealthConfig,
): boolean {
  if (fillRatio >= config.sealThreshold) return true;
  const turnBudget = config.turnBudget ?? 12_000;
  const safetyMargin = config.safetyMargin ?? 4_000;
  const remaining = windowTokens - usedTokens;
  return remaining < turnBudget + safetyMargin;
}
