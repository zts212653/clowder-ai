import { PAW_FEEL_CONTINUATION_KINDS, type PawFeelInboxPage } from '@cat-cafe/shared';

function hasIssueProjection(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const issue = (value as { issue?: unknown }).issue;
  if (!issue || typeof issue !== 'object') return false;
  const candidate = issue as {
    resolution?: unknown;
    ageMs?: unknown;
    continuation?: { kind?: unknown; evidenceRefs?: unknown };
  };
  return (
    (candidate.resolution === 'open' || candidate.resolution === 'resolved') &&
    typeof candidate.ageMs === 'number' &&
    Number.isFinite(candidate.ageMs) &&
    candidate.ageMs >= 0 &&
    typeof candidate.continuation?.kind === 'string' &&
    PAW_FEEL_CONTINUATION_KINDS.includes(candidate.continuation.kind as (typeof PAW_FEEL_CONTINUATION_KINDS)[number]) &&
    Array.isArray(candidate.continuation.evidenceRefs)
  );
}

export function isPawFeelInboxPage(value: unknown, requireWorkspaceShape = false): value is PawFeelInboxPage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PawFeelInboxPage>;
  if (
    (candidate.projectionStatus !== 'available' && candidate.projectionStatus !== 'unavailable') ||
    !Array.isArray(candidate.items) ||
    !candidate.items.every(hasIssueProjection) ||
    typeof candidate.degraded !== 'boolean'
  ) {
    return false;
  }
  if (!requireWorkspaceShape) return true;
  return (
    Array.isArray(candidate.bundles) &&
    candidate.bundles.every(hasIssueProjection) &&
    typeof candidate.bundleCounts === 'object' &&
    typeof candidate.denominator === 'object' &&
    typeof candidate.counts === 'object' &&
    typeof candidate.issueCounts === 'object'
  );
}
