import { projectTripwireSegment, type TripwireProfileSegment } from './event-loop-tripwire-profile.js';
import type { LoopStallSpan } from './event-loop-tripwire-state.js';

/** Stateless, code-only report. A coverage gap always suppresses stale coordinates. */
export function tripwireReport(
  span: LoopStallSpan,
  toMs: number,
  fromMs: number,
  segments: readonly TripwireProfileSegment[],
  thresholdMs: number,
  unavailableReason?: string,
) {
  const reason = span.reason ?? unavailableReason;
  let consumedUntil = fromMs;
  const parts = reason
    ? []
    : [...segments]
        .sort((a, b) => a.startRequestedMs - b.startRequestedMs)
        .filter((segment) => segment.stopAcknowledgedMs >= fromMs && segment.startRequestedMs <= toMs)
        .flatMap((segment) => {
          const end = Math.min(toMs, segment.stopAcknowledgedMs);
          if (end <= consumedUntil) return [];
          const part = projectTripwireSegment(segment, consumedUntil, end);
          consumedUntil = end;
          return [part];
        });
  const topFrames = mergeFrames(parts);
  return {
    kind: span.reason ? 'event_loop_observer_gap' : 'event_loop_stall',
    phase: span.endMs === undefined ? 'ongoing' : 'complete',
    episode: `${process.pid}:${Math.round(span.startMs * 1000)}`,
    pid: process.pid,
    observedAt: Date.now(),
    thresholdMs,
    durationMs: Math.max(0, Math.round((toMs - fromMs) * 1000) / 1000),
    episodeElapsedMs: Math.max(0, Math.round((toMs - span.startMs) * 1000) / 1000),
    attributedRangeMs: { from: fromMs, to: toMs },
    attribution: !reason && topFrames.length > 0 ? 'sampled' : 'unknown',
    ...(reason || topFrames.length === 0 ? { reason: reason ?? 'no_trustworthy_api_frame' } : {}),
    ...(span.workerGapMs !== undefined ? { workerGapMs: span.workerGapMs } : {}),
    topFrames,
    sampleCount: parts.reduce((n, part) => n + part.retainedSamples, 0),
    gcSamples: parts.reduce((n, part) => n + part.categories.gc, 0),
    nativeSamplesWithoutApiCaller: parts.reduce((n, part) => n + part.nativeSamplesWithoutApiCaller, 0),
    omittedNodes: parts.reduce((n, part) => n + part.omittedNodes, 0),
    omittedParentEdges: parts.reduce((n, part) => n + part.omittedParentEdges, 0),
    sampleClockValid: parts.length > 0 && parts.every((part) => part.sampleClockValid),
    uncoveredMs: parts.length ? parts.reduce((n, part) => n + part.uncoveredMs, 0) : Math.max(0, toMs - fromMs),
    sampleClockUncertaintyMs: Math.max(0, ...parts.map((part) => part.sampleClockUncertaintyMs)),
    // Sampling is evidence of execution in the interval, never exact function CPU accounting.
    durationMeaning: span.reason ? 'observer_uncovered_interval' : 'main_loop_unresponsive_interval',
  };
}

function mergeFrames(parts: ReturnType<typeof projectTripwireSegment>[]) {
  type Coordinate = (typeof parts)[number]['topFrames'][number];
  const frames = new Map<string, Coordinate>();
  for (const part of parts) {
    for (const frame of part.topFrames) {
      const key = `${frame.file}:${frame.function}:${frame.line}`;
      const existing = frames.get(key);
      frames.set(key, {
        ...frame,
        selfSamples: (existing?.selfSamples ?? 0) + frame.selfSamples,
        nativeSamples: (existing?.nativeSamples ?? 0) + (frame.nativeSamples ?? 0),
      });
    }
  }
  return [...frames.values()]
    .sort((a, b) => b.selfSamples + (b.nativeSamples ?? 0) - a.selfSamples - (a.nativeSamples ?? 0))
    .slice(0, 12);
}
