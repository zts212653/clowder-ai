/**
 * Cat Context Budget — Capacity Resolution + Prompt Assembly Limits
 * clowder-ai#1208 Item 3 + P1-2: ALL budgets are DERIVED via derivePromptAssemblyBudget.
 *
 * Resolution is via the unified context capacity resolver ONLY.  No breed-level
 * defaults or hardcoded fallback windows — when unresolved, the budget is zero
 * and `source` is 'unresolved'.  Lifecycle code already gates on actionable;
 * routing callers must handle zero-budget gracefully (log + conservative fallback
 * at the CALL SITE, not here).
 *
 * maxMessages and maxContentLengthPerMsg are always derived from the window,
 * never independently configurable.
 */

import { catRegistry } from '@cat-cafe/shared';
import { getAllCatIdsFromConfig } from './cat-config-loader.js';
import {
  type ContextCapacityConfidence,
  derivePromptAssemblyBudget,
  type PromptAssemblyBudget,
  resolveContextCapacity,
} from './context-capacity.js';

// ─── Enriched return type ───────────────────────────────────────────

/**
 * Resolved capacity + derived prompt-assembly budget for a single cat.
 *
 * #1208 P1-2: includes capacity metadata (source, actionable, confidence)
 * so consumers can distinguish resolved from unresolved — no more silent
 * breed-level fallbacks that masquerade as real capacity.
 */
export interface CatCapacityBudget {
  /** Effective input ceiling tokens (window - output reserve). 0 when unresolved. */
  readonly inputCeilingTokens: number;
  /** How the capacity was determined. */
  readonly source: ContextCapacityConfidence;
  /** Whether the value is authoritative for lifecycle actions. */
  readonly actionable: boolean;
  /** Numeric confidence (0.0–1.0). */
  readonly confidence: number;
  /** Derived prompt-assembly limits. Zero-valued when unresolved. */
  readonly budget: PromptAssemblyBudget;
}

// ─── Resolution ─────────────────────────────────────────────────────

/**
 * Resolve a cat's full capacity + derived budget.
 *
 * When unresolved: inputCeilingTokens=0, budget fields are zero-valued,
 * source='unresolved', actionable=false.  Routing callers that need a
 * non-zero budget MUST apply their own explicit fallback.
 */
export function getCatCapacity(catName: string): CatCapacityBudget {
  const config = catRegistry.tryGet(catName)?.config;
  const capacity = resolveContextCapacity({
    catId: catName,
    model: config?.defaultModel,
    provider: config?.clientId === 'opencode' ? 'opencode' : undefined,
  });

  return {
    inputCeilingTokens: capacity.inputCeilingTokens,
    source: capacity.source,
    actionable: capacity.actionable,
    confidence: capacity.confidence,
    budget: derivePromptAssemblyBudget(capacity.inputCeilingTokens),
  };
}

/**
 * Get prompt-assembly budget for a cat (routing convenience wrapper).
 *
 * Returns the derived PromptAssemblyBudget.  When capacity is unresolved,
 * the budget has zero-valued fields — routing callers should check for
 * maxPromptTokens===0 and apply their own conservative fallback.
 */
export function getCatPromptBudget(catName: string): PromptAssemblyBudget {
  return getCatCapacity(catName).budget;
}

/**
 * Get all cat budgets with capacity metadata (for config snapshot/Hub display).
 */
export function getAllCatBudgets(): Record<string, CatCapacityBudget> {
  const result: Record<string, CatCapacityBudget> = {};
  const registryIds = catRegistry.getAllIds();
  const allIds = registryIds.length > 0 ? registryIds.map(String) : getAllCatIdsFromConfig();
  for (const catName of allIds) {
    result[catName] = getCatCapacity(catName);
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
