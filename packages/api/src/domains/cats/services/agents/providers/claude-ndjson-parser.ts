/**
 * Claude CLI NDJSON event parser — 从 ClaudeAgentService 拆出的纯函数
 *
 * F23: 拆分以满足 350 行硬上限
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, TokenUsage } from '../../types.js';

/**
 * Transform a raw Claude CLI NDJSON event into AgentMessage(s).
 * Returns null to skip events we don't care about (system/hook, result/success).
 */
export function transformClaudeEvent(
  event: unknown,
  catId: CatId,
  streamState: {
    currentMessageId: string | undefined;
    partialTextMessageIds: Set<string>;
    /** F24-fix: Track last message_start's input tokens for context health */
    lastTurnInputTokens: number | undefined;
    /** F045: Accumulate thinking_delta chunks until content_block_stop */
    thinkingBuffer: string;
  },
): AgentMessage | AgentMessage[] | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as Record<string, unknown>;

  // stream_event/* (enabled by --include-partial-messages) → incremental text
  if (e.type === 'stream_event') {
    const streamEvent = e.event;
    if (typeof streamEvent !== 'object' || streamEvent === null) return null;
    const s = streamEvent as Record<string, unknown>;

    if (s.type === 'message_start') {
      const message = s.message as Record<string, unknown> | undefined;
      const messageId = message?.id;
      if (typeof messageId === 'string') {
        streamState.currentMessageId = messageId;
      }
      // F24-fix: Reset per-turn tracker on every message_start to prevent
      // stale carryover when the final turn's message_start lacks usage.
      streamState.lastTurnInputTokens = undefined;
      // Extract per-call input tokens from message_start.usage
      // Anthropic API: input_tokens = new only, cache_read/create are subsets
      // Total context fill = input_tokens + cache_read + cache_creation
      const msgUsage = message?.usage as Record<string, unknown> | undefined;
      if (msgUsage) {
        const raw = typeof msgUsage.input_tokens === 'number' ? msgUsage.input_tokens : 0;
        const cacheRead = typeof msgUsage.cache_read_input_tokens === 'number' ? msgUsage.cache_read_input_tokens : 0;
        const cacheCreate =
          typeof msgUsage.cache_creation_input_tokens === 'number' ? msgUsage.cache_creation_input_tokens : 0;
        const total = raw + cacheRead + cacheCreate;
        if (total > 0) {
          streamState.lastTurnInputTokens = total;
        }
      }
      return null;
    }

    // Fallback: some gateways report input_tokens:0 in message_start but
    // include the real value in message_delta.usage. If lastTurnInputTokens
    // is still unset, pick it up from the delta event.
    if (s.type === 'message_delta') {
      if (streamState.lastTurnInputTokens == null) {
        const deltaUsage = (s.usage ?? (s.delta as Record<string, unknown> | undefined)?.usage) as
          | Record<string, unknown>
          | undefined;
        if (deltaUsage) {
          const raw = typeof deltaUsage.input_tokens === 'number' ? deltaUsage.input_tokens : 0;
          const cacheRead =
            typeof deltaUsage.cache_read_input_tokens === 'number' ? deltaUsage.cache_read_input_tokens : 0;
          const cacheCreate =
            typeof deltaUsage.cache_creation_input_tokens === 'number' ? deltaUsage.cache_creation_input_tokens : 0;
          const total = raw + cacheRead + cacheCreate;
          if (total > 0) {
            streamState.lastTurnInputTokens = total;
          }
        }
      }
      return null;
    }

    if (s.type === 'message_stop') {
      streamState.currentMessageId = undefined;
      return null;
    }

    // F045: Reset thinking buffer when a thinking block starts
    if (s.type === 'content_block_start') {
      const contentBlock = s.content_block as Record<string, unknown> | undefined;
      if (contentBlock?.type === 'thinking') {
        streamState.thinkingBuffer = '';
      }
      return null;
    }

    if (s.type === 'content_block_delta') {
      const delta = s.delta;
      if (typeof delta !== 'object' || delta === null) return null;
      const d = delta as Record<string, unknown>;

      // F045: Accumulate thinking_delta
      if (d.type === 'thinking_delta') {
        if (typeof d.thinking === 'string') {
          streamState.thinkingBuffer += d.thinking;
        }
        return null;
      }

      // F045: Ignore signature_delta
      if (d.type === 'signature_delta') {
        return null;
      }

      if (d.type !== 'text_delta' || typeof d.text !== 'string' || d.text.length === 0) {
        return null;
      }
      if (streamState.currentMessageId) {
        streamState.partialTextMessageIds.add(streamState.currentMessageId);
      }
      return {
        type: 'text',
        catId,
        content: d.text,
        timestamp: Date.now(),
      };
    }

    // F045: Emit accumulated thinking as system_info when block ends
    if (s.type === 'content_block_stop') {
      if (streamState.thinkingBuffer.length > 0) {
        const text = streamState.thinkingBuffer;
        streamState.thinkingBuffer = '';
        return {
          type: 'system_info',
          catId,
          content: JSON.stringify({ type: 'thinking', catId, text }),
          timestamp: Date.now(),
        };
      }
      return null;
    }

    return null;
  }

  // system/init → session_init
  if (e.type === 'system' && e.subtype === 'init') {
    const sessionId = e.session_id;
    if (typeof sessionId === 'string') {
      return {
        type: 'session_init',
        catId,
        sessionId,
        timestamp: Date.now(),
      };
    }
    return null;
  }

  // F045: system/compact_boundary → system_info
  if (e.type === 'system' && e.subtype === 'compact_boundary') {
    const preTokens = typeof e.pre_tokens === 'number' ? e.pre_tokens : undefined;
    return {
      type: 'system_info',
      catId,
      content: JSON.stringify({ type: 'compact_boundary', catId, preTokens }),
      timestamp: Date.now(),
    };
  }

  // assistant → text / tool_use (multiple content blocks possible)
  if (e.type === 'assistant') {
    const message = e.message as Record<string, unknown> | undefined;
    const messageId = typeof message?.id === 'string' ? message.id : undefined;
    const skipFinalText = Boolean(messageId && streamState.partialTextMessageIds.has(messageId));
    const content = message?.content;
    if (!Array.isArray(content)) return null;

    const messages: AgentMessage[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;

      if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
        if (skipFinalText) continue;
        messages.push({
          type: 'text',
          catId,
          content: b.text,
          timestamp: Date.now(),
        });
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        messages.push({
          type: 'tool_use',
          catId,
          toolName: b.name,
          toolInput: (b.input as Record<string, unknown>) ?? {},
          timestamp: Date.now(),
        });
      }
    }
    if (messageId && skipFinalText) {
      streamState.partialTextMessageIds.delete(messageId);
    }
    return messages.length > 0 ? messages : null;
  }

  // F045: rate_limit_event → system_info
  if (e.type === 'rate_limit_event') {
    const utilization = typeof e.utilization === 'number' ? e.utilization : undefined;
    const resetsAt = typeof e.resets_at === 'string' ? e.resets_at : undefined;
    return {
      type: 'system_info',
      catId,
      content: JSON.stringify({ type: 'rate_limit', catId, utilization, resetsAt }),
      timestamp: Date.now(),
    };
  }

  // result/error → error message (F045: include errorSubtype)
  // Issue #24: Use subtype as fallback when errors array is empty
  if (e.type === 'result' && e.subtype !== 'success') {
    const rawErrors = Array.isArray(e.errors) ? e.errors : [];
    const errors = rawErrors.filter((item): item is string => typeof item === 'string').join('; ');
    const subtype = typeof e.subtype === 'string' ? e.subtype : undefined;
    const subtypeLabels: Record<string, string> = {
      error_max_turns: 'Max turns exceeded',
      error_max_budget_usd: 'Budget limit reached',
      error_during_execution: 'Execution error',
      error_max_structured_output_retries: 'Structured output retries exceeded',
    };
    const fallbackError = subtype ? (subtypeLabels[subtype] ?? `Agent error (${subtype})`) : 'Unknown error';
    return {
      type: 'error',
      catId,
      error: errors || fallbackError,
      content: JSON.stringify({ errorSubtype: subtype }),
      timestamp: Date.now(),
    };
  }

  // result/success, system/hook, etc. → skip
  return null;
}

export function isResultErrorEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return e.type === 'result' && e.subtype !== 'success';
}

/** F8: Extract token usage from Claude result/success event.
 *  Normalises inputTokens to total input (new + cache_read + cache_creation)
 *  so that the semantics match Codex/OpenAI where inputTokens = total. */
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
