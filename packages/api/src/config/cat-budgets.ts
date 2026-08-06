/**
 * Cat Context Budget — Prompt Assembly Limits
 * clowder-ai#1208: budget is now DERIVED from the member's resolved context window.
 *
 * Resolution order:
 *   1. Member contextWindow (Manual cap) → derive via derivePromptAssemblyBudget().
 *   2. Per-breed hardcoded defaults (graceful degradation when no window configured).
 *   3. Conservative global fallback for unknown/dynamic cats.
 *
 * The old four-field ContextBudget type is retired from runtime consumption.
 * All consumers use PromptAssemblyBudget from context-capacity.ts.
 */

import { catRegistry } from '@cat-cafe/shared';
import { resolveBreedId } from './breed-resolver.js';
import { getAllCatIdsFromConfig } from './cat-config-loader.js';
import { derivePromptAssemblyBudget, type PromptAssemblyBudget, resolveContextCapacity } from './context-capacity.js';

/**
 * Hardcoded per-breed defaults — used when no contextWindow is configured.
 * These represent conservative prompt-assembly limits per breed's typical model window.
 */
const DEFAULT_BUDGETS: Record<string, PromptAssemblyBudget> = {
  ragdoll: {
    maxPromptTokens: 180000,
    maxHistoryContextTokens: 160000,
    maxMessages: 200,
    maxContentLengthPerMsg: 100000,
  },
  'maine-coon': {
    maxPromptTokens: 240000,
    maxHistoryContextTokens: 216000,
    maxMessages: 200,
    maxContentLengthPerMsg: 100000,
  },
  siamese: {
    maxPromptTokens: 350000,
    maxHistoryContextTokens: 300000,
    maxMessages: 300,
    maxContentLengthPerMsg: 100000,
  },
  spark: { maxPromptTokens: 64000, maxHistoryContextTokens: 40000, maxMessages: 100, maxContentLengthPerMsg: 100000 },
};

/** F32-a: Conservative fallback for unknown/dynamic cats */
const GLOBAL_FALLBACK_BUDGET: PromptAssemblyBudget = {
  maxPromptTokens: 100000,
  maxHistoryContextTokens: 60000,
  maxMessages: 200,
  maxContentLengthPerMsg: 100000,
};

/**
 * Get prompt-assembly budget for a cat.
 * clowder-ai#1208: always goes through the unified resolver so prompt assembly
 * and context-health share the same denominator. Falls back to per-breed defaults
 * only when the resolver returns unresolved (no window configured, no provider).
 */
export function getCatPromptBudget(catName: string): PromptAssemblyBudget {
  // 1. Resolve capacity through the unified chain (manual cap → provider default → model catalog).
  //    At budget time we don't have CLI-reported data, but provider/model are available.
  const config = catRegistry.tryGet(catName)?.config;
  const capacity = resolveContextCapacity({
    catId: catName,
    model: config?.defaultModel,
    provider: config?.clientId === 'opencode' ? 'opencode' : undefined,
  });

  const breedId = resolveBreedId(catName);
  return capacity.actionable
    ? derivePromptAssemblyBudget(capacity.inputCeilingTokens)
    : (DEFAULT_BUDGETS[catName] ?? (breedId ? DEFAULT_BUDGETS[breedId] : undefined) ?? GLOBAL_FALLBACK_BUDGET);
}

/**
 * Get all cat budgets (for config display).
 */
export function getAllCatBudgets(): Record<string, PromptAssemblyBudget> {
  const result: Record<string, PromptAssemblyBudget> = {};
  const registryIds = catRegistry.getAllIds();
  const allIds = registryIds.length > 0 ? registryIds.map(String) : getAllCatIdsFromConfig();
  for (const catName of allIds) {
    result[catName] = getCatPromptBudget(catName);
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
