/**
 * Degradation Policy
 * Pure functions for determining and formatting degradation strategies.
 * Part of 4-D-lite feature for Phase 4.0.
 */

import type { ContextBudget } from '@cat-cafe/shared';

export type DegradationStrategy = 'full' | 'truncated' | 'pattern_only' | 'abort';

export interface DegradationResult {
  degraded: boolean;
  strategy: DegradationStrategy;
  reason?: string;
  /** Adjusted options for context assembly */
  adjustedMaxMessages?: number;
  adjustedMaxTotalTokens?: number;
}

/**
 * Check if context assembly needs degradation based on message count and budget.
 *
 * Degradation ladder:
 * - 'full': within budget, no degradation
 * - 'truncated': exceeds 50%+ of maxMessages, truncate to budget
 * - 'abort': cannot proceed (shouldn't happen in practice)
 */
export function checkContextBudget(messageCount: number, budget: ContextBudget): DegradationResult {
  if (messageCount <= budget.maxMessages) {
    return {
      degraded: false,
      strategy: 'full',
    };
  }

  // Exceeds budget — truncate
  const ratio = messageCount / budget.maxMessages;
  if (ratio > 1.5) {
    return {
      degraded: true,
      strategy: 'truncated',
      reason: `消息数 ${messageCount} 超出预算 ${budget.maxMessages}，已截断`,
      adjustedMaxMessages: budget.maxMessages,
    };
  }

  // Slightly over — still truncate but less severe
  return {
    degraded: true,
    strategy: 'truncated',
    reason: `消息数略超预算，已截断至 ${budget.maxMessages}`,
    adjustedMaxMessages: budget.maxMessages,
  };
}

/**
 * Check if task extraction needs degradation based on history size.
 *
 * Degradation ladder:
 * - 'full': can use LLM for extraction
 * - 'pattern_only': history too large, use regex matching only
 * - 'abort': cannot proceed
 */
export function checkExtractionBudget(historyTokens: number, budget: ContextBudget): DegradationResult {
  // Use 80% of maxPromptTokens as threshold for extraction
  const extractionBudget = budget.maxPromptTokens * 0.8;

  if (historyTokens <= extractionBudget) {
    return {
      degraded: false,
      strategy: 'full',
    };
  }

  // Too large for LLM — pattern matching only
  if (historyTokens <= budget.maxPromptTokens * 2) {
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
