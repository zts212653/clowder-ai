/**
 * F198 Phase B Step 2: BgTranscriptEventConsumer
 *
 * Consumes `claude --bg` job's transcript jsonl (linkScanPath from state.json)
 * and produces AgentMessages equivalent to what -p NDJSON path produces via
 * ClaudeAgentService. This is the Parity Gate — without this, --bg loses
 * partial text / tool_use / system_info / usage visibility vs -p (R2
 * Hub observability hard constraint, 砚砚 cross-cat Design Gate 2026-05-14).
 *
 * Design (single source of truth):
 * - transcript jsonl `assistant` entries match -p NDJSON `assistant` event
 *   shape exactly. Reuse `transformClaudeEvent` — no second event semantic.
 * - transcript `system` subtypes (verified by real --bg sample 2026-05-14):
 *   BOTH skipped (no user-facing message). `turn_duration` is a terminal signal
 *   consumed by the carrier via entry.subtype; its timing flows into usage through
 *   accumulateUsageFromEntries, not a message (F230 blue-bubble fix). `stop_hook_summary`
 *   is hook diagnostics. Matches -p parity: transformClaudeEvent emits nothing for either.
 * - usage uses `extractClaudeUsage` via synthetic result event (per砚砚 P1.2
 *   review — true reuse, not duplicated normalization rules).
 *
 * Lifecycle separation (per砚砚 P1.1 review):
 * - `session_init` and `done` are NOT emitted by this module — caller
 *   (carrier) manages them across the streaming lifecycle. Otherwise
 *   file-tail increments would re-emit init/done per chunk (broken).
 *
 * Public API:
 *   `transcriptEntriesToAgentMessages(entries, {catId})` → AgentMessage[]
 *     Pure transform: assistant entries → text/tool_use/error; system + bookkeeping
 *     entries are skipped (no user-facing message).
 *   `extractTranscriptUsage(entries, terminalMeta?)` → TokenUsage
 *     Aggregate per-turn usage + reuse extractClaudeUsage normalization.
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, TokenUsage } from '../../types.js';
import { extractClaudeUsage, transformClaudeEvent } from './claude-ndjson-parser.js';

export interface TranscriptEntriesToAgentMessagesOptions {
  catId: CatId;
}

export interface TerminalMeta {
  totalCostUsd?: number;
  /** Optional override; otherwise summed from `system.turn_duration` entries. */
  durationMs?: number;
  /** Optional override; otherwise counted from `assistant` entries. */
  numTurns?: number;
}

/**
 * Pure transform: transcript entry chunk → AgentMessages (no session_init,
 * no done — caller manages lifecycle).
 *
 * Safe to call incrementally as new entries are tailed from transcript jsonl.
 * Each call gets fresh transformer state; partial-text streaming semantics
 * (currentMessageId / partialTextMessageIds) don't apply because transcript
 * is written at message_stop (per-message granularity, not per-token).
 */
export function transcriptEntriesToAgentMessages(
  entries: unknown[],
  options: TranscriptEntriesToAgentMessagesOptions,
): AgentMessage[] {
  const { catId } = options;
  const out: AgentMessage[] = [];

  // Transformer state — per-call, not persistent. transcript entries always
  // carry complete messages so partial-text tracking is unused.
  const state = {
    currentMessageId: undefined as string | undefined,
    partialTextMessageIds: new Set<string>(),
    lastTurnInputTokens: undefined as number | undefined,
    thinkingBuffer: '',
  };

  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;

    if (entry.type === 'assistant') {
      // F230 P2-synthetic: Claude CLI synthesizes assistant entries locally for two cases:
      //   1. "No response requested." — nothing to do (zero API calls, zero tokens)
      //   2. "API Error: ..." — ECONNRESET / network hiccup (CLI makes it look like a reply)
      // These must NEVER surface as cat chat bubbles. Filter before transformClaudeEvent.
      const msg = entry.message as Record<string, unknown> | undefined;
      if (msg?.model === '<synthetic>') {
        const content = msg?.content as Array<{ type: string; text?: string }> | undefined;
        const text = content?.find((c) => c.type === 'text')?.text ?? '';
        if (text.startsWith('API Error:') || text.startsWith('Error:')) {
          out.push({ type: 'error', catId, error: text, timestamp: Date.now() });
        }
        // "No response requested." and other synthetic variants → silently drop
        continue;
      }
      // assistant shape matches -p NDJSON assistant event → feed directly.
      const result = transformClaudeEvent(entry, catId, state);
      if (result == null) continue;
      if (Array.isArray(result)) out.push(...result);
      else out.push(result);
    }

    // Skip everything else (produce no user-facing AgentMessage):
    //   - system/turn_duration: per-turn TERMINAL timing signal. The carrier detects it via
    //     entry.subtype to stop tailing (ClaudeBgCarrierService / ClaudeInteractivePtyCarrierService)
    //     and accumulateUsageFromEntries reads its durationMs directly — no message is needed.
    //     Surfacing it as system_info caused the raw-JSON "blue bubble" regression on the active
    //     PTY path (F230): the active stream yielded {"type":"turn_duration",...} and a frontend
    //     caller rendered it before the system-info-visible.ts suppression could drop it (that
    //     suppression was a band-aid covering only the bg-path callers). The -p NDJSON baseline
    //     (transformClaudeEvent) emits nothing for turn_duration either, so skipping it here
    //     also restores the bg/PTY ⇄ -p parity this consumer is meant to guarantee.
    //   - system/stop_hook_summary: hook diagnostics — not user-facing.
    //   - last-prompt / file-history-snapshot / agent-name / ai-title / user / attachment /
    //     permission-mode / etc.: transcript bookkeeping, not content.
  }

  return out;
}

/**
 * Incremental usage accumulator — invariant scalar size so memory does not
 * grow with transcript length (cloud codex round-12 P2 fix 2026-05-14):
 * carrier caller must NOT retain `unknown[]` of full entries just to
 * compute usage.
 *
 * Token fields use `number | undefined` (cloud codex round-14 P2 fix
 * 2026-05-14): only set when actually observed in transcript usage data.
 * Starting at 0 would emit synthetic `outputTokens: 0` to telemetry when
 * assistant entries exist sans message.usage — misleading cost/usage
 * dashboards. undefined = "never observed", not "observed as zero".
 */
export interface UsageAccumulator {
  rawInput: number | undefined;
  outputTokens: number | undefined;
  cacheRead: number | undefined;
  cacheCreation: number | undefined;
  assistantTurnCount: number;
  totalTurnDurationMs: number;
  sawTurnDuration: boolean;
}

export function createUsageAccumulator(): UsageAccumulator {
  return {
    rawInput: undefined,
    outputTokens: undefined,
    cacheRead: undefined,
    cacheCreation: undefined,
    assistantTurnCount: 0,
    totalTurnDurationMs: 0,
    sawTurnDuration: false,
  };
}

/**
 * Mutate accumulator in place from a batch of transcript entries.
 *
 * Safe to call incrementally per file-tail batch — accumulator state is
 * O(1) scalar, entries are inspected then dropped. Carrier should call
 * this for each `tailer.readNew()` batch instead of retaining entries.
 */
export function accumulateUsageFromEntries(acc: UsageAccumulator, entries: unknown[]): void {
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;

    if (entry.type === 'assistant') {
      // F230 Codex-P2: skip synthetic entries — same predicate as
      // transcriptEntriesToAgentMessages — so zero-API-call turns do not
      // inflate assistantTurnCount or numTurns in the done metadata.
      const message = entry.message as Record<string, unknown> | undefined;
      if (message?.model === '<synthetic>') continue;

      acc.assistantTurnCount++;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage) {
        // Per-field: undefined = never observed, real number = observed.
        // (?? 0) only kicks in on FIRST observation; subsequent additions
        // accumulate normally.
        if (typeof usage.input_tokens === 'number') acc.rawInput = (acc.rawInput ?? 0) + usage.input_tokens;
        if (typeof usage.output_tokens === 'number') acc.outputTokens = (acc.outputTokens ?? 0) + usage.output_tokens;
        if (typeof usage.cache_read_input_tokens === 'number')
          acc.cacheRead = (acc.cacheRead ?? 0) + usage.cache_read_input_tokens;
        if (typeof usage.cache_creation_input_tokens === 'number')
          acc.cacheCreation = (acc.cacheCreation ?? 0) + usage.cache_creation_input_tokens;
      }
      continue;
    }

    if (entry.type === 'system' && entry.subtype === 'turn_duration') {
      if (typeof entry.durationMs === 'number') {
        acc.totalTurnDurationMs += entry.durationMs;
        acc.sawTurnDuration = true;
      }
    }
  }
}

/**
 * Build TokenUsage from an accumulator + terminal metadata.
 *
 * Reuses `extractClaudeUsage` (the -p path's authoritative usage normalizer)
 * by constructing a synthetic result/success event — true single source of
 * truth, no duplicated normalization arithmetic (per砚砚 P1.2 review).
 */
export function finalizeTranscriptUsage(acc: UsageAccumulator, terminalMeta?: TerminalMeta): TokenUsage {
  // Cloud codex round-14 P2: only include token fields when observed.
  // Synthetic event's `usage.output_tokens: 0` would be read by
  // extractClaudeUsage as real telemetry, skewing cost dashboards.
  const usageField: Record<string, number> = {};
  if (acc.rawInput != null) usageField.input_tokens = acc.rawInput;
  if (acc.outputTokens != null) usageField.output_tokens = acc.outputTokens;
  if (acc.cacheRead != null) usageField.cache_read_input_tokens = acc.cacheRead;
  if (acc.cacheCreation != null) usageField.cache_creation_input_tokens = acc.cacheCreation;
  const syntheticResult: Record<string, unknown> = {
    type: 'result',
    subtype: 'success',
    usage: usageField,
  };
  if (terminalMeta?.totalCostUsd != null) syntheticResult.total_cost_usd = terminalMeta.totalCostUsd;
  if (terminalMeta?.durationMs != null) {
    syntheticResult.duration_ms = terminalMeta.durationMs;
  } else if (acc.sawTurnDuration) {
    syntheticResult.duration_ms = acc.totalTurnDurationMs;
  }
  const turns = terminalMeta?.numTurns ?? acc.assistantTurnCount;
  if (turns > 0) syntheticResult.num_turns = turns;

  return extractClaudeUsage(syntheticResult);
}

/**
 * Convenience wrapper: aggregate usage from a complete entries array.
 *
 * For tests / one-shot terminal aggregation. Production carrier should use
 * the incremental accumulator API instead so memory stays O(1) on long jobs
 * (cloud codex P2 directive).
 */
export function extractTranscriptUsage(entries: unknown[], terminalMeta?: TerminalMeta): TokenUsage {
  const acc = createUsageAccumulator();
  accumulateUsageFromEntries(acc, entries);
  return finalizeTranscriptUsage(acc, terminalMeta);
}
