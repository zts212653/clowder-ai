/**
 * CatAgent Event Bridge — F159: Native Provider Security Baseline (AC-B4)
 *
 * Maps Anthropic Messages API responses to Cat Cafe AgentMessage events,
 * ensuring done/error/usage signals enter the existing audit chain.
 *
 * Inline types for Anthropic API shapes — no @anthropic-ai/sdk dependency.
 * Usage normalization follows the same convention as claude-ndjson-parser.ts:
 *   inputTokens = raw + cache_read + cache_creation (total input).
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, TokenUsage } from '../../../types.js';

// ── Anthropic API shapes (inline, no SDK dependency) ──

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export interface AnthropicMessageResponse {
  id: string;
  model: string;
  stop_reason: string | null;
  content: AnthropicContentBlock[];
  usage?: AnthropicUsage;
}

/**
 * Terminal stop reasons — whitelist, not blacklist.
 * Only these trigger a `done` event. Everything else (tool_use, pause_turn,
 * null from streaming message_start, or future new reasons) is NOT terminal.
 *
 * Complete set per Anthropic docs:
 * - end_turn: model finished naturally
 * - max_tokens: output length limit hit
 * - stop_sequence: custom stop sequence matched
 * - refusal: model refused to respond (safety)
 * - model_context_window_exceeded: input too large
 *
 * Ref: https://docs.anthropic.com/en/api/handling-stop-reasons
 */
export const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'refusal',
  'model_context_window_exceeded',
]);

// ── Usage mapping ──

/**
 * Convert Anthropic API usage to internal TokenUsage format.
 *
 * Normalises inputTokens to total input (raw + cache_read + cache_creation),
 * matching the convention in claude-ndjson-parser.ts extractClaudeUsage().
 *
 * Returns a valid (possibly zero-valued) TokenUsage even if the input is
 * undefined or missing fields — never crashes on partial data.
 */
export function mapAnthropicUsage(usage: AnthropicUsage | undefined): TokenUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };

  const rawInput = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
  const cacheCreate = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
  const totalInput = rawInput + cacheRead + cacheCreate;

  const result: TokenUsage = {
    inputTokens: totalInput,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
  };
  if (cacheRead > 0) result.cacheReadTokens = cacheRead;
  if (cacheCreate > 0) result.cacheCreationTokens = cacheCreate;
  return result;
}

// ── Response mapping ──

/**
 * Map a successful Anthropic Messages API response to AgentMessage events.
 *
 * Produces:
 * - One AgentMessage per content block (text / tool_use)
 * - A terminal `done` message with usage ONLY when stop_reason is in the
 *   TERMINAL_STOP_REASONS whitelist (end_turn, max_tokens, stop_sequence,
 *   refusal, model_context_window_exceeded). NOT for tool_use, pause_turn,
 *   null (streaming initial), or future non-terminal reasons.
 *
 * The caller (Phase C provider) yields these into the invocation stream,
 * where invoke-single-cat.ts routes them to audit/OTel/metrics automatically.
 */
export function mapAnthropicResponse(
  response: AnthropicMessageResponse,
  catId: CatId,
  provider: string,
): AgentMessage[] {
  const now = Date.now();
  const usage = mapAnthropicUsage(response.usage);
  const messages: AgentMessage[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      messages.push({ type: 'text', catId, content: block.text, timestamp: now });
    } else if (block.type === 'tool_use') {
      messages.push({
        type: 'tool_use',
        catId,
        toolName: block.name,
        toolInput: block.input,
        timestamp: now,
      });
    }
  }

  // Only emit done for whitelisted terminal stop reasons (see TERMINAL_STOP_REASONS).
  // Non-terminal (tool_use, pause_turn, null, future reasons) must NOT trigger done.
  if (response.stop_reason != null && TERMINAL_STOP_REASONS.has(response.stop_reason)) {
    messages.push({
      type: 'done',
      catId,
      metadata: { provider, model: response.model, usage },
      timestamp: now,
    });
  }

  return messages;
}

/**
 * Map an Anthropic API error to AgentMessage events.
 *
 * Always produces error + done (two events) — no dangling sessions.
 * The error message includes the HTTP status for audit traceability.
 */
export function mapAnthropicError(
  error: { status?: number; message?: string },
  catId: CatId,
  provider: string,
  model: string,
): AgentMessage[] {
  const now = Date.now();
  const status = error.status ?? 0;
  const msg = error.message ?? 'Unknown API error';
  const errorText = `Anthropic API error (${status}): ${msg}`;

  return [
    { type: 'error', catId, error: errorText, timestamp: now },
    {
      type: 'done',
      catId,
      metadata: { provider, model, usage: { inputTokens: 0, outputTokens: 0 } },
      timestamp: now,
    },
  ];
}
