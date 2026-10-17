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
import { type AcpToolSnapshot, transformAcpToolEvent } from './acp-tool-events.js';
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
  /** Latest optional tool facts by native ID; scoped to this invocation and discarded after final. */
  toolCallsByCallId: Map<string, AcpToolSnapshot>;
  /** Accumulated thinking text — flushed as a single event when a non-thinking event arrives. */
  thinkingBuffer: string;
  /**
   * OpenCode compaction scratchpad detection.
   * When the model mimics the compaction template (`## Goal`, `Constraints & Preferences`,
   * etc.) in its regular response text, subsequent chunks are suppressed.
   */
  scratchpadDetected: boolean;
  /** Trailing text window for cross-chunk compaction signature detection. */
  textTail: string;
}

export function createAcpSessionState(): AcpSessionState {
  return {
    emittedToolUseByCallId: new Set<string>(),
    finalEmittedByCallId: new Set<string>(),
    toolCallsByCallId: new Map<string, AcpToolSnapshot>(),
    thinkingBuffer: '',
    scratchpadDetected: false,
    textTail: '',
  };
}

/**
 * OpenCode compaction signature. `## Goal` alone is normal Markdown, and
 * `## Constraints & Preferences` is a normal planning heading. Suppress only
 * when the companion marker appears as the bare compaction-template line.
 */
const SCRATCHPAD_MARKER = '## Goal';
const SCRATCHPAD_COMPANION_MARKER_RE = /(?:^|\n)(?![ \t]*#{1,6}\s)[ \t]*Constraints & Preferences\b/;
const SCRATCHPAD_TAIL_CHARS = 800;

function findScratchpadSignature(text: string): number {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const markerIdx = text.indexOf(SCRATCHPAD_MARKER, searchFrom);
    if (markerIdx < 0) return -1;
    const afterMarker = text.slice(markerIdx + SCRATCHPAD_MARKER.length);
    if (SCRATCHPAD_COMPANION_MARKER_RE.test(afterMarker)) return markerIdx;
    searchFrom = markerIdx + SCRATCHPAD_MARKER.length;
  }
  return -1;
}

/**
 * Flush any accumulated thinking text as a single system_info event.
 * Call at end-of-stream to emit thinking that was the last content block.
 */
export function flushAcpThinking(state: AcpSessionState, catId: CatId, metadata: MessageMetadata): AgentMessage | null {
  if (!state.thinkingBuffer) return null;
  const text = state.thinkingBuffer;
  state.thinkingBuffer = '';
  return {
    type: 'system_info',
    catId,
    content: JSON.stringify({ type: 'thinking', text }),
    metadata,
    timestamp: Date.now(),
  };
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

  // Flush accumulated thinking before any non-thinking event.
  // Mirrors claude-ndjson-parser's thinkingBuffer → content_block_stop pattern.
  const flushPending =
    state && state.thinkingBuffer && sessionUpdate !== 'agent_thought_chunk'
      ? flushAcpThinking(state, catId, metadata)
      : null;

  /** Wrap result with flushed thinking (if any) — returns array when both exist. */
  function withFlush(msg: AgentMessage | AgentMessage[] | null): AgentMessage | AgentMessage[] | null {
    if (!flushPending) return msg;
    if (!msg) return flushPending;
    if (Array.isArray(msg)) return [flushPending, ...msg];
    return [flushPending, msg];
  }

  switch (sessionUpdate) {
    case 'usage_update': {
      const used = typeof inner.used === 'number' && Number.isFinite(inner.used) ? inner.used : undefined;
      const size = typeof inner.size === 'number' && Number.isFinite(inner.size) ? inner.size : undefined;
      if (used == null && size == null) return withFlush(null);
      return withFlush({
        type: 'agent_loop',
        catId,
        metadata: {
          ...metadata,
          usage: {
            ...(used != null ? { contextUsedTokens: used, lastTurnInputTokens: used } : {}),
            ...(size != null ? { contextWindowSize: size } : {}),
          },
        },
        timestamp: now,
      });
    }

    case 'agent_message_chunk': {
      const text = content?.text ?? '';
      if (state) {
        // Once scratchpad is detected, suppress all subsequent text chunks.
        if (state.scratchpadDetected) return withFlush(null);

        // Cross-chunk detection: combine trailing window with current chunk.
        const combined = state.textTail + text;
        const markerIdx = findScratchpadSignature(combined);
        if (markerIdx >= 0) {
          state.scratchpadDetected = true;
          log.info({ catId }, 'Suppressing OpenCode compaction scratchpad from ACP text stream');
          // Emit only the portion of the current chunk before the marker.
          const cleanEnd = markerIdx - state.textTail.length;
          if (cleanEnd <= 0) return withFlush(null);
          // Trim trailing whitespace that precedes the scratchpad header.
          const clean = text.slice(0, cleanEnd).replace(/[\s\n]+$/, '');
          if (!clean) return withFlush(null);
          return withFlush({ type: 'text', catId, content: clean, metadata, timestamp: now });
        }
        // Keep trailing window bounded for cross-chunk detection.
        state.textTail = combined.length > SCRATCHPAD_TAIL_CHARS ? combined.slice(-SCRATCHPAD_TAIL_CHARS) : combined;
      }
      return withFlush({ type: 'text', catId, content: text, metadata, timestamp: now });
    }

    case 'agent_thought_chunk':
      // Accumulate — emit nothing until a non-thinking event flushes the buffer.
      if (state) {
        state.thinkingBuffer += content?.text ?? '';
        return null;
      }
      // No state (shouldn't happen) — fall back to immediate emit.
      return {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'thinking', text: content?.text ?? '' }),
        metadata,
        timestamp: now,
      };

    case 'tool_call':
    case 'tool_call_update':
      return withFlush(transformAcpToolEvent(inner, catId, metadata, now, state));

    case 'plan': {
      // #1203: Empty/whitespace plan text carries no information and the
      // frontend has no plan formatter — drop it instead of leaking raw
      // `{"type":"plan","text":""}` JSON into chat. Non-empty plans unchanged.
      const planText = typeof content?.text === 'string' ? content.text : '';
      if (!planText.trim()) return withFlush(null);
      return withFlush({
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'plan', text: planText }),
        metadata,
        timestamp: now,
      });
    }

    case 'user_message_chunk':
      return withFlush(null);

    default:
      return withFlush(null);
  }
}
