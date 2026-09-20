/**
 * F257 V1 — offset-mapped speech mention normalization.
 *
 * The speech pass re-scans a transformed variant of the message ("at 砚砚" →
 * "@砚砚"), so token positions shift relative to the raw message. To keep the
 * T-A (§3.4) attempt-stream uniqueness contract (one draft per unique source
 * span; a re-visited span is a traversal artifact that merges silently), the
 * speech pass must express its drafts in raw message coordinates. This module
 * produces the exact same normalized text as the previous
 * `String.replace`-based implementation plus a span mapper back to the raw
 * message.
 */

interface SpeechMapSegment {
  readonly outStart: number;
  readonly outEnd: number;
  readonly rawStart: number;
  readonly rawEnd: number;
  /** identity segments map 1:1 by offset; replaced segments map to their whole raw region */
  readonly identity: boolean;
}

export interface SpeechTokenSpan {
  readonly start: number;
  readonly end: number;
}

export interface SpeechNormalization {
  /** Normalized text (same output as the legacy speech replace). */
  readonly text: string;
  /** Map a span in normalized-text coordinates back to raw message coordinates. */
  readonly mapSpanToRaw: (span: SpeechTokenSpan) => SpeechTokenSpan;
}

export function normalizeSpeechMentionsWithMap(message: string, speechMentionRe: RegExp): SpeechNormalization {
  const segments: SpeechMapSegment[] = [];
  let out = '';
  let rawCursor = 0;

  const pushIdentity = (rawEnd: number): void => {
    if (rawEnd <= rawCursor) return;
    segments.push({
      outStart: out.length,
      outEnd: out.length + (rawEnd - rawCursor),
      rawStart: rawCursor,
      rawEnd,
      identity: true,
    });
    out += message.slice(rawCursor, rawEnd);
    rawCursor = rawEnd;
  };

  for (const match of message.matchAll(speechMentionRe)) {
    const index = match.index ?? 0;
    const prefix = match[1] ?? '';
    const mention = match[2] ?? '';
    // Legacy replacement was `${prefix}@${mention}` — the prefix survives as
    // identity text; only the region after it is rewritten.
    pushIdentity(index + prefix.length);
    const replacement = `@${mention}`;
    segments.push({
      outStart: out.length,
      outEnd: out.length + replacement.length,
      rawStart: rawCursor,
      rawEnd: index + match[0].length,
      identity: false,
    });
    out += replacement;
    rawCursor = index + match[0].length;
  }
  pushIdentity(message.length);

  return {
    text: out,
    mapSpanToRaw: (span) => ({
      start: mapOutputPosToRaw(segments, span.start, false),
      end: mapOutputPosToRaw(segments, span.end, true),
    }),
  };
}

function mapOutputPosToRaw(segments: readonly SpeechMapSegment[], pos: number, isEnd: boolean): number {
  const probe = isEnd ? pos - 1 : pos;
  for (const seg of segments) {
    if (probe < seg.outStart || probe >= seg.outEnd) continue;
    if (seg.identity) return seg.rawStart + (probe - seg.outStart) + (isEnd ? 1 : 0);
    return isEnd ? seg.rawEnd : seg.rawStart;
  }
  return pos; // defensive: out-of-range positions map through unchanged
}
