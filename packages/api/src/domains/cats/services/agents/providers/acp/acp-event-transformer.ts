/**
 * ACP Event Transformer — maps AcpSessionUpdate → AgentMessage(s).
 *
 * Pure event-by-event; per-session state is passed by caller (砚砚 三审
 * watchpoint: no module-level Map). Used by GeminiAcpAdapter to convert
 * ACP protocol events into the unified AgentMessage stream format.
 *
 * F197: Gemini CLI v0.36 packs final state into single `tool_call` event
 * (status=completed/failed + content). To satisfy the UI/ToolEventLog
 * `tool_use → tool_result` pairing model, this transformer splits such
 * single events into [tool_use, tool_result] arrays. State (`emittedToolUseByCallId`)
 * deduplicates tool_use emission per toolCallId — progress updates do NOT
 * re-emit tool_use (KD-5). Final判定仅认 `status ∈ {completed, failed}` (KD-6).
 */

import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import type { AcpSessionUpdate } from './types.js';

const log = createModuleLogger('acp-event-xform');

/**
 * Per-session state passed by caller. Created via `createAcpSessionState()`.
 * Caller is responsible for lifecycle (one Set per ACP session).
 */
export interface AcpSessionState {
  /** toolCallIds that have already emitted a `tool_use` AgentMessage. */
  emittedToolUseByCallId: Set<string>;
  /** toolCallIds that have already emitted a final `tool_result`. */
  finalEmittedByCallId: Set<string>;
}

export function createAcpSessionState(): AcpSessionState {
  return {
    emittedToolUseByCallId: new Set<string>(),
    finalEmittedByCallId: new Set<string>(),
  };
}

/** F197 KD-6: final判定仅认 status ∈ {completed, failed}. no-status content NOT final. */
function isFinalStatus(status: unknown): status is 'completed' | 'failed' {
  return status === 'completed' || status === 'failed';
}

/** Extract tool name from ACP event, tolerating field name variants across CLI versions. */
function resolveToolName(inner: Record<string, unknown>): string | undefined {
  // camelCase (our original expectation)
  if (typeof inner.toolName === 'string') return inner.toolName;
  // plain "name" (observed in some Gemini CLI versions)
  if (typeof inner.name === 'string') return inner.name;
  // snake_case variant
  if (typeof inner.tool_name === 'string') return inner.tool_name;
  // "title" — observed in Gemini CLI v0.36 production payloads
  if (typeof inner.title === 'string') return inner.title;
  return undefined;
}

/** Extract tool input from ACP event, tolerating field name variants. */
function resolveToolInput(inner: Record<string, unknown>): Record<string, unknown> | undefined {
  if (inner.toolInput && typeof inner.toolInput === 'object') return inner.toolInput as Record<string, unknown>;
  if (inner.input && typeof inner.input === 'object') return inner.input as Record<string, unknown>;
  if (inner.tool_input && typeof inner.tool_input === 'object') return inner.tool_input as Record<string, unknown>;
  return undefined;
}

export function transformAcpEvent(
  update: AcpSessionUpdate,
  catId: CatId,
  metadata: MessageMetadata,
  state?: AcpSessionState,
): AgentMessage | AgentMessage[] | null {
  // Gemini CLI may send update fields nested under `update.update` (ACP spec)
  // or flat at the top level of notification params (observed in Gemini CLI v0.35.3).
  const inner = (update.update ?? update) as Record<string, unknown>;
  const sessionUpdate = inner.sessionUpdate as string | undefined;
  const content = inner.content as { type: string; text?: string } | undefined;
  if (!sessionUpdate) return null;
  const now = Date.now();

  // Raw event diagnostic: log non-text event types and any event with unexpected content structure.
  // Helps diagnose thread-specific failures where Gemini outputs metadata instead of real content.
  if (sessionUpdate !== 'agent_message_chunk' && sessionUpdate !== 'user_message_chunk') {
    log.debug(
      {
        catId,
        sessionUpdate,
        contentType: content?.type,
        contentTextLen: content?.text?.length,
        keys: Object.keys(inner),
      },
      'ACP event received',
    );
  }

  switch (sessionUpdate) {
    case 'agent_message_chunk':
      return {
        type: 'text',
        catId,
        content: content?.text ?? '',
        metadata,
        timestamp: now,
      };

    case 'agent_thought_chunk':
      return {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'thinking', text: content?.text ?? '' }),
        metadata,
        timestamp: now,
      };

    case 'tool_call': {
      const toolName = resolveToolName(inner);
      const toolInput = resolveToolInput(inner);
      const toolCallId = typeof inner.toolCallId === 'string' ? inner.toolCallId : undefined;
      const status = inner.status;
      if (!toolName) {
        log.warn(
          { sessionUpdate, keys: Object.keys(inner), toolCallId, kind: inner.kind },
          'tool_call: could not resolve toolName',
        );
      }
      // F197 KD-5 / 砚砚 PR review P1: dedup duplicate final replay.
      // ACP stream replay / re-deliver can produce same (toolCallId, completed)
      // event multiple times — second+ occurrences must be dropped to honor
      // "仅一次 final tool_result" invariant.
      if (state && toolCallId && state.finalEmittedByCallId.has(toolCallId)) {
        return null;
      }
      const toolUse: AgentMessage = {
        type: 'tool_use',
        catId,
        ...(toolName !== undefined ? { toolName } : {}),
        ...(toolInput !== undefined ? { toolInput } : {}),
        metadata,
        timestamp: now,
      };
      // F197 AC-A1 / KD-5 / cloud-1 P1×2: final status (completed/failed) must
      // produce a tool_result even when content.text is missing/non-text/empty
      // — Recall pairing model needs the pair to complete; content '' is the
      // canonical "no payload" marker. Pre-fix the missing-content branch
      // fell through to tool_use only and left the tool permanently pending.
      if (isFinalStatus(status)) {
        const resultMsg: AgentMessage = {
          type: 'tool_result',
          catId,
          ...(toolName !== undefined ? { toolName } : {}),
          content: content?.text ?? '',
          metadata,
          timestamp: now,
        };
        // cloud-1 P1: if same toolCallId already had pending tool_use (e.g.
        // earlier tool_call(in_progress)), DO NOT re-emit tool_use — only
        // emit the result to complete the existing pair. Otherwise (first
        // observation) split into [tool_use, tool_result].
        const hasPendingToolUse = state && toolCallId ? state.emittedToolUseByCallId.has(toolCallId) : false;
        if (state && toolCallId) {
          state.emittedToolUseByCallId.add(toolCallId);
          state.finalEmittedByCallId.add(toolCallId);
        }
        return hasPendingToolUse ? resultMsg : [toolUse, resultMsg];
      }
      // Pending/in_progress/no-status → tool_use only.
      // Register state AFTER non-final branch so duplicate plain tool_call is
      // tolerated (transformer is event-by-event; dedup only blocks final replay).
      if (state && toolCallId) state.emittedToolUseByCallId.add(toolCallId);
      return toolUse;
    }

    case 'tool_call_update': {
      const toolName = resolveToolName(inner);
      const toolCallId = typeof inner.toolCallId === 'string' ? inner.toolCallId : undefined;
      const status = inner.status;
      const final = isFinalStatus(status);
      const alreadyHasToolUse = state && toolCallId ? state.emittedToolUseByCallId.has(toolCallId) : false;
      // F197 AC-A4 / KD-6: only status ∈ {completed, failed} is final. No-status
      // fallback removed — progress content is NOT promoted to result.
      if (!final) {
        // F197 AC-A2 / KD-5: progress update for known toolCallId → drop (don't
        // re-emit tool_use to avoid double-pending in Recall sidebar).
        // For unknown toolCallId without state tracking, fall back to legacy
        // tool_use emission so we don't silently lose first observation of a tool.
        if (alreadyHasToolUse) return null;
        if (state && toolCallId) {
          // First observation with no final status — emit tool_use, register state
          state.emittedToolUseByCallId.add(toolCallId);
        }
        return {
          type: 'tool_use',
          catId,
          ...(toolName !== undefined ? { toolName } : {}),
          metadata,
          timestamp: now,
        };
      }
      // F197 KD-5 / 砚砚 PR review P1: dedup duplicate final replay (same as
      // tool_call branch above — ACP can re-deliver same final event).
      if (state && toolCallId && state.finalEmittedByCallId.has(toolCallId)) {
        return null;
      }
      // Final status (completed/failed)
      const resultMsg: AgentMessage = {
        type: 'tool_result',
        catId,
        ...(toolName !== undefined ? { toolName } : {}),
        content: content?.text ?? '',
        metadata,
        timestamp: now,
      };
      if (alreadyHasToolUse) {
        // Pair completes — pending tool_use was emitted earlier.
        // cloud-2 P2 note: duplicate final guard for cross-event replay (e.g.
        // final `tool_call` → final `tool_call_update` for same toolCallId) is
        // handled by the upstream `finalEmittedByCallId.has()` check ~20 lines
        // above (before this `if (alreadyHasToolUse)` branch). Second final
        // for same toolCallId returns null before reaching this point.
        if (state && toolCallId) state.finalEmittedByCallId.add(toolCallId);
        return resultMsg;
      }
      // F197 AC-A3 boundary: toolCallId first appears as final update with no prior
      // tool_call. Split to [tool_use, tool_result] so the pair is never orphaned.
      if (state && toolCallId) {
        state.emittedToolUseByCallId.add(toolCallId);
        state.finalEmittedByCallId.add(toolCallId);
      }
      return [
        {
          type: 'tool_use',
          catId,
          ...(toolName !== undefined ? { toolName } : {}),
          metadata,
          timestamp: now,
        },
        resultMsg,
      ];
    }

    case 'plan':
      return {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'plan', text: content?.text ?? '' }),
        metadata,
        timestamp: now,
      };

    case 'user_message_chunk':
      return null;

    default:
      return null;
  }
}
