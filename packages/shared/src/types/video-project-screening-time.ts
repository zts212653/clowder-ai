import type { VideoProjectScreening, VideoProjectScreeningMappingSegment } from './video-project-screening.js';

export type VideoProjectMappingRounding = 'floor' | 'ceil';
type Screening = Pick<VideoProjectScreening, 'mapping'>;

/** Endpoints and products are exact integers; only the final checked result becomes a Number. */
function interpolate(
  value: number,
  fromStart: number,
  fromEnd: number,
  toStart: number,
  toEnd: number,
  rounding: VideoProjectMappingRounding,
): number {
  const numerator = (BigInt(value) - BigInt(fromStart)) * (BigInt(toEnd) - BigInt(toStart));
  const denominator = BigInt(fromEnd) - BigInt(fromStart);
  const quotient = numerator / denominator;
  const result = BigInt(toStart) + quotient + (rounding === 'ceil' && numerator % denominator !== 0n ? 1n : 0n);
  const converted = Number(result);
  if (!Number.isSafeInteger(converted)) throw new RangeError('Mapped coordinate is not a safe integer');
  return converted;
}

/** Lookup intervals are half-open, including at a join; an unmapped tick returns null. */
export function mediaPtsToProjectTick(
  screening: Screening,
  pts: number,
  rounding: VideoProjectMappingRounding = 'floor',
): number | null {
  if (!Number.isSafeInteger(pts)) return null;
  const segment = screening.mapping.segments.find((item) => pts >= item.mediaStartPts && pts < item.mediaEndPts);
  return segment ? mediaTick(segment, pts, rounding) : null;
}

export function projectTickToMediaPts(
  screening: Screening,
  tick: number,
  rounding: VideoProjectMappingRounding = 'floor',
): number | null {
  if (!Number.isSafeInteger(tick)) return null;
  const segment = screening.mapping.segments.find(
    (item) => tick >= item.projectStartTick && tick < item.projectEndTick,
  );
  return segment
    ? interpolate(
        tick,
        segment.projectStartTick,
        segment.projectEndTick,
        segment.mediaStartPts,
        segment.mediaEndPts,
        rounding,
      )
    : null;
}

function mediaTick(
  segment: VideoProjectScreeningMappingSegment,
  pts: number,
  rounding: VideoProjectMappingRounding,
): number {
  return interpolate(
    pts,
    segment.mediaStartPts,
    segment.mediaEndPts,
    segment.projectStartTick,
    segment.projectEndTick,
    rounding,
  );
}

/** Cover the entire selection, floor its start and ceil its end; never silently clip a gap. */
export function mapScreeningMediaRange(
  screening: Screening,
  range: { startPts: number; endPts: number },
): { startTick: number; endTick: number } | null {
  if (!Number.isSafeInteger(range.startPts) || !Number.isSafeInteger(range.endPts) || range.endPts <= range.startPts)
    return null;
  const pieces = screening.mapping.segments.filter(
    (item) => item.mediaStartPts < range.endPts && item.mediaEndPts > range.startPts,
  );
  const first = pieces[0];
  const last = pieces.at(-1);
  if (!first || !last || range.startPts < first.mediaStartPts || range.endPts > last.mediaEndPts) return null;
  for (let i = 1; i < pieces.length; i++) {
    if (
      pieces[i - 1].mediaEndPts !== pieces[i].mediaStartPts ||
      pieces[i - 1].projectEndTick !== pieces[i].projectStartTick
    )
      return null;
  }
  return {
    startTick: mediaTick(first, range.startPts, 'floor'),
    endTick: mediaTick(last, range.endPts, 'ceil'),
  };
}
