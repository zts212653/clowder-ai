/**
 * F252 Story Player — TranscriptEvent → ReplayEvent Adapter
 *
 * Normalizes raw transcript events (from events.jsonl / session API)
 * into the unified ReplayEvent format consumed by the Replay Engine.
 *
 * Key normalizations:
 * - Event types: text/assistant → message; tool_use + tool_result → tool_call
 * - Tool names: toolName / name dual form → toolName
 * - Content: string | ContentBlock[] → string
 */

import { formatGovernanceBlocked, formatVisibleSystemInfo } from '@/hooks/system-info-visible';
import { resolveProviderSemanticMessage } from '@/lib/provider-semantic-registry';
import { transcriptToolCallKey, transcriptToolScope } from '@/lib/transcript-tool-identity';
import type { RawTranscriptEvent, ReplayEvent, ReplayEventType } from './types';

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/**
 * Extract text content from various event payload shapes.
 * Handles both plain string and Claude API ContentBlock[] format.
 */
function extractContent(event: Record<string, unknown>): string {
  const raw = event.content;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    // Claude API format: [{type: 'text', text: '...'}]
    return raw
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === 'object' && block !== null && 'text' in block,
      )
      .map((block) => block.text)
      .join('');
  }
  return '';
}

/**
 * Normalize tool name from dual form: toolName (production) / name (raw NDJSON).
 * Prefers toolName when both are present.
 */
function normalizeToolName(event: Record<string, unknown>): string | undefined {
  const toolName = event.toolName as string | undefined;
  const name = event.name as string | undefined;
  return toolName ?? name;
}

/**
 * Normalize tool input from dual form and type:
 * - Production AgentMessage: `toolInput: Record<string, unknown>`
 * - Legacy raw NDJSON: `input: Record<string, unknown>` or `input: string`
 * Prefers toolInput. Stringifies Record values for display.
 */
function normalizeToolInput(event: Record<string, unknown>): string | undefined {
  const raw = event.toolInput ?? event.input;
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') return JSON.stringify(raw);
  return undefined;
}

// ---------------------------------------------------------------------------
// Event type classification
// ---------------------------------------------------------------------------

/** Message-type events that become 'message' ReplayEvents */
const MESSAGE_TYPES = new Set(['text', 'assistant', 'user']);

/** System-type events */
const SYSTEM_TYPES = new Set(['system', 'session_init', 'done', 'error', 'timeout']);

/** Map event type → message role */
const TYPE_TO_ROLE: Record<string, string> = {
  text: 'assistant',
  assistant: 'assistant',
  user: 'user',
  system: 'system',
};

function classifyEvent(
  evtType: string,
  event: Record<string, unknown>,
): { replayType: ReplayEventType; role: string; contentOverride?: string } | null {
  const extra =
    typeof event.extra === 'object' && event.extra !== null ? (event.extra as Record<string, unknown>) : null;
  const semanticCandidate = event.semanticEvent ?? extra?.semanticEvent;
  if (semanticCandidate !== undefined) {
    const semantic = resolveProviderSemanticMessage(semanticCandidate);
    if (semantic.action === 'suppress') return null;
    if (semantic.action === 'replace') {
      return { replayType: 'system', role: 'system', contentOverride: semantic.projection.content };
    }
  }
  if (MESSAGE_TYPES.has(evtType)) {
    return { replayType: 'message', role: TYPE_TO_ROLE[evtType] ?? evtType };
  }
  if (SYSTEM_TYPES.has(evtType)) {
    return { replayType: 'system', role: 'system' };
  }
  if (evtType === 'thinking') {
    return { replayType: 'thinking', role: 'assistant' };
  }
  if (evtType === 'cli_stdout') {
    return { replayType: 'cli_stdout', role: 'assistant' };
  }
  // system_info may carry thinking content as JSON: { type: 'thinking', text: '...' }.
  // Some system_info payloads are visible live-chat notices; format them through
  // the same helper used by useAgentMessages so replay doesn't invent a second
  // system-notice truth source. Unknown JSON remains suppressed to avoid raw
  // provider/runtime payloads in Theater replay.
  if (evtType === 'system_info') {
    const parsed = tryParseSystemInfoContent(event);
    if (parsed?.type === 'thinking' && typeof parsed.text === 'string') {
      return { replayType: 'thinking', role: 'assistant', contentOverride: parsed.text };
    }
    if (parsed) {
      const visible = formatReplayVisibleSystemInfo(parsed);
      if (visible) return { replayType: 'system', role: 'system', contentOverride: visible.content };
    }
    return null;
  }
  if (evtType === 'tool_use') {
    return { replayType: 'tool_call', role: 'assistant' };
  }
  // tool_result is consumed by pairing, not emitted standalone
  // Unknown types are skipped
  return null;
}

/**
 * Try to parse system_info content as JSON.
 * Agent providers emit thinking as system_info with JSON content:
 * { type: 'thinking', text: '...', catId?: string }
 */
function tryParseSystemInfoContent(event: Record<string, unknown>): Record<string, unknown> | null {
  const content = event.content;
  if (typeof content !== 'string') return null;
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {
    // Non-JSON system_info content is operational noise, not replay speech.
  }
  return null;
}

function formatReplayVisibleSystemInfo(parsed: Record<string, unknown>) {
  const liveVisible = formatVisibleSystemInfo(parsed);
  if (liveVisible) return liveVisible;

  return formatGovernanceBlocked(parsed);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Internal helpers (extracted to reduce cognitive complexity)
// ---------------------------------------------------------------------------

/** Extracted result payload shape used by both index and orphan queue. */
interface ToolResultPayload {
  content: string;
  isError: boolean;
  input?: string;
}

/**
 * Detect tool result error status from multiple production formats:
 * - `is_error: true` (Claude API / legacy)
 * - `toolResultStatus: 'error'` (Clowder AI production events, types.ts:175)
 * - `status: 'error'` (legacy variant)
 */
function isToolResultError(event: Record<string, unknown>): boolean {
  if (event.is_error) return true;
  if (event.toolResultStatus === 'error') return true;
  if (event.status === 'error') return true;
  return false;
}

/**
 * Pair only prior pending calls in their execution scope. Index by use event
 * identity so sequential legacy ID reuse cannot attach a future result.
 */
function buildToolResultIndex(raw: RawTranscriptEvent[]): Map<RawTranscriptEvent, ToolResultPayload> {
  const index = new Map<RawTranscriptEvent, ToolResultPayload>();
  const pending = new Map<string, RawTranscriptEvent>();
  for (const evt of raw) {
    const key = transcriptToolCallKey(evt);
    if (!key) continue;
    if (evt.event.type === 'tool_use') {
      pending.set(key, evt);
      continue;
    }
    if ((evt.event.type as string) !== 'tool_result') continue;
    const use = pending.get(key);
    if (use) {
      index.set(use, {
        content: extractContent(evt.event),
        isError: isToolResultError(evt.event),
        input: normalizeToolInput(evt.event),
      });
      pending.delete(key);
    }
  }
  return index;
}

/**
 * Build positional orphan pairs: map each no-id tool_use eventNo to the
 * no-id tool_result that immediately follows it in the event stream
 * (with no other no-id tool_use in between).
 *
 * This handles providers like Codex that emit file_change as tool_use
 * without a corresponding tool_result — the old FIFO approach would
 * mis-pair the next result (belonging to a different tool_use) with
 * the result-less file_change.
 */
function buildPositionalOrphanPairs(raw: RawTranscriptEvent[]): Map<RawTranscriptEvent, ToolResultPayload> {
  const pairs = new Map<RawTranscriptEvent, ToolResultPayload>();
  // Scope pending tool_use by sessionId to prevent cross-session mis-pairing
  // when thread replay interleaves events from multiple sessions (P1 fix AC-E2)
  const pendingBySession = new Map<string, RawTranscriptEvent>();

  for (const evt of raw) {
    const evtType = evt.event.type as string;
    const toolUseId = transcriptToolCallKey(evt);
    const sid = transcriptToolScope(evt);

    if (evtType === 'tool_use' && !toolUseId) {
      // New no-id tool_use supersedes any pending one in the same session
      pendingBySession.set(sid, evt);
    } else if (evtType === 'tool_result' && !toolUseId) {
      // No-id tool_result pairs with most recent pending no-id tool_use in same session
      const pendingEventNo = pendingBySession.get(sid);
      if (pendingEventNo != null) {
        pairs.set(pendingEventNo, {
          content: extractContent(evt.event),
          isError: isToolResultError(evt.event),
          input: normalizeToolInput(evt.event),
        });
        pendingBySession.delete(sid);
      }
    }
  }

  return pairs;
}

/**
 * Enrich a tool_call ReplayEvent with paired tool_result data.
 * Explicit native IDs require a match; only legacy no-ID events use position.
 */
function enrichToolCall(
  replayEvent: ReplayEvent,
  envelope: RawTranscriptEvent,
  toolResults: Map<RawTranscriptEvent, ToolResultPayload>,
  orphanPairs: Map<RawTranscriptEvent, ToolResultPayload>,
): void {
  const rawEvent = envelope.event;
  replayEvent.toolName = normalizeToolName(rawEvent);
  replayEvent.toolInput = normalizeToolInput(rawEvent);

  const toolUseId = transcriptToolCallKey(envelope);
  if (toolUseId) {
    const matched = toolResults.get(envelope);
    if (matched) {
      replayEvent.toolResult = matched.content;
      if (matched.input !== undefined) replayEvent.toolInput = matched.input;
      replayEvent.toolIsError = matched.isError;
    }
  } else {
    // Positional match for orphan no-id events (e.g. Codex command_execution)
    const orphan = orphanPairs.get(envelope);
    if (orphan) {
      replayEvent.toolResult = orphan.content;
      if (orphan.input !== undefined) replayEvent.toolInput = orphan.input;
      replayEvent.toolIsError = orphan.isError;
    }
  }
  // Default toolIsError to false if no result matched
  replayEvent.toolIsError ??= false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Adapt raw TranscriptEvents into ReplayEvents.
 *
 * - Pairs tool_use + tool_result by toolUseId (exact) or FIFO (orphan fallback)
 * - Normalizes message types and tool names
 * - Assigns monotonic indexes
 * - Skips unknown event types
 */
export function adaptTranscriptEvents(raw: RawTranscriptEvent[]): ReplayEvent[] {
  const toolResults = buildToolResultIndex(raw);
  const orphanPairs = buildPositionalOrphanPairs(raw);
  const result: ReplayEvent[] = [];
  let index = 0;

  for (const evt of raw) {
    const evtType = evt.event.type as string | undefined;
    if (!evtType || evtType === 'tool_result') continue;

    const classification = classifyEvent(evtType, evt.event);
    if (!classification) continue;

    const { replayType, role, contentOverride } = classification;
    const replayEvent: ReplayEvent = {
      index,
      type: replayType,
      timestamp: evt.t,
      role,
      content: contentOverride ?? extractContent(evt.event),
      eventNo: evt.eventNo,
      catId: evt.catId,
      invocationId: evt.invocationId,
      sourceThreadId: evt.threadId,
    };

    if (replayType === 'tool_call') {
      enrichToolCall(replayEvent, evt, toolResults, orphanPairs);
    }

    result.push(replayEvent);
    index++;
  }

  return result;
}
