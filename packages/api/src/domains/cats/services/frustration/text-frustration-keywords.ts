/**
 * F222 Phase B: Text frustration keyword detection.
 *
 * Scans recent user messages for frustration keywords. Triggers only when
 * ≥ TEXT_FRUSTRATION_THRESHOLD messages match within TEXT_FRUSTRATION_WINDOW
 * (AC-B3: single-instance match is not enough to avoid false positives).
 */

// ── Constants ──────────────────────────────────────────────────

/** Keywords indicating user frustration. Matched as substrings (Chinese has no word boundaries). */
export const FRUSTRATION_KEYWORDS = ['不对', '错了', '怎么回事', '又来了', '什么情况', '搞什么', '没用', '还是不行'];

/** Minimum number of matching messages to trigger (AC-B3: ≥2 prevents single-instance false positives). */
export const TEXT_FRUSTRATION_THRESHOLD = 2;

/** Number of most recent user messages to scan. */
export const TEXT_FRUSTRATION_WINDOW = 5;

// ── Detection ──────────────────────────────────────────────────

export interface TextFrustrationResult {
  matched: boolean;
  matchedKeywords: string[];
  matchCount: number;
}

/**
 * Scan recent user messages for frustration keywords.
 *
 * @param userMessages - Recent user messages (newest last). Only the last
 *   TEXT_FRUSTRATION_WINDOW messages are scanned.
 * @param keywords - Override keyword list (for testing). Defaults to FRUSTRATION_KEYWORDS.
 */
export function detectTextFrustration(
  userMessages: string[],
  keywords: string[] = FRUSTRATION_KEYWORDS,
): TextFrustrationResult {
  // Only scan within the window (last N messages)
  const window = userMessages.slice(-TEXT_FRUSTRATION_WINDOW);

  const allMatchedKeywords = new Set<string>();
  let matchCount = 0;

  for (const msg of window) {
    const msgMatches = keywords.filter((kw) => msg.includes(kw));
    if (msgMatches.length > 0) {
      matchCount++;
      for (const kw of msgMatches) allMatchedKeywords.add(kw);
    }
  }

  return {
    matched: matchCount >= TEXT_FRUSTRATION_THRESHOLD,
    matchedKeywords: [...allMatchedKeywords],
    matchCount,
  };
}
