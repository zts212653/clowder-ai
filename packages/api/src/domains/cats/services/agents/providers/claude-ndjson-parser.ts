/**
 * Claude CLI NDJSON event parser — 从 ClaudeAgentService 拆出的纯函数
 *
 * F23: 拆分以满足 350 行硬上限
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';
import { claudeAssistantEvents } from './claude-assistant-events.js';
import { type ClaudeStreamState, claudeToolResults, resetClaudeToolState } from './claude-tool-events.js';

export { extractClaudeUsage } from './claude-usage.js';

import { extractClaudeMcpStatusSnapshot } from './claude-mcp-status.js';

/**
 * Transform a raw Claude CLI NDJSON event into AgentMessage(s).
 * Returns null to skip events we don't care about (system/hook, result/success).
 */
export function transformClaudeEvent(
  event: unknown,
  catId: CatId,
  streamState: ClaudeStreamState,
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
      // F153 Phase I: emit telemetry-only agent_loop marker (provider-agnostic anchor at LLM call boundary,
      // per KD-31/KD-33). invoke-single-cat consumes this to increment recordAgentLoop; never reaches outputs.
      return { type: 'agent_loop' as const, catId, timestamp: Date.now() };
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
    resetClaudeToolState(streamState);
    const sessionId = e.session_id;
    if (typeof sessionId === 'string') {
      const sessionInit = {
        type: 'session_init',
        catId,
        sessionId,
        timestamp: Date.now(),
      } satisfies AgentMessage;
      const mcpStatus = extractClaudeMcpStatusSnapshot(e.mcp_servers);
      if (!mcpStatus) return sessionInit;
      return [
        sessionInit,
        {
          type: 'system_info',
          catId,
          content: JSON.stringify({
            type: 'mcp_server_status',
            provider: 'claude',
            catId,
            sessionId,
            pendingMeaning: 'deferred_tool_loading',
            ...mcpStatus,
          }),
          timestamp: Date.now(),
        },
      ];
    }
    return null;
  }

  // F296 B3b-3: system/compact_boundary → typed provider signal. The JSON
  // content stays for UI diagnostics, but epoch consumers use the structural
  // field below and never parse a marker substring.
  if (e.type === 'system' && e.subtype === 'compact_boundary') {
    const preTokens = typeof e.pre_tokens === 'number' ? e.pre_tokens : undefined;
    return {
      type: 'provider_signal',
      catId,
      content: JSON.stringify({ type: 'compact_boundary', catId, preTokens }),
      contextCompaction: {
        eventSource: 'claude_compact_boundary',
        ...(preTokens !== undefined ? { preTokens } : {}),
      },
      timestamp: Date.now(),
    };
  }

  if (e.type === 'user') return claudeToolResults(e, catId, streamState);
  if (e.type === 'assistant') return claudeAssistantEvents(e, catId, streamState);

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

  // #1272: result is the invocation terminal boundary. Clear any IDs that had
  // partial text but no later text-bearing assistant envelope so state cannot
  // leak into a subsequent invocation/session.
  if (e.type === 'result') {
    streamState.partialTextMessageIds.clear();
    if (!e.parent_tool_use_id) resetClaudeToolState(streamState);
  }

  // result/error → error message (F045: include errorSubtype)
  // Issue #24: Use subtype as fallback when errors array is empty
  if (isResultErrorEvent(e)) {
    const rawErrors = Array.isArray(e.errors) ? e.errors : [];
    const errors = rawErrors.filter((item): item is string => typeof item === 'string').join('; ');
    const resultText = typeof e.result === 'string' ? e.result : '';
    const subtype = typeof e.subtype === 'string' ? e.subtype : undefined;
    const subtypeLabels: Record<string, string> = {
      error_max_turns: 'Max turns exceeded',
      error_max_budget_usd: 'Budget limit reached',
      error_during_execution: 'Execution error',
      error_max_structured_output_retries: 'Structured output retries exceeded',
      success: 'Claude result error',
    };
    const fallbackError = subtype ? (subtypeLabels[subtype] ?? `Agent error (${subtype})`) : 'Unknown error';
    return {
      type: 'error',
      catId,
      error: errors || resultText || fallbackError,
      content: JSON.stringify({ errorSubtype: subtype, isError: e.is_error === true }),
      timestamp: Date.now(),
    };
  }

  // result/success, system/hook, etc. → skip
  return null;
}

export function isResultErrorEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return e.type === 'result' && (e.is_error === true || e.subtype !== 'success');
}
