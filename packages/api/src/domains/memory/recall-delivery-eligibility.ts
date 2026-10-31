import type { EvidenceItem } from './interfaces.js';

export const SUNSET_GLOBAL_DISTILLATION_PREFIX = 'distilled:';

export function isGenericRecallEligibleAnchor(anchor: string): boolean {
  return !anchor.toLowerCase().startsWith(SUNSET_GLOBAL_DISTILLATION_PREFIX);
}

export function isGenericRecallEligible(item: Pick<EvidenceItem, 'anchor'>): boolean {
  return isGenericRecallEligibleAnchor(item.anchor);
}

/**
 * A store applies `limit` before caller-side delivery eligibility is known.
 * Expand the candidate window until enough eligible rows are available or a
 * bounded ceiling is reached, so retired rows cannot consume the caller's top-K.
 */
export async function collectGenericRecallEligible<T extends Pick<EvidenceItem, 'anchor'>>(
  fetchCandidates: (candidateLimit: number) => Promise<T[]>,
  requestedLimit: number,
): Promise<T[]> {
  const normalizedLimit = Math.max(0, requestedLimit);
  if (normalizedLimit === 0) return [];

  const maxCandidateLimit = Math.min(Math.max(normalizedLimit * 4, 100), 1_000);
  let candidateLimit = Math.min(Math.max(normalizedLimit, 20), maxCandidateLimit);

  while (true) {
    const candidates = await fetchCandidates(candidateLimit);
    const eligible = candidates.filter(isGenericRecallEligible);
    if (
      eligible.length >= normalizedLimit ||
      candidates.length < candidateLimit ||
      candidateLimit >= maxCandidateLimit
    ) {
      return eligible.slice(0, normalizedLimit);
    }
    candidateLimit = Math.min(candidateLimit * 2, maxCandidateLimit);
  }
}
