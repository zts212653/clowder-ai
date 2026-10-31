/** A nominal/average header rate is insufficient to authorize exact encoded-frame stepping. */
export function verifiedVideoFrameRate(input: {
  packets?: readonly unknown[];
  streamIndex: number;
  expectedFrameCount: number;
  startPts: number;
  durationPts: number;
  timebase: { numerator: number; denominator: number };
}): { numerator: number; denominator: number } | undefined {
  const frames = packetFrames(input.packets, input.streamIndex);
  if (!frames || frames.length !== input.expectedFrameCount || !Number.isSafeInteger(input.expectedFrameCount))
    return undefined;
  frames.sort((left, right) => left.pts - right.pts);
  const first = frames[0];
  if (!first || first.pts !== input.startPts) return undefined;
  let cursor = input.startPts;
  for (const frame of frames) {
    if (frame.pts !== cursor || frame.duration !== first.duration) return undefined;
    cursor += frame.duration;
    if (!Number.isSafeInteger(cursor)) return undefined;
  }
  if (cursor !== input.startPts + input.durationPts) return undefined;
  const numerator = BigInt(input.timebase.denominator);
  const denominator = BigInt(first.duration) * BigInt(input.timebase.numerator);
  const divisor = greatestCommonDivisor(numerator, denominator);
  const reduced = { numerator: Number(numerator / divisor), denominator: Number(denominator / divisor) };
  return Number.isSafeInteger(reduced.numerator) && Number.isSafeInteger(reduced.denominator) ? reduced : undefined;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

function packetFrames(raw: readonly unknown[] | undefined, streamIndex: number) {
  const packets = raw;
  if (!packets?.length) return undefined;
  const frames: { pts: number; duration: number }[] = [];
  for (const packet of packets) {
    if (!packet || typeof packet !== 'object') return undefined;
    const candidate = packet as Record<string, unknown>;
    if (candidate.stream_index !== streamIndex) continue;
    if (
      !Number.isSafeInteger(candidate.pts) ||
      !Number.isSafeInteger(candidate.duration) ||
      Number(candidate.duration) <= 0
    )
      return undefined;
    frames.push({ pts: Number(candidate.pts), duration: Number(candidate.duration) });
  }
  return frames;
}
