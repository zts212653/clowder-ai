/**
 * F8: Extract token usage from Claude result/success event.
 *
 * Normalises inputTokens to total input (new + cache_read + cache_creation)
 * so that the semantics match Codex/OpenAI where inputTokens = total.
 *
 * Extracted from claude-ndjson-parser.ts to keep file under 350-line limit
 * after LI-005 added the user → tool_result bridge.
 */

import type { TokenUsage } from '../../types.js';

export function extractClaudeUsage(e: Record<string, unknown>): TokenUsage {
  const usage = (e.usage ?? {}) as Record<string, unknown>;
  const result: TokenUsage = {};
  const rawInput = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
  const cacheCreate = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
  const totalInput = rawInput + cacheRead + cacheCreate;
  if (totalInput > 0) result.inputTokens = totalInput;
  if (typeof usage.output_tokens === 'number') result.outputTokens = usage.output_tokens;
  if (cacheRead > 0) result.cacheReadTokens = cacheRead;
  if (cacheCreate > 0) result.cacheCreationTokens = cacheCreate;
  if (typeof e.total_cost_usd === 'number') result.costUsd = e.total_cost_usd;
  if (typeof e.duration_ms === 'number') result.durationMs = e.duration_ms;
  if (typeof e.duration_api_ms === 'number') result.durationApiMs = e.duration_api_ms;
  if (typeof e.num_turns === 'number') result.numTurns = e.num_turns;

  // F24: Extract context window capacity from modelUsage.
  // Claude stream-json has emitted both `modelUsage` and `model_usage` in different versions.
  const modelUsage = (e.modelUsage ?? e.model_usage) as Record<string, Record<string, unknown>> | undefined;
  if (modelUsage) {
    for (const data of Object.values(modelUsage)) {
      const contextWindow =
        typeof data.contextWindow === 'number'
          ? data.contextWindow
          : typeof data.context_window === 'number'
            ? data.context_window
            : undefined;
      if (contextWindow != null) {
        result.contextWindowSize = contextWindow;
        break;
      }
    }
  }

  return result;
}
