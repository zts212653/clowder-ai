/**
 * B-6: Guide Offer Policy — configurable trigger strategy layer.
 *
 * Replaces simple keyword matching with a policy that considers:
 * - Trigger mode: keyword (default), explicit (button/slash only), hybrid
 * - Confidence threshold (matched keywords / total keywords)
 * - Dismiss-rate suppression (blocks re-offer after N user cancellations)
 * - Explicit triggers bypass both confidence and dismiss checks
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TriggerStrategy {
  mode: 'keyword' | 'explicit' | 'hybrid';
  confidence?: number;
  max_dismissals?: number;
}

export interface OfferCandidate {
  id: string;
  name: string;
  score: number;
  totalKeywords: number;
}

export interface OfferResult {
  id: string;
  name: string;
  confidence: number;
}

export interface EvaluateOfferParams {
  candidates: OfferCandidate[];
  triggerStrategies: Record<string, TriggerStrategy>;
  userId: string;
  isExplicitTrigger: boolean;
  dismissCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_DISMISSALS = 3;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function normalizeMatchConfidence(score: number, totalKeywords: number): number {
  if (totalKeywords <= 0 || score <= 0) return 0;
  return Math.min(score / totalKeywords, 1);
}

// ---------------------------------------------------------------------------
// Core evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a list of keyword-matched candidates against offer policies.
 * Returns the best qualifying candidate, or null if all are filtered out.
 *
 * Pure function — dismiss counts are passed in, not read from Redis.
 * The caller is responsible for fetching dismiss counts beforehand.
 */
export function evaluateGuideOffer(params: EvaluateOfferParams): OfferResult | null {
  const { candidates, triggerStrategies, isExplicitTrigger, dismissCounts } = params;

  // Sort by confidence (highest first) for deterministic ranking
  const sorted = [...candidates]
    .map((c) => ({
      ...c,
      confidence: normalizeMatchConfidence(c.score, c.totalKeywords),
    }))
    .sort((a, b) => b.confidence - a.confidence);

  for (const candidate of sorted) {
    const strategy = triggerStrategies[candidate.id];
    const mode = strategy?.mode ?? 'keyword';
    const threshold = strategy?.confidence ?? 0;
    const maxDismissals = strategy?.max_dismissals ?? DEFAULT_MAX_DISMISSALS;

    // Explicit triggers bypass all non-structural filters
    if (isExplicitTrigger) {
      return {
        id: candidate.id,
        name: candidate.name,
        confidence: candidate.confidence,
      };
    }

    // Mode filter: explicit-only guides reject keyword triggers entirely
    if (mode === 'explicit') continue;

    // Dismiss suppression: too many cancellations → skip
    const dismissCount = dismissCounts[candidate.id] ?? 0;
    if (dismissCount >= maxDismissals) continue;

    // Confidence threshold (hybrid mode uses this, keyword defaults to 0)
    if (candidate.confidence < threshold) continue;

    return {
      id: candidate.id,
      name: candidate.name,
      confidence: candidate.confidence,
    };
  }

  return null;
}
