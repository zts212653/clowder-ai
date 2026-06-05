/**
 * F222 Phase C: Retry burst detection.
 *
 * Detects when a user sends the same message repeatedly,
 * indicating their request may not have been processed correctly.
 *
 * Comparison: full available content match (capped at COMPARE_CAP chars).
 * The caller (collectAndDetectTextFrustration) pre-truncates
 * recentUserMessages to 200 chars, so we cap currentMessage to the same
 * length for fair comparison.
 *
 * Bugfix: previously compared only the first 30 chars, which caused false
 * positives in A2A review workflows where different messages shared similar
 * openings (e.g., "@codex review round 3..." / "@codex review round 4...").
 *
 * Threshold: ≥ RETRY_BURST_THRESHOLD matching messages in window.
 */

import { RETRY_BURST_THRESHOLD, RETRY_PREFIX_LENGTH } from './FrustrationDetector.js';

/** Must match the truncation cap in collectAndDetectTextFrustration */
const COMPARE_CAP = 200;

export interface RetryBurstResult {
  matched: boolean;
  matchCount: number;
  repeatedPrefix: string;
}

/**
 * Check if the current message has been sent repeatedly in the recent window.
 *
 * @param currentMessage - The message the user just sent
 * @param recentUserMessages - Recent user messages (newest first, from collectAndDetect helper;
 *                             pre-truncated to 200 chars)
 */
export function detectRetryBurst(currentMessage: string, recentUserMessages: string[]): RetryBurstResult {
  if (!currentMessage || recentUserMessages.length === 0) {
    return { matched: false, matchCount: 0, repeatedPrefix: '' };
  }

  const currentTrimmed = currentMessage.trim();
  if (currentTrimmed.length < 5) {
    // Too short to be meaningful — skip (e.g., "ok" / "好")
    return { matched: false, matchCount: 0, repeatedPrefix: '' };
  }

  // Compare full available content (capped to match caller truncation).
  // A genuine retry sends the exact same message; A2A review messages
  // share short prefixes but diverge in body — full comparison avoids
  // the false positive.
  const currentCapped = currentTrimmed.slice(0, COMPARE_CAP);

  // Count matches in recentUserMessages. In the real integration path,
  // recentUserMessages already includes the current message (detection runs
  // after storedUserMessage.append), so NO +1 needed. Direct count = total.
  let matchCount = 0;
  for (const msg of recentUserMessages) {
    if (msg.trim().slice(0, COMPARE_CAP) === currentCapped) {
      matchCount++;
    }
  }

  return {
    matched: matchCount >= RETRY_BURST_THRESHOLD,
    matchCount,
    repeatedPrefix: currentTrimmed.slice(0, RETRY_PREFIX_LENGTH),
  };
}
