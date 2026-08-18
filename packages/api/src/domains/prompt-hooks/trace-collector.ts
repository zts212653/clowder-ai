/**
 * TraceCollector — F237 (Trace v0)
 *
 * Lightweight post-hoc observation of prompt injection output.
 * Captures what was injected without modifying the builder functions.
 *
 * Strategy: calls buildStaticIdentity with annotateSegments=true to get
 * per-segment boundaries, then parses the markers. The actual prompt
 * output is computed separately (without annotations) to avoid markers
 * leaking into production prompts.
 */

import { createHash } from 'node:crypto';
import type {
  CatId,
  InjectionStage,
  InjectionTraceDetail,
  InjectionTraceSummary,
  ObservedSegment,
  StageDeliveryDecision,
} from '@cat-cafe/shared';
import { estimateTokens } from '../../utils/token-counter.js';
import { buildStaticIdentity, type StaticIdentityOptions } from '../cats/services/context/SystemPromptBuilder.js';
import type { PipelineResult } from './HookPipeline.js';

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Parse annotated output to extract per-segment data.
 * Annotation format: `── [SN] Name ──\n<content>`
 */
export function parseAnnotatedSegments(annotated: string, stage: InjectionStage): ObservedSegment[] {
  const segments: ObservedSegment[] = [];
  const markerRegex = /── \[(\w+)\] .+ ──/g;
  const markers: { id: string; index: number }[] = [];

  let match: RegExpExecArray | null;
  while ((match = markerRegex.exec(annotated)) !== null) {
    markers.push({ id: match[1], index: match.index });
  }

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const nlPos = annotated.indexOf('\n', marker.index);
    // No newline after last marker → no content for this segment
    const contentStart = nlPos === -1 ? annotated.length : nlPos + 1;
    const contentEnd = i + 1 < markers.length ? markers[i + 1].index : annotated.length;
    const content = annotated.slice(contentStart, contentEnd).trim();

    segments.push({
      segmentId: marker.id,
      stage,
      status: content.length > 0 ? 'observed' : 'absent',
      contentHash: content.length > 0 ? hashContent(content) : null,
      charCount: content.length,
      tokenEstimate: content.length > 0 ? estimateTokens(content) : 0,
    });
  }

  return segments;
}

export interface CollectedTrace {
  segments: ObservedSegment[];
  delivery: StageDeliveryDecision[];
  sessionContentHash: string | null;
  turnContentHash: string | null;
  sessionCharCount: number;
  sessionTokenEstimate: number;
  turnCharCount: number;
  turnTokenEstimate: number;
  durationMs: number;
}

/**
 * Collect trace for a prompt injection turn.
 *
 * @param catId - The cat being prompted
 * @param sessionContent - Output of buildStaticIdentity (already computed by route layer)
 * @param turnContent - Output of buildInvocationContext (already computed by route layer)
 * @param hasNativeL0 - Whether the cat uses native L0 injection
 * @param sessionOptions - Options passed to buildStaticIdentity
 */
export function collectTrace(
  catId: string,
  sessionContent: string,
  turnContent: string,
  hasNativeL0: boolean,
  sessionOptions?: StaticIdentityOptions,
): CollectedTrace {
  const startMs = performance.now();

  // Get annotated session content for per-segment breakdown
  let sessionSegments: ObservedSegment[] = [];
  if (!hasNativeL0 && sessionContent.length > 0) {
    try {
      const annotated = buildStaticIdentity(catId as CatId, {
        ...sessionOptions,
        annotateSegments: true,
      });
      sessionSegments = parseAnnotatedSegments(annotated, 'session-init');
    } catch {
      // Fall back to stage-level observation
      sessionSegments = [
        {
          segmentId: 'session-init-aggregate',
          stage: 'session-init',
          status: 'observed',
          contentHash: hashContent(sessionContent),
          charCount: sessionContent.length,
          tokenEstimate: estimateTokens(sessionContent),
        },
      ];
    }
  } else if (hasNativeL0 && sessionContent.length > 0) {
    // Native L0 with pack-only content: record aggregate segment so that
    // segments array is consistent with sessionCharCount/sessionTokenEstimate.
    sessionSegments = [
      {
        segmentId: 'session-init-pack-only',
        stage: 'session-init',
        status: 'observed',
        contentHash: hashContent(sessionContent),
        charCount: sessionContent.length,
        tokenEstimate: estimateTokens(sessionContent),
      },
    ];
  }

  // Per-turn: stage-level observation only (no annotateSegments for invocation context)
  const turnSegments: ObservedSegment[] =
    turnContent.length > 0
      ? [
          {
            segmentId: 'per-turn-aggregate',
            stage: 'per-turn',
            status: 'observed',
            contentHash: hashContent(turnContent),
            charCount: turnContent.length,
            tokenEstimate: estimateTokens(turnContent),
          },
        ]
      : [];

  // Delivery decisions — route-level observation only.
  // `contentAssembled` = content was prepared and passed to invocation layer.
  // Actual delivery depends on session-chain resume state (invoke-single-cat
  // may skip systemPrompt on resumes) and native L0 provider behavior.
  const delivery: StageDeliveryDecision[] = [
    {
      stage: 'session-init',
      contentAssembled: sessionContent.length > 0,
      channel: hasNativeL0 ? 'pack-only' : 'message-prepend',
      reason: hasNativeL0
        ? 'Route-level: pack-only content assembled via message-prepend for native L0 cat; non-pack identity handled natively by provider'
        : 'Route-level: content assembled for message-prepend; actual delivery depends on session-chain resume state',
    },
    {
      stage: 'per-turn',
      contentAssembled: turnContent.length > 0,
      channel: 'message-prepend',
      reason: 'Per-turn context assembled for message-prepend',
    },
  ];

  const durationMs = performance.now() - startMs;
  const allSegments = [...sessionSegments, ...turnSegments];

  return {
    segments: allSegments,
    delivery,
    sessionContentHash: sessionContent.length > 0 ? hashContent(sessionContent) : null,
    turnContentHash: turnContent.length > 0 ? hashContent(turnContent) : null,
    sessionCharCount: sessionContent.length,
    sessionTokenEstimate: sessionContent.length > 0 ? estimateTokens(sessionContent) : 0,
    turnCharCount: turnContent.length,
    turnTokenEstimate: turnContent.length > 0 ? estimateTokens(turnContent) : 0,
    durationMs,
  };
}

/** Build InjectionTraceSummary from collected trace data. */
export function buildTraceSummary(
  trace: CollectedTrace,
  meta: { turnId: string; sessionId?: string; threadId: string; catId: string },
): InjectionTraceSummary {
  const observed = trace.segments.filter((s) => s.status === 'observed');
  const absent = trace.segments.filter((s) => s.status === 'absent');

  return {
    turnId: meta.turnId,
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    threadId: meta.threadId,
    catId: meta.catId,
    timestamp: Date.now(),
    segments: trace.segments,
    delivery: trace.delivery,
    totalCharCount: trace.sessionCharCount + trace.turnCharCount,
    totalTokenEstimate: trace.sessionTokenEstimate + trace.turnTokenEstimate,
    totalSegmentsObserved: observed.length,
    totalSegmentsAbsent: absent.length,
    durationMs: trace.durationMs,
  };
}

/** Build InjectionTraceDetail from collected trace data. */
export function buildTraceDetail(
  trace: CollectedTrace,
  meta: { turnId: string; threadId: string; catId: string },
): InjectionTraceDetail {
  return {
    turnId: meta.turnId,
    threadId: meta.threadId,
    catId: meta.catId,
    timestamp: Date.now(),
    sessionContentHash: trace.sessionContentHash,
    turnContentHash: trace.turnContentHash,
    sessionCharCount: trace.sessionCharCount,
    sessionTokenEstimate: trace.sessionTokenEstimate,
    turnCharCount: trace.turnCharCount,
    turnTokenEstimate: trace.turnTokenEstimate,
    segments: trace.segments,
  };
}

// ---------------------------------------------------------------------------
// Pipeline-aware trace collection (#839: full hook observability)
// ---------------------------------------------------------------------------
//
// Two distinct truths:
//   1. EXECUTION — which hooks fired in the pipeline, what they produced.
//      Recorded as per-hook ObservedSegments (segmentId = hookId).
//      A hook with status='observed' means the pipeline executed it AND it
//      produced content. It does NOT mean that content reached the model —
//      prompt output is scoped per legacy builder (S-only for session,
//      D-only for turn). Hooks outside the delivery scope (L/B/C for
//      session, R/N for turn) execute for trace but their content is
//      filtered from the prompt.
//
//   2. DELIVERY — what was actually assembled and passed to the model.
//      Recorded in StageDeliveryDecision (channel, contentAssembled) and
//      the aggregate content hashes/sizes (sessionContentHash, etc.).
//      When deliveredContent is provided by the route layer, these
//      reflect the real delivered bytes, not pipeline patch sums.
//
// The old v0 collectTrace() conflated both: it re-ran buildStaticIdentity
// (annotateSegments=true) to get S-prefix segment detail, then used the
// route-assembled content for aggregate sizing. This new function keeps
// both truths separate.
// ---------------------------------------------------------------------------

/**
 * Convert pipeline events to ObservedSegments.
 * Each pipeline TraceEvent becomes one per-hook segment — fired hooks are
 * 'observed' (with content data from matching patch), skipped/disabled are 'absent'.
 */
function pipelineEventsToSegments(result: PipelineResult, stage: InjectionStage): ObservedSegment[] {
  const patchMap = new Map(result.patches.map((p) => [p.hookId, p]));
  return result.events.map((event) => {
    const patch = event.status === 'fired' ? patchMap.get(event.hookId) : undefined;
    return {
      segmentId: event.hookId,
      stage,
      status: patch ? ('observed' as const) : ('absent' as const),
      contentHash: patch ? hashContent(patch.content) : null,
      charCount: patch?.content.length ?? 0,
      tokenEstimate: patch ? estimateTokens(patch.content) : 0,
    };
  });
}

/**
 * Collect trace from HookPipeline results.
 *
 * Reads directly from the pipeline's trace events, giving per-hook
 * granularity for ALL hooks (L+S+B+C+D+R+N). Unlike v0 `collectTrace()`
 * which re-runs buildStaticIdentity(annotateSegments=true) and only sees
 * S-prefix hooks, this captures whatever the pipeline actually executed.
 *
 * @param deliveredContent - Actual content assembled by the route layer and
 *   passed to the model. When provided, aggregate sizes/hashes reflect what
 *   was delivered (delivery truth), not what the pipeline produced. When
 *   omitted, falls back to pipeline patch sums (execution truth).
 */
export function collectTraceFromPipeline(
  sessionResult: PipelineResult | null,
  turnResult: PipelineResult | null,
  hasNativeL0: boolean,
  deliveredContent?: { session?: string; turn?: string },
): CollectedTrace {
  const startMs = performance.now();

  const sessionSegments = sessionResult ? pipelineEventsToSegments(sessionResult, 'session-init') : [];
  const turnSegments = turnResult ? pipelineEventsToSegments(turnResult, 'per-turn') : [];

  // Aggregate sizes: prefer delivered content (delivery truth) over pipeline
  // patch sums (execution truth). The route layer may add/filter content
  // beyond what the pipeline produced (mode prompt, bootstrap, MCP, etc.).
  const sessionText = deliveredContent?.session;
  const turnText = deliveredContent?.turn;

  const sessionCharCount =
    sessionText != null
      ? sessionText.length
      : sessionResult
        ? sessionResult.patches.reduce((sum, p) => sum + p.content.length, 0)
        : 0;
  const turnCharCount =
    turnText != null
      ? turnText.length
      : turnResult
        ? turnResult.patches.reduce((sum, p) => sum + p.content.length, 0)
        : 0;

  const sessionTokenEstimate =
    sessionText != null
      ? estimateTokens(sessionText)
      : sessionResult
        ? sessionResult.patches.reduce((sum, p) => sum + estimateTokens(p.content), 0)
        : 0;
  const turnTokenEstimate =
    turnText != null
      ? estimateTokens(turnText)
      : turnResult
        ? turnResult.patches.reduce((sum, p) => sum + estimateTokens(p.content), 0)
        : 0;

  const delivery: StageDeliveryDecision[] = [
    {
      stage: 'session-init',
      contentAssembled: sessionCharCount > 0,
      channel: hasNativeL0 ? 'native-l0' : 'message-prepend',
      reason: hasNativeL0
        ? 'Pipeline ran all hooks; delivery via native L0 compiler (file/instructions)'
        : 'Pipeline ran all hooks; delivery via message-prepend',
    },
    {
      stage: 'per-turn',
      contentAssembled: turnCharCount > 0,
      channel: 'message-prepend',
      reason: 'Per-turn context assembled for message-prepend',
    },
  ];

  let sessionContentHash: string | null = null;
  if (sessionCharCount > 0) {
    const raw = sessionText ?? sessionResult?.patches.map((p) => p.content).join('\n\n');
    if (raw) sessionContentHash = hashContent(raw);
  }
  let turnContentHash: string | null = null;
  if (turnCharCount > 0) {
    const raw = turnText ?? turnResult?.patches.map((p) => p.content).join('\n\n');
    if (raw) turnContentHash = hashContent(raw);
  }

  return {
    segments: [...sessionSegments, ...turnSegments],
    delivery,
    sessionContentHash,
    turnContentHash,
    sessionCharCount,
    sessionTokenEstimate,
    turnCharCount,
    turnTokenEstimate,
    durationMs: performance.now() - startMs,
  };
}
