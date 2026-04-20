/**
 * Cat Context Budget Configuration
 * 优先级: 环境变量 > cat-config.json > 硬编码默认值
 *
 * 环境变量 (最高优先级, 覆盖单个字段):
 *   CAT_OPUS_MAX_PROMPT_TOKENS   → 布偶猫 prompt token 上限
 *   CAT_CODEX_MAX_PROMPT_TOKENS  → 缅因猫 prompt token 上限
 *   CAT_GEMINI_MAX_PROMPT_TOKENS → 暹罗猫 prompt token 上限
 *   MAX_PROMPT_TOKENS            → 全局默认 token (fallback)
 *
 * 或直接修改项目根目录的 cat-config.json
 */

import type { ContextBudget } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { resolveBreedId } from './breed-resolver.js';
import { getAllCatIdsFromConfig, getDefaultVariant, loadCatConfig } from './cat-config-loader.js';

const BUDGET_ENV_KEYS = {
  opus: 'CAT_OPUS_MAX_PROMPT_TOKENS',
  codex: 'CAT_CODEX_MAX_PROMPT_TOKENS',
  gemini: 'CAT_GEMINI_MAX_PROMPT_TOKENS',
} as const;

/**
 * Hardcoded defaults — keyed by breedId so all variants share the same budget.
 *
 * ⚠️ NOTE on incremental mode (GAP-1 fix): The incremental delivery path
 * (assembleIncrementalContext in route-helpers.ts) now enforces BOTH
 * maxMessages (count cap) and maxContextTokens (aggregate token budget).
 * Per-message content is still truncated by maxContentLengthPerMsg.
 */
const DEFAULT_BUDGETS: Record<string, ContextBudget> = {
  // Keep these in sync with project cat-config.json defaults (方案 A) so
  // missing/invalid config doesn't silently regress budgets.
  ragdoll: { maxPromptTokens: 180000, maxContextTokens: 160000, maxMessages: 200, maxContentLengthPerMsg: 100000 },
  'maine-coon': { maxPromptTokens: 240000, maxContextTokens: 216000, maxMessages: 200, maxContentLengthPerMsg: 100000 },
  siamese: { maxPromptTokens: 350000, maxContextTokens: 300000, maxMessages: 300, maxContentLengthPerMsg: 100000 },
};

/** F32-a: Conservative fallback for unknown/dynamic cats — use smallest built-in budget */
const GLOBAL_FALLBACK_BUDGET: ContextBudget = {
  maxPromptTokens: 100000,
  maxContextTokens: 60000,
  maxMessages: 200,
  maxContentLengthPerMsg: 100000,
};

// Cache from cat-config.json
let cachedJsonBudgets: Record<string, ContextBudget> | null = null;

function loadBudgetsFromJson(): Record<string, ContextBudget> {
  if (cachedJsonBudgets) return cachedJsonBudgets;

  try {
    const config = loadCatConfig();
    cachedJsonBudgets = {};
    for (const breed of config.breeds) {
      const defaultVariant = getDefaultVariant(breed);
      const breedBudget = defaultVariant.contextBudget;
      if (breedBudget) {
        cachedJsonBudgets[breed.catId] = breedBudget;
      }

      // F32-b: variants are independent cats (sonnet, opus-45, gpt52, spark, gemini25).
      // Variant budgets should be configurable independently, and should inherit the
      // breed default budget when not explicitly specified.
      for (const variant of breed.variants) {
        if (!variant.catId) continue;
        const effective = variant.contextBudget ?? breedBudget;
        if (effective) {
          cachedJsonBudgets[variant.catId] = effective;
        }
      }
    }
    return cachedJsonBudgets;
  } catch {
    // cat-config.json doesn't exist or is invalid
    cachedJsonBudgets = {};
    return cachedJsonBudgets;
  }
}

/**
 * Get context budget for a cat.
 * Priority: env var override (maxPromptTokens only) > cat-config.json > hardcoded defaults
 */
export function getCatContextBudget(catName: string): ContextBudget {
  // 1. Get base budget from JSON or default (resolve breedId for DEFAULT_BUDGETS)
  const jsonBudgets = loadBudgetsFromJson();
  const breedId = resolveBreedId(catName);
  const baseBudget: ContextBudget =
    jsonBudgets[catName] ??
    (breedId ? DEFAULT_BUDGETS[breedId] : undefined) ??
    DEFAULT_BUDGETS[catName] ??
    GLOBAL_FALLBACK_BUDGET; // F32-a: conservative fallback for dynamic cats

  // 2. Check for per-cat env var override
  const perCatEnvKey = BUDGET_ENV_KEYS[catName as keyof typeof BUDGET_ENV_KEYS];
  const perCatEnvValue = process.env[perCatEnvKey];
  if (perCatEnvValue?.trim()) {
    const parsed = parseInt(perCatEnvValue.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return {
        maxPromptTokens: parsed,
        maxContextTokens: baseBudget.maxContextTokens,
        maxMessages: baseBudget.maxMessages,
        maxContentLengthPerMsg: baseBudget.maxContentLengthPerMsg,
      };
    }
  }

  // 3. Check for global fallback env var
  const globalEnvValue = process.env.MAX_PROMPT_TOKENS;
  if (globalEnvValue?.trim()) {
    const parsed = parseInt(globalEnvValue.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return {
        maxPromptTokens: parsed,
        maxContextTokens: baseBudget.maxContextTokens,
        maxMessages: baseBudget.maxMessages,
        maxContentLengthPerMsg: baseBudget.maxContentLengthPerMsg,
      };
    }
  }

  return baseBudget;
}

/**
 * Get all cat budgets (for ConfigRegistry display)
 */
export function getAllCatBudgets(): Record<string, ContextBudget> {
  const result: Record<string, ContextBudget> = {};
  // F32-a: iterate catRegistry (includes dynamic cats), F032 P2: use config fallback
  const registryIds = catRegistry.getAllIds();
  const allIds = registryIds.length > 0 ? registryIds.map(String) : getAllCatIdsFromConfig();
  for (const catName of allIds) {
    result[catName] = getCatContextBudget(catName);
  }
  return result;
}

/**
 * Clear cached budgets (for testing)
 */
export function clearBudgetCache(): void {
  cachedJsonBudgets = null;
}
