/**
 * Cat Context Budget — Prompt Assembly Limits
 * clowder-ai#1208 Item 3: ALL budgets are DERIVED via derivePromptAssemblyBudget.
 *
 * Resolution order:
 *   1. Unified context capacity resolver (manual cap → CLI → model catalog → provider default).
 *   2. Breed-level default window estimate → derive via derivePromptAssemblyBudget().
 *   3. Conservative global fallback window → derive via derivePromptAssemblyBudget().
 *
 * maxMessages and maxContentLengthPerMsg are always derived from the window,
 * never independently configurable. serial/parallel/warm/cold paths all share
 * the same derived budget via computeContextBudget().
 */

import { catRegistry } from '@cat-cafe/shared';
import { resolveBreedId } from './breed-resolver.js';
import { getAllCatIdsFromConfig } from './cat-config-loader.js';
import {
  derivePromptAssemblyBudget,
  getMemberOutputReserve,
  type PromptAssemblyBudget,
  resolveContextCapacity,
} from './context-capacity.js';

/**
 * Breed-level default context windows (tokens).
 * Used when the unified resolver returns unresolved (no window configured,
 * no model in catalog, no provider default).  Each breed gets a conservative
 * estimate of its typical model's context window.
 *
 * These are NOT budgets — they are window estimates that get fed through
 * derivePromptAssemblyBudget() to produce actual prompt-assembly limits.
 * This ensures maxMessages and maxContentLengthPerMsg are always derived
 * from the window, not independently configured.
 */
const BREED_DEFAULT_WINDOWS: Record<string, number> = {
  ragdoll: 200_000, // Claude models: 200K is the conservative floor
  'maine-coon': 256_000, // Codex/GPT models: 128K-400K range
  siamese: 400_000, // Kimi/Gemini: typically 1M but conservative
  spark: 80_000, // Small/fast models
};

/** F32-a: Conservative fallback window for unknown/dynamic cats. */
const GLOBAL_FALLBACK_WINDOW = 128_000;

/**
 * Derive a prompt-assembly budget from a window estimate.
 * Applies the standard output reserve before derivation.
 */
function deriveFromWindow(catId: string, windowTokens: number): PromptAssemblyBudget {
  const outputReserve = getMemberOutputReserve(catId);
  const inputCeiling = Math.max(0, windowTokens - outputReserve);
  return derivePromptAssemblyBudget(inputCeiling);
}

/**
 * Get prompt-assembly budget for a cat.
 *
 * clowder-ai#1208 Item 3: all paths go through derivePromptAssemblyBudget().
 * The effective prompt cap = effective window - output reserve.
 * serial/parallel/warm/cold then subtract their own system/prompt/nudge
 * tokens via computeContextBudget() to get the actual context budget.
 *
 * There are no configurable maxMessages or maxContentLengthPerMsg —
 * they are always derived from the window size.
 */
export function getCatPromptBudget(catName: string): PromptAssemblyBudget {
  // 1. Resolve capacity through the unified chain.
  const config = catRegistry.tryGet(catName)?.config;
  const capacity = resolveContextCapacity({
    catId: catName,
    model: config?.defaultModel,
    provider: config?.clientId === 'opencode' ? 'opencode' : undefined,
  });

  // Resolved (any source: exact, manual, catalog, default) → derive from resolved value.
  if (capacity.source !== 'unresolved') {
    return derivePromptAssemblyBudget(capacity.inputCeilingTokens);
  }

  // 2. Unresolved → use breed-level default window → derive.
  const breedId = resolveBreedId(catName);
  const fallbackWindow =
    BREED_DEFAULT_WINDOWS[catName] ?? (breedId ? BREED_DEFAULT_WINDOWS[breedId] : undefined) ?? GLOBAL_FALLBACK_WINDOW;

  return deriveFromWindow(catName, fallbackWindow);
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
 * Budget is derived on-the-fly from contextWindow — no separate cache.
 */
export function clearBudgetCache(): void {
  // No-op: budget is derived from catRegistry.contextWindow, no separate cache.
}
