/**
 * Quote anchoring for Message Bundles (F294).
 *
 * Two planes, two rules:
 *
 * - `resolveExactQuoteAnchor` — for sources whose stored text *is* the rendered text
 *   (raw CLI tool labels/details and historical CLI v1 stdout). Coordinates are already
 *   canonical, so they are compared byte-for-byte and recovery is limited to one unique match.
 * - `resolveReadableQuoteAnchor` — for Markdown messages and Markdown-rendered CLI v2 stdout,
 *   where a DOM selection and the stored projection legitimately disagree about whitespace. Matching therefore
 *   normalizes whitespace on both sides, and **client offsets are ignored entirely**.
 *
 * A client offset is measured in the DOM's coordinate space, which is not this projection's
 * coordinate space: blank Markdown lines survive projection but collapse in a render. So in
 * the readable plane a client number carries no meaning — not as a tie-breaker, and not as a
 * direct-success path either. `slice(start, end) === text` only proves the number names *some*
 * range with those characters; for repeated text it collides with the wrong occurrence.
 * Measured collision (see packages/web/test/browser/message-actions-density.test.mjs, which
 * pins the offsets against the production renderer): for source `\n\n\n\nfoo\n\nfoo` a human
 * selecting the SECOND paragraph reports DOM `4..7`, and the FIRST `foo` in the projection also
 * sits at `4..7`. The readable resolver therefore accepts a quote only when its characters occur
 * exactly once, and fails closed otherwise; the caller tells the human to select more context.
 */

export type QuoteAnchorFailure = 'quote_mismatch' | 'ambiguous_quote';

export interface QuoteAnchor {
  selectionStart: number;
  selectionEnd: number;
}

interface NormalizedText {
  /** Whitespace-collapsed text used for matching. */
  text: string;
  /** sourceOffsets[i] is the offset in the original text of normalized character i. */
  sourceOffsets: number[];
}

const WHITESPACE = /\s/;

function normalize(input: string): NormalizedText {
  let text = '';
  const sourceOffsets: number[] = [];
  let pendingSpaceFrom = -1;

  for (let index = 0; index < input.length; index++) {
    const character = input[index] as string;
    if (WHITESPACE.test(character)) {
      if (text.length > 0 && pendingSpaceFrom === -1) pendingSpaceFrom = index;
      continue;
    }
    if (pendingSpaceFrom !== -1) {
      text += ' ';
      sourceOffsets.push(pendingSpaceFrom);
      pendingSpaceFrom = -1;
    }
    text += character;
    sourceOffsets.push(index);
  }

  return { text, sourceOffsets };
}

function allMatchIndexes(haystack: string, needle: string): number[] {
  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;
    matches.push(index);
    cursor = index + 1;
  }
  return matches;
}

function verifiedCoordinates(
  item: { text: string; selectionStart?: number; selectionEnd?: number },
  projection: string,
): QuoteAnchor | null {
  if (item.selectionStart === undefined || item.selectionEnd === undefined) return null;
  if (projection.slice(item.selectionStart, item.selectionEnd) !== item.text) return null;
  return { selectionStart: item.selectionStart, selectionEnd: item.selectionEnd };
}

/**
 * Anchor a selection whose coordinates are already canonical (raw CLI v1 segments).
 * Recovery is allowed only when the quoted characters occur exactly once.
 */
export function resolveExactQuoteAnchor(
  item: { text: string; selectionStart?: number; selectionEnd?: number },
  projection: string,
): QuoteAnchor | QuoteAnchorFailure {
  const verified = verifiedCoordinates(item, projection);
  if (verified) return verified;
  if (item.text.length === 0) return 'quote_mismatch';

  const matches = allMatchIndexes(projection, item.text);
  if (matches.length === 0) return 'quote_mismatch';
  if (matches.length > 1) return 'ambiguous_quote';
  const selectionStart = matches[0];
  if (selectionStart === undefined) return 'quote_mismatch';
  return { selectionStart, selectionEnd: selectionStart + item.text.length };
}

/**
 * Anchor a selection made on rendered Markdown against the readable-text projection.
 * Whitespace is normalized on both sides. Client offsets are deliberately not read here:
 * they belong to the DOM plane, so only uniqueness can identify the human's range.
 */
export function resolveReadableQuoteAnchor(
  item: { text: string },
  projection: string,
): QuoteAnchor | QuoteAnchorFailure {
  const normalizedProjection = normalize(projection);
  const normalizedQuote = normalize(item.text);
  if (normalizedQuote.text.length === 0) return 'quote_mismatch';

  const matches = allMatchIndexes(normalizedProjection.text, normalizedQuote.text);
  if (matches.length === 0) return 'quote_mismatch';
  if (matches.length > 1) return 'ambiguous_quote';

  const matchIndex = matches[0];
  if (matchIndex === undefined) return 'quote_mismatch';
  const selectionStart = normalizedProjection.sourceOffsets[matchIndex];
  const lastOffset = normalizedProjection.sourceOffsets[matchIndex + normalizedQuote.text.length - 1];
  if (selectionStart === undefined || lastOffset === undefined) return 'quote_mismatch';
  return { selectionStart, selectionEnd: lastOffset + 1 };
}
