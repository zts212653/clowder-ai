import type { VideoProjectScreening } from '@cat-cafe/shared';

const zero = BigInt(0),
  two = BigInt(2);
/**
 * Packet-verified CFR proves a constant integer PTS interval starting at startTick.
 * Recover that grid from the rounded decoded metadata, then seek inside the neighboring frame.
 * Its midpoint remains in [framePTS,nextFramePTS) after browser microsecond quantization;
 * an exact boundary can round down into the preceding frame. Marking still uses decoded rVFC PTS.
 */
export function adjacentFrameSeekSeconds(
  media: VideoProjectScreening['media']['media'],
  pts: number | null,
  direction: -1 | 1,
): number | null {
  if (pts === null || !Number.isSafeInteger(pts) || !media.frameRate) return null;
  const numerator = BigInt(media.timebase.denominator) * BigInt(media.frameRate.denominator);
  const denominator = BigInt(media.timebase.numerator) * BigInt(media.frameRate.numerator);
  if (numerator % denominator !== zero) return null;
  const frameTicks = numerator / denominator;
  const duration = BigInt(media.durationTicks);
  if (frameTicks <= zero || duration % frameTicks !== zero) return null;
  const start = BigInt(media.startTick);
  const relative = BigInt(pts) - start;
  if (relative < zero || relative >= duration) return null;
  const frameIndex = (relative + frameTicks / two) / frameTicks;
  const neighbor = frameIndex + BigInt(direction);
  if (neighbor < zero || neighbor >= duration / frameTicks) return null;
  const twiceSamplePts = two * (start + neighbor * frameTicks) + frameTicks;
  const seconds =
    Number(twiceSamplePts * BigInt(media.timebase.numerator)) / Number(two * BigInt(media.timebase.denominator));
  return Number.isFinite(seconds) ? seconds : null;
}
