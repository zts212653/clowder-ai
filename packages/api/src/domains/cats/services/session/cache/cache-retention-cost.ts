import type { TokenUsage } from '../../types.js';

/** Manual canary rate card, verified 2026-11-18; API equivalent, never subscription debit.
 * https://platform.claude.com/docs/en/about-claude/pricing
 * Rates per million tokens: new input, 5m write, 1h write, cache read.
 */
const RATES: Readonly<Record<string, readonly [number, number, number, number]>> = {
  'claude-sonnet-5-5': [2, 2.5, 4, 0.1],
  'claude-opus-5-5': [4, 5, 8, 0.2],
  'claude-fable-5-2': [8, 10, 16, 0.2],
};

export interface CacheRetentionCost {
  readonly pricingSource: 'anthropic-list-2026-11-18';
  readonly inputTier: 'standard' | 'haiku_over_100k';
  readonly readUsd: number;
  readonly writeUsd: number;
  readonly writeReadRatio: number;
}

export function cacheRetentionCost(model: string, usage: TokenUsage | undefined): CacheRetentionCost | undefined {
  if (!usage) return undefined;
  const { inputTokens, cacheReadTokens = 0, cacheCreation5mTokens, cacheCreation1hTokens } = usage;
  const tokens = [inputTokens, cacheReadTokens, cacheCreation5mTokens, cacheCreation1hTokens];
  if (tokens.some((n) => n === undefined || !Number.isSafeInteger(n) || n < 0)) return undefined;
  const total = inputTokens ?? 0,
    shortWrite = cacheCreation5mTokens ?? 0,
    longWrite = cacheCreation1hTokens ?? 0;
  const fresh = total - cacheReadTokens - shortWrite - longWrite;
  if (fresh < 0 || cacheReadTokens === 0) return undefined;
  const haikuLong = model === 'claude-haiku-5-5' && total > 100_000;
  const rates =
    model === 'claude-haiku-5-5' ? (haikuLong ? [0.5, 0.625, 1, 0.05] : [0.1, 0.125, 0.2, 0.01]) : RATES[model];
  if (!rates) return undefined;
  const [input, write5m, write1h, read] = rates;
  const readUsd = (cacheReadTokens * read) / 1_000_000;
  const writeUsd = (fresh * input + shortWrite * write5m + longWrite * write1h) / 1_000_000;
  return {
    pricingSource: 'anthropic-list-2026-11-18',
    inputTier: haikuLong ? 'haiku_over_100k' : 'standard',
    readUsd,
    writeUsd,
    writeReadRatio: writeUsd / readUsd,
  };
}
