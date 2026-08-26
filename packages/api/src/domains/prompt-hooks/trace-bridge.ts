/**
 * F257 Trace Persistence Bridge
 *
 * Converts pipeline-produced PipelineResult (per-hook TraceEvent[])
 * into v0 InjectionTraceSummary / InjectionTraceDetail formats
 * consumed by InjectionTraceStore.
 *
 * Fixes the 15/46 segment trace gap: the legacy collectTrace() path
 * only covers S-prefix session segments and per-turn aggregate. This
 * bridge converts the full pipeline result (all 46 hooks) to v0 format.
 *
 * When pipeline traces are unavailable (e.g., legacy path without
 * pipeline), callers fall back to the existing collectTrace() path.
 */

import { createHash } from 'node:crypto';
import type {
  DeliveryChannel,
  InjectionTraceDetail,
  InjectionTraceSummary,
  ObservedSegment,
  StageDeliveryDecision,
} from '@cat-cafe/shared';
import type { PipelineResult } from './HookPipeline.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TraceBridgeMeta {
  turnId: string;
  sessionId?: string;
  threadId: string;
  catId: string;
  hasNativeL0: boolean;
  /**
   * When true, the session result comes from the native L0 compiler's
   * manifest (L1-L7), so the delivery channel is 'native-l0'.
   */
  sessionFromNativeCompiler?: boolean;
}

/**
 * Build v0 InjectionTraceSummary + InjectionTraceDetail from pipeline results.
 *
 * Returns null when both session and turn results are null (no pipeline
 * traces captured — caller should fall back to collectTrace path).
 */
export function buildFromPipeline(
  sessionResult: PipelineResult | null,
  turnResult: PipelineResult | null,
  meta: TraceBridgeMeta,
): { summary: InjectionTraceSummary; detail: InjectionTraceDetail } | null {
  if (!sessionResult && !turnResult) return null;

  const sessionSegments = sessionResult ? eventsToSegments(sessionResult, 'session-init') : [];
  const turnSegments = turnResult ? eventsToSegments(turnResult, 'per-turn') : [];
  const allSegments = [...sessionSegments, ...turnSegments];

  const observed = allSegments.filter((s) => s.status === 'observed');
  const absent = allSegments.filter((s) => s.status === 'absent');

  const sessionTokens = sumTokens(sessionSegments);
  const turnTokens = sumTokens(turnSegments);
  const sessionChars = sumChars(sessionResult);
  const turnChars = sumChars(turnResult);

  const delivery = buildDelivery(sessionResult, turnResult, meta.hasNativeL0, meta.sessionFromNativeCompiler ?? false);
  const timestamp = Date.now();

  const summary: InjectionTraceSummary = {
    turnId: meta.turnId,
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    threadId: meta.threadId,
    catId: meta.catId,
    timestamp,
    segments: allSegments,
    delivery,
    totalCharCount: sessionChars + turnChars,
    totalTokenEstimate: sessionTokens + turnTokens,
    totalSegmentsObserved: observed.length,
    totalSegmentsAbsent: absent.length,
    durationMs: 0, // Pipeline doesn't track duration; 0 = not measured
  };

  const detail: InjectionTraceDetail = {
    turnId: meta.turnId,
    threadId: meta.threadId,
    catId: meta.catId,
    timestamp,
    sessionContentHash: assembledContentHash(sessionResult),
    turnContentHash: assembledContentHash(turnResult),
    sessionCharCount: sessionChars,
    sessionTokenEstimate: sessionTokens,
    turnCharCount: turnChars,
    turnTokenEstimate: turnTokens,
    segments: allSegments,
  };

  return { summary, detail };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type InjectionStage = 'session-init' | 'per-turn';

/**
 * Convert pipeline TraceEvent[] to v0 ObservedSegment[].
 *
 * Maps pipeline statuses to v0 binary: fired → 'observed', everything else → 'absent'.
 */
function eventsToSegments(result: PipelineResult, stage: InjectionStage): ObservedSegment[] {
  const patchMap = new Map(result.patches.map((p) => [p.hookId, p]));
  return result.events.map((ev): ObservedSegment => {
    if (ev.status === 'fired') {
      const patch = patchMap.get(ev.hookId);
      return {
        segmentId: ev.hookId,
        stage,
        status: 'observed',
        contentHash: ev.contentHash,
        charCount: patch?.content.length ?? 0,
        tokenEstimate: ev.tokenEstimate,
      };
    }
    // skipped, disabled, or observed-without-content → absent
    return {
      segmentId: ev.hookId,
      stage,
      status: 'absent',
      contentHash: null,
      charCount: 0,
      tokenEstimate: 0,
    };
  });
}

function sumTokens(segments: ObservedSegment[]): number {
  return segments.reduce((acc, s) => acc + s.tokenEstimate, 0);
}

function sumChars(result: PipelineResult | null): number {
  if (!result) return 0;
  return result.patches.reduce((acc, p) => acc + p.content.length, 0);
}

/**
 * Hash assembled patch content matching HookPipeline.assemblePatches semantics:
 * patches in manifest order, joined with '\n\n'.
 */
function assembledContentHash(result: PipelineResult | null): string | null {
  if (!result || result.patches.length === 0) return null;
  const combined = result.patches.map((p) => p.content).join('\n\n');
  return createHash('sha256').update(combined).digest('hex').slice(0, 16);
}

function buildDelivery(
  sessionResult: PipelineResult | null,
  turnResult: PipelineResult | null,
  hasNativeL0: boolean,
  sessionFromNativeCompiler: boolean,
): StageDeliveryDecision[] {
  const sessionChannel: DeliveryChannel = sessionFromNativeCompiler
    ? 'native-l0'
    : hasNativeL0
      ? 'pack-only'
      : 'message-prepend';
  const sessionReason = sessionFromNativeCompiler
    ? 'Pipeline bridge: L1-L7 delivered via native L0 compiler artifact'
    : hasNativeL0
      ? 'Pipeline bridge: pack-only for native L0'
      : 'Pipeline bridge: content assembled for message-prepend';
  return [
    {
      stage: 'session-init' as InjectionStage,
      contentAssembled: sessionResult !== null && sessionResult.patches.length > 0,
      channel: sessionChannel,
      reason: sessionReason,
    },
    {
      stage: 'per-turn' as InjectionStage,
      contentAssembled: turnResult !== null && turnResult.patches.length > 0,
      channel: 'message-prepend',
      reason: 'Pipeline bridge: per-turn content assembled',
    },
  ];
}
