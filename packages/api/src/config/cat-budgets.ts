/**
 * Cat Context Budget — Prompt Assembly Limits
 * clowder-ai#1208: budget is now DERIVED from the member's resolved context window.
 *
 * Resolution order:
 *   1. Member contextWindow (Manual cap) → derive via derivePromptAssemblyBudget().
 *   2. Per-breed hardcoded defaults (graceful degradation when no window configured).
 *   3. Conservative global fallback for unknown/dynamic cats.
 *
 * Env var overrides (maxPromptTokens only) are still honored on top of the derived values.
 *
 * The old four-field ContextBudget from catalog JSON is parsed for tolerance but
 * its values are IGNORED at runtime — prompt assembly consumes only the derived budget.
 */

import type { ContextBudget } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { resolveBreedId } from './breed-resolver.js';
import { getAllCatIdsFromConfig } from './cat-config-loader.js';
import { derivePromptAssemblyBudget, resolveContextCapacity } from './context-capacity.js';

/**
 * Hardcoded per-breed defaults — used when no contextWindow is configured.
 * These represent conservative prompt-assembly limits per breed's typical model window.
 */
const DEFAULT_BUDGETS: Record<string, ContextBudget> = {
  ragdoll: { maxPromptTokens: 180000, maxContextTokens: 160000, maxMessages: 200, maxContentLengthPerMsg: 100000 },
  'maine-coon': { maxPromptTokens: 240000, maxContextTokens: 216000, maxMessages: 200, maxContentLengthPerMsg: 100000 },
  siamese: { maxPromptTokens: 350000, maxContextTokens: 300000, maxMessages: 300, maxContentLengthPerMsg: 100000 },
  spark: { maxPromptTokens: 64000, maxContextTokens: 40000, maxMessages: 100, maxContentLengthPerMsg: 100000 },
};

/** F32-a: Conservative fallback for unknown/dynamic cats */
const GLOBAL_FALLBACK_BUDGET: ContextBudget = {
  maxPromptTokens: 100000,
  maxContextTokens: 60000,
  maxMessages: 200,
  maxContentLengthPerMsg: 100000,
};

/** Convert resolved capacity into a ContextBudget shape for downstream consumers. */
function budgetFromCapacity(inputCeilingTokens: number): ContextBudget {
  const derived = derivePromptAssemblyBudget(inputCeilingTokens);
  return {
    maxPromptTokens: derived.maxPromptTokens,
    maxContextTokens: derived.maxHistoryContextTokens,
    maxMessages: derived.maxMessages,
    maxContentLengthPerMsg: derived.maxContentLengthPerMsg,
  };
}

/**
 * Get context budget for a cat.
 * clowder-ai#1208: always goes through the unified resolver so prompt assembly
 * and context-health share the same denominator. Falls back to per-breed defaults
 * only when the resolver returns unresolved (no window configured, no provider).
 */
export function getCatContextBudget(catName: string): ContextBudget {
  // 1. Resolve capacity through the unified chain (manual cap → provider default → model catalog).
  //    At budget time we don't have CLI-reported data, but provider/model are available.
  const config = catRegistry.tryGet(catName)?.config;
  const capacity = resolveContextCapacity({
    catId: catName,
    model: config?.defaultModel,
    provider: config?.clientId === 'opencode' ? 'opencode' : undefined,
  });

  const breedId = resolveBreedId(catName);
  const baseBudget: ContextBudget = capacity.actionable
    ? budgetFromCapacity(capacity.inputCeilingTokens)
    : (DEFAULT_BUDGETS[catName] ?? (breedId ? DEFAULT_BUDGETS[breedId] : undefined) ?? GLOBAL_FALLBACK_BUDGET);

  return baseBudget;
}

/**
 * Get all cat budgets (for ConfigRegistry display)
 */
export function getAllCatBudgets(): Record<string, ContextBudget> {
  const result: Record<string, ContextBudget> = {};
  const registryIds = catRegistry.getAllIds();
  const allIds = registryIds.length > 0 ? registryIds.map(String) : getAllCatIdsFromConfig();
  for (const catName of allIds) {
    result[catName] = getCatContextBudget(catName);
  }
  return result;
}

/**
 * Clear cached budgets (for testing).
 * clowder-ai#1208: budget is now derived on-the-fly from contextWindow,
 * so this only resets the legacy export compatibility.
 */
export function clearBudgetCache(): void {
  // No-op: budget is derived from catRegistry.contextWindow, no separate cache.
}
