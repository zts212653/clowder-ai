import type { ActionFreshnessResolution, ActionSubjectTruthResolver } from './ActionSubjectTruthResolver.js';
import type { CanonicalActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import { ActionSuccessorStandingError, type ActionSuccessorStandingSnapshot } from './action-successor-standing.js';

type StandingContext = ActionSuccessorStandingSnapshot;
export async function resolveAdmissionFreshness(
  resolver: Pick<ActionSubjectTruthResolver, 'resolveFreshness'>,
  predicate: CanonicalActionTerminalPredicate,
  _input: StandingContext,
): Promise<ActionFreshnessResolution> {
  const freshness = await resolver.resolveFreshness(predicate);
  if (freshness.status !== 'verified') return freshness;
  if (freshness.freshnessKey !== predicate.freshnessKey)
    return {
      status: 'mismatch',
      reason: 'verified freshness identity does not match the canonical predicate',
      evidenceRef: freshness.evidenceRef,
    };
  return freshness;
}

export async function requireAdmissionFreshness(
  resolver: Pick<ActionSubjectTruthResolver, 'resolveFreshness'>,
  predicate: CanonicalActionTerminalPredicate,
  input: StandingContext,
): Promise<Extract<ActionFreshnessResolution, { status: 'verified' }>> {
  const freshness = await resolveAdmissionFreshness(resolver, predicate, input);
  if (freshness.status !== 'verified') throw new ActionSuccessorStandingError(freshness.status, freshness.reason);
  return freshness;
}
