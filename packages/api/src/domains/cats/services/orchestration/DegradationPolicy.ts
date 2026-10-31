/**
 * Degradation Policy
 * Pure functions for determining and formatting degradation strategies.
 * Part of 4-D-lite feature for Phase 4.0.
 */

export type DegradationStrategy = 'full' | 'truncated' | 'pattern_only' | 'abort';

export interface DegradationResult {
  degraded: boolean;
  strategy: DegradationStrategy;
  reason?: string;
  /** Number of selected messages that fit the invocation ceiling. */
  includedMessages?: number;
}

/**
 * Check if task extraction needs degradation based on history size.
 *
 * Degradation ladder:
 * - 'full': can use LLM for extraction
 * - 'pattern_only': history too large, use regex matching only
 * - 'abort': cannot proceed
 */
export function checkExtractionBudget(historyTokens: number, inputCeilingTokens: number): DegradationResult {
  // Leave headroom within the invocation-owned input ceiling.
  const extractionBudget = inputCeilingTokens * 0.8;

  if (historyTokens <= extractionBudget) {
    return {
      degraded: false,
      strategy: 'full',
    };
  }

  // Too large for LLM — pattern matching only
  if (historyTokens <= inputCeilingTokens * 2) {
    return {
      degraded: true,
      strategy: 'pattern_only',
      reason: `历史过长 (${(historyTokens / 1000).toFixed(0)}k tokens)，使用模式匹配`,
    };
  }

  // Way too large — abort
  return {
    degraded: true,
    strategy: 'abort',
    reason: `历史过长 (${(historyTokens / 1000).toFixed(0)}k tokens)，无法处理`,
  };
}

/**
 * Format degradation result as a user-friendly message.
 */
export function formatDegradationMessage(result: DegradationResult): string {
  if (!result.degraded) {
    return '';
  }

  const strategyLabels: Record<DegradationStrategy, string> = {
    full: '',
    truncated: '[警告] 上下文已截断',
    pattern_only: '[警告] 使用简化模式',
    abort: '[错误] 无法处理',
  };

  const label = strategyLabels[result.strategy];
  if (result.reason) {
    return `${label}: ${result.reason}`;
  }
  return label;
}

/**
 * Check if a numeric value is exactly at a boundary.
 * Useful for testing edge cases.
 */
export function isAtBoundary(value: number, boundary: number): boolean {
  return value === boundary;
}
