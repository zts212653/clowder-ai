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
