import type { Profiler } from 'node:inspector';
import { projectMainThreadCpuProfile } from './main-thread-cpu-profile.js';
import { selectTripwireNodes } from './tripwire-sampled-nodes.js';

export interface TripwireProfileSegment {
  profile: Profiler.Profile;
  startRequestedMs: number;
  startAcknowledgedMs: number;
  stopRequestedMs?: number;
  stopAcknowledgedMs: number;
}

function sampleClock(segment: TripwireProfileSegment) {
  const durationMs = (segment.profile.endTime - segment.profile.startTime) / 1000;
  // Both command round trips enclose their V8 endpoint. Intersect the possible start clocks;
  // a slow start need not discard the profile when a cheap stop supplies the tighter bound.
  const lower =
    segment.stopRequestedMs === undefined
      ? segment.startRequestedMs
      : Math.max(segment.startRequestedMs, segment.stopRequestedMs - durationMs);
  const upper =
    segment.stopRequestedMs === undefined
      ? segment.startAcknowledgedMs
      : Math.min(segment.startAcknowledgedMs, segment.stopAcknowledgedMs - durationMs);
  return {
    anchorMs: (lower + upper) / 2,
    uncertaintyMs: upper - lower,
    valid: Number.isFinite(durationMs) && durationMs >= 0 && upper >= lower && upper - lower <= 100,
  };
}

/** Filter by the measured interval before projecting code-only, bounded coordinates. */
export function projectTripwireSegment(segment: TripwireProfileSegment, fromMs: number, toMs: number) {
  const { profile } = segment;
  const { uncertaintyMs, anchorMs, valid } = sampleClock(segment);
  let elapsedUs = 0;
  let uncoveredMs = 0;
  const samples: number[] = [];
  const deltas: number[] = [];
  const sourceSamples = profile.samples ?? [];
  const sourceDeltas = profile.timeDeltas ?? [];
  const clockValid =
    valid &&
    sourceSamples.length === sourceDeltas.length &&
    sourceDeltas.every((delta) => Number.isFinite(delta) && delta >= 0);
  if (clockValid) {
    for (let i = 0; i < sourceSamples.length; i++) {
      const delta = sourceDeltas[i];
      const before = anchorMs + elapsedUs / 1000;
      elapsedUs += delta;
      const at = anchorMs + elapsedUs / 1000;
      // A suspended process has no samples. Never give its whole gap to the next frame.
      if (delta > 100_000) {
        uncoveredMs += Math.max(0, Math.min(at, toMs) - Math.max(before, fromMs));
        continue;
      }
      // Half-open ownership prevents overlap between the predecessor and successor windows.
      // The measured command uncertainty is reported; it is not extra sample ownership.
      if (at <= fromMs || at > toMs) continue;
      samples.push(sourceSamples[i]);
      deltas.push(delta);
    }
  }
  const selected = selectTripwireNodes(profile.nodes, samples);
  const projection = projectMainThreadCpuProfile({ ...profile, nodes: selected.nodes, samples, timeDeltas: deltas });
  return {
    ...projection,
    omittedNodes: selected.omittedNodes,
    sampleClockValid: clockValid,
    sampleClockUncertaintyMs: Math.round(uncertaintyMs * 1000) / 1000,
    uncoveredMs: clockValid ? Math.round(uncoveredMs * 1000) / 1000 : Math.max(0, toMs - fromMs),
  };
}
