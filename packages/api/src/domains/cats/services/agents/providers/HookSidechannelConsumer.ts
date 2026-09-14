/**
 * F230 B-hook: HookSidechannelConsumer
 *
 * Pure-function transforms from Claude hook sidechannel events (Stop,
 * PostToolUse) to AgentMessages. Replaces BgTranscriptEventConsumer for
 * the interactive PTY carrier's output face.
 *
 * Hook events arrive via a sidecar jsonl file written by hook capture
 * scripts (configured in `.claude/settings.json`). The sidecar is tailed
 * by the same TranscriptTailer used for transcript jsonl.
 *
 * Design decisions (from Fable-5 spike b570d6148 + KD-7):
 * - Stop event → text AgentMessage (last_assistant_message = full reply)
 * - PostToolUse → tool_use + tool_result AgentMessages (tool step visibility + LI-005 durable trigger)
 * - PostToolUseFailure → tool_result(error) AgentMessage (LI-005: failure path bridge)
 * - Stop = terminal signal (replaces transcript turn_duration detection)
 * - session_id from hook events (backup for transcript-watch)
 * - No usage/token data from hooks — accepted degradation
 *
 * Lifecycle: session_init and done are NOT emitted here — the carrier
 * manages them (same as BgTranscriptEventConsumer contract).
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';

export interface HookConsumerOptions {
  catId: CatId;
}

/**
 * Normalize tool_response from hook events to a string for downstream parsing.
 * PostToolUse tool_response shapes vary by tool:
 *   - Read: `{type:'text', file:{content:'...', totalLines:50}}`
 *   - Bash: `{stdout:'...'}`
 *   - MCP: `'{"status":"ok",...}'` (string) or structured object
 *   - Missing: `undefined`
 */
function normalizeToolResponse(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') return JSON.stringify(raw);
  return String(raw);
}

/**
 * Transform hook sidecar entries to AgentMessages.
 *
 * Pure function — no I/O, no state. Safe for incremental tailing.
 * Stop, PostToolUse, and PostToolUseFailure are recognized; unknown events are skipped.
 */
export function hookEntriesToAgentMessages(entries: unknown[], options: HookConsumerOptions): AgentMessage[] {
  const { catId } = options;
  const out: AgentMessage[] = [];

  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const hookName = entry.hook_event_name;

    if (hookName === 'Stop') {
      if (typeof entry.last_assistant_message !== 'string') continue;
      out.push({
        type: 'text',
        catId,
        content: entry.last_assistant_message,
        timestamp: Date.now(),
      });
      continue;
    }

    if (hookName === 'PostToolUse') {
      if (typeof entry.tool_name !== 'string') continue;
      const toolUseId = typeof entry.tool_use_id === 'string' ? entry.tool_use_id : undefined;
      out.push({
        type: 'tool_use',
        catId,
        toolName: entry.tool_name,
        toolInput: (typeof entry.tool_input === 'object' && entry.tool_input !== null
          ? entry.tool_input
          : {}) as Record<string, unknown>,
        toolUseId,
        timestamp: Date.now(),
      });
      // LI-005: emit tool_result for durable trigger classification.
      // PostToolUse fires on successful tool completion (per cc hook contract).
      // tool_response shape varies by tool: string, object, or array.
      // Normalize to string so classifyDurableTriggerResult Level 2 can parse.
      const resultMsg: AgentMessage = {
        type: 'tool_result',
        catId,
        content: normalizeToolResponse(entry.tool_response),
        timestamp: Date.now(),
        toolResultStatus: 'ok',
      };
      if (toolUseId) resultMsg.toolUseId = toolUseId;
      out.push(resultMsg);
      continue;
    }

    // LI-005: PostToolUseFailure → tool_result(error) for failure path.
    // cc fires PostToolUseFailure on tool execution failure; PostToolUse is
    // success-only. Registering both ensures confirmedCallbackToolNames
    // correctly excludes failed durable triggers.
    if (hookName === 'PostToolUseFailure') {
      const toolUseId = typeof entry.tool_use_id === 'string' ? entry.tool_use_id : undefined;
      const resultMsg: AgentMessage = {
        type: 'tool_result',
        catId,
        content: normalizeToolResponse(entry.tool_response),
        timestamp: Date.now(),
        toolResultStatus: 'error',
      };
      if (toolUseId) resultMsg.toolUseId = toolUseId;
      out.push(resultMsg);
    }

    // Unknown hook event names — silently skip
  }

  return out;
}

/**
 * Detect whether a hook entry is the terminal signal (Stop event).
 *
 * Replaces `entry.type === 'system' && entry.subtype === 'turn_duration'`
 * from the transcript-based terminal detection path.
 */
export function isHookTerminalEvent(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  return (entry as Record<string, unknown>).hook_event_name === 'Stop';
}

/**
 * Extract the first session_id from hook entries.
 *
 * Hook events carry session_id on every event. This provides a backup
 * for session_init when transcript-based session detection fails.
 */
export function extractSessionIdFromHookEntries(entries: unknown[]): string | undefined {
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.session_id === 'string') return entry.session_id;
  }
  return undefined;
}

/**
 * Extract CLAUDE_CODE_ENTRYPOINT from enriched hook entries.
 *
 * The capture script injects `_cc_entrypoint` into each hook event JSON
 * from the $CLAUDE_CODE_ENTRYPOINT env var (F230 follow-up ①). This is
 * the billing identity proof — 'cli' means interactive subscription
 * billing, 'sdk-cli' means API billing.
 */
export function extractEntrypointFromHookEntries(entries: unknown[]): string | undefined {
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry._cc_entrypoint === 'string') return entry._cc_entrypoint;
  }
  return undefined;
}
