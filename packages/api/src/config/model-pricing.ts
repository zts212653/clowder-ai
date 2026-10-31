/**
 * Model Pricing Table
 *
 * Per-model token pricing for cost estimation when the CLI doesn't
 * report cost natively (e.g. Codex CLI has tokens but no costUsd).
 *
 * Prices are per 1 million tokens, sourced from provider pricing pages.
 * Last verified: 2026-06-11 (OpenAI developers.openai.com/api/docs/pricing)
 *
 * NOTE: These are estimates. Claude CLI reports exact cost via total_cost_usd;
 * this table is only used when costUsd is missing from the CLI output.
 */

export interface ModelPricing {
  /** Price per 1M input tokens (USD) */
  inputPerMillion: number;
  /** Price per 1M cached input tokens (USD) */
  cachedInputPerMillion: number;
  /** Price per 1M output tokens (USD) */
  outputPerMillion: number;
  /** Source URL for the price card (required for new entries) */
  source?: string;
  /** Date the price + alias mapping was verified (YYYY-MM-DD) */
  verifiedAt?: string;
}

/**
 * Pricing table keyed by model name (matches metadata.model from agent service).
 * Add new models here as they become available.
 *
 * Long-context variants: OpenAI charges higher rates for models running
 * in long-context mode. Our Codex cats currently cap at 240K prompt tokens
 * (standard tier), but we include long-context entries defensively in case
 * the CLI or overrides route to a long-context variant.
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI Codex models (single tier)
  'gpt-5.3-codex': {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14.0,
  },
  // Spark variant — research preview, pricing not finalized.
  // Using gpt-5.3-codex rates as best available estimate.
  'gpt-5.3-codex-spark': {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14.0,
  },
  // OpenAI GPT-5.4 — standard context
  'gpt-5.4': {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15.0,
  },
  // OpenAI GPT-5.4 — long context (2× input, 1.5× output)
  'gpt-5.4-long': {
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 22.5,
  },
  // OpenAI GPT-5.5 — standard context
  'gpt-5.5': {
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30.0,
  },
  // OpenAI GPT-5.5 — long context (2× input, 1.5× output)
  'gpt-5.5-long': {
    inputPerMillion: 10.0,
    cachedInputPerMillion: 1.0,
    outputPerMillion: 45.0,
  },

  // ── Kimi (Moonshot) ────────────────────────────────────────────────
  // clowder-ai#1197: API-equivalent estimates only. Kimi CLI never reports
  // costUsd; subscription/OAuth mode bills via weekly+5h quota (not per
  // token), so these numbers are what the usage WOULD cost at official API
  // rates — never present them as actual billing.
  //
  // Keys must match metadata.model as reported by the client:
  //   - OAuth mode reports aliases like 'kimi-code/k3' / 'kimi-code/kimi-for-coding'
  //   - API-key mode passes raw ids like 'kimi-k3' through (kimi-config.ts)
  // Alias→model mapping per official Kimi Code docs (kimi.com/code/docs/en/):
  //   k3 = Kimi K3 · k3-256k = K3 256k variant (same model, single K3 price
  //   card) · kimi-for-coding = Kimi K2.7 Code · kimi-for-coding-highspeed =
  //   Kimi K2.7 Code HighSpeed. Aliases can drift over time — re-verify
  //   before repricing; unknown alias stays unpriced (no guessing).
  // Price cards: kimi.com/resources/kimi-{k3,k2-7-code,k2-6}-pricing
  'kimi-k3': {
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    outputPerMillion: 15.0,
    source: 'https://www.kimi.com/resources/kimi-k3-pricing',
    verifiedAt: '2026-08-09',
  },
  'kimi-code/k3': {
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    outputPerMillion: 15.0,
    source: 'https://www.kimi.com/resources/kimi-k3-pricing',
    verifiedAt: '2026-08-09',
  },
  'kimi-code/k3-256k': {
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    outputPerMillion: 15.0,
    source: 'https://www.kimi.com/resources/kimi-k3-pricing',
    verifiedAt: '2026-08-09',
  },
  'kimi-k2.7-code': {
    inputPerMillion: 0.95,
    cachedInputPerMillion: 0.19,
    outputPerMillion: 4.0,
    source: 'https://www.kimi.com/resources/kimi-k2-7-code-pricing',
    verifiedAt: '2026-08-09',
  },
  'kimi-code/kimi-for-coding': {
    inputPerMillion: 0.95,
    cachedInputPerMillion: 0.19,
    outputPerMillion: 4.0,
    source: 'https://www.kimi.com/resources/kimi-k2-7-code-pricing',
    verifiedAt: '2026-08-09',
  },
  'kimi-k2.7-code-highspeed': {
    inputPerMillion: 1.9,
    cachedInputPerMillion: 0.38,
    outputPerMillion: 8.0,
    source: 'https://www.kimi.com/resources/kimi-k2-7-code-pricing',
    verifiedAt: '2026-08-09',
  },
  'kimi-code/kimi-for-coding-highspeed': {
    inputPerMillion: 1.9,
    cachedInputPerMillion: 0.38,
    outputPerMillion: 8.0,
    source: 'https://www.kimi.com/resources/kimi-k2-7-code-pricing',
    verifiedAt: '2026-08-09',
  },
  'kimi-k2.6': {
    inputPerMillion: 0.95,
    cachedInputPerMillion: 0.16,
    outputPerMillion: 4.0,
    source: 'https://www.kimi.com/resources/kimi-k2-6-pricing',
    verifiedAt: '2026-08-09',
  },
};

export function getModelPricing(model: string): ModelPricing | undefined {
  return MODEL_PRICING[model];
}

/**
 * Estimate cost from token counts and model pricing.
 * Returns null if pricing is unavailable for the model.
 *
 * Calculation:
 *   cost = (freshInput × inputRate + cachedInput × cacheRate + output × outputRate) / 1_000_000
 *
 * Where freshInput = inputTokens − cacheReadTokens (tokens not served from cache).
 */
export function estimateCostFromTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;

  const cached = cacheReadTokens ?? 0;
  const freshInput = Math.max(0, inputTokens - cached);

  const cost =
    (freshInput * pricing.inputPerMillion +
      cached * pricing.cachedInputPerMillion +
      outputTokens * pricing.outputPerMillion) /
    1_000_000;

  // Round to 6 decimal places to avoid floating-point noise
  return Math.round(cost * 1_000_000) / 1_000_000;
}
