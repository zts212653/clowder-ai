/**
 * Tier 2 Trace Adapters — F237 Phase 2-C
 *
 * Observe-only adapters for segments outside the content pipeline.
 * They emit TraceEventObserved — no PromptPatch, no enable/disable, no versioning.
 *
 * | Adapter | Source               | Why observe-only                              |
 * |---------|----------------------|-----------------------------------------------|
 * | N2      | route-helpers.ts     | Immutable data assembly (conversation history)|
 * | M1      | invoke-single-cat.ts | Transport-layer (dispatch mission context)    |
 * | M2      | invoke-single-cat.ts | Transport-layer (transcript path hints)       |
 */

import { createHash } from 'node:crypto';
import type { HookStage, TraceEventObserved } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// Helpers (shared with HookPipeline but kept local to avoid circular deps)
// ---------------------------------------------------------------------------

function hashOrNull(content: string | null | undefined): string | null {
  if (!content) return null;
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function estimateTokens(content: string | null | undefined): number {
  if (!content) return 0;
  return Math.ceil(content.length / 4);
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Create a TraceEventObserved for an observed (non-pipeline) segment.
 * Called at the point where the content is assembled, not where it's injected.
 */
export function createObservedEvent(
  hookId: string,
  stage: HookStage,
  content: string | null | undefined,
): TraceEventObserved {
  return {
    hookId,
    stage,
    timestamp: Date.now(),
    status: 'observed',
    contentHash: hashOrNull(content) ?? '',
    tokenEstimate: estimateTokens(content),
  };
}

// ---------------------------------------------------------------------------
// Named adapter functions (semantic wrappers for call-site clarity)
// ---------------------------------------------------------------------------

/**
 * N2 — Conversation history delta.
 * Observed at route-helpers.ts where unread messages are assembled.
 * Stage: per-turn (always delivered, immutable).
 */
export function observeN2(conversationHistoryContent: string | null): TraceEventObserved {
  return createObservedEvent('N2', 'per-turn', conversationHistoryContent);
}

/**
 * M1 — Dispatch mission context (missionPrefix, F070).
 * Observed at invoke-single-cat.ts transport assembly.
 * Stage: per-turn (transport-layer, always delivered).
 */
export function observeM1(missionPrefixContent: string | null): TraceEventObserved {
  return createObservedEvent('M1', 'per-turn', missionPrefixContent);
}

/**
 * M2 — Transcript path hints.
 * Observed at invoke-single-cat.ts transport assembly.
 * Stage: per-turn (transport-layer, always delivered).
 */
export function observeM2(transcriptHintsContent: string | null): TraceEventObserved {
  return createObservedEvent('M2', 'per-turn', transcriptHintsContent);
}
