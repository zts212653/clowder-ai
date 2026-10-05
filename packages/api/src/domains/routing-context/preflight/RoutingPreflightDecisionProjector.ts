import type { RoutingContextSnapshotV1, RoutingPreflightDecisionV1, RoutingReasonV1 } from '@cat-cafe/shared';
import { CAPABILITY_PROFILE_INVALID_REASON } from '../CapabilityProfileRevisionSource.js';
import type { RoutingContextResolution } from '../RoutingContextResolver.js';

function reasonRefsForAlternative(snapshot: RoutingContextSnapshotV1, catId: string): string[] {
  const candidate = snapshot.candidates.find((entry) => entry.binding.catId === catId);
  const refs = [
    snapshot.catalogRevision,
    ...(candidate?.profile.state === 'applied' ? [candidate.profile.revision.dossierRevision] : []),
    ...(candidate?.reasons.flatMap((reason) => reason.sourceRefs) ?? []),
  ];
  return [...new Set(refs)].slice(0, 16);
}

function alternativesFor(snapshot: RoutingContextSnapshotV1, targetCatId: string) {
  return snapshot.candidates
    .filter(
      (candidate) =>
        candidate.binding.catId !== targetCatId &&
        candidate.effect === 'eligible' &&
        candidate.profile.state === 'applied',
    )
    .slice(0, 32)
    .map((candidate) => ({
      catId: candidate.binding.catId,
      reasonRefs: reasonRefsForAlternative(snapshot, candidate.binding.catId),
    }));
}

function contextualSignalsForCandidate(candidate: RoutingContextSnapshotV1['candidates'][number]): RoutingReasonV1[] {
  if (candidate.profile.state === 'absent') return [];
  const profile = candidate.profile.revision;
  return profile.relevantSignals.map((signal) => ({
    code: `capability_${signal.kind}`,
    summary: signal.summary,
    sourceRefs: [...new Set([profile.dossierRevision, ...signal.evidenceRefs])],
  }));
}

export function unavailableReason(failureClass: string): RoutingReasonV1 {
  return {
    code: 'routing_context_unavailable',
    summary: 'Routing context is temporarily unavailable; the requested target remains unchanged',
    sourceRefs: [`routing-context:${failureClass}`],
  };
}

export type FreshRoutingContextResolution = Extract<RoutingContextResolution, { status: 'fresh' }>;
type RoutingPreflightTarget = RoutingPreflightDecisionV1['targets'][number];

export function freshTargetDecision(
  input: { ownerRequestedAttempt?: boolean },
  resolution: FreshRoutingContextResolution,
  targetCatId: string,
): RoutingPreflightTarget {
  const candidate = resolution.snapshot.candidates.find((entry) => entry.binding.catId === targetCatId);
  if (candidate === undefined) {
    return {
      targetCatId,
      disposition: 'warned',
      reasons: [
        {
          code: 'routing_target_not_in_catalog',
          summary: 'The requested target has no binding in the resolved runtime catalog',
          sourceRefs: [resolution.snapshot.catalogRevision],
        },
      ],
      alternatives: alternativesFor(resolution.snapshot, targetCatId),
    };
  }
  const ownerAttempt =
    input.ownerRequestedAttempt === true &&
    candidate.availability === 'unavailable' &&
    candidate.dispatch?.ownerAttemptAllowed === true;
  const disposition = ownerAttempt
    ? ('warned' as const)
    : candidate.availability === 'unavailable'
      ? ('rejected' as const)
      : candidate.availability === 'available' &&
          !candidate.reasons.some((reason) => reason.code === CAPABILITY_PROFILE_INVALID_REASON)
        ? ('allowed' as const)
        : ('warned' as const);
  return {
    targetCatId,
    disposition,
    ...(ownerAttempt ? { ownerAttempt: true as const } : {}),
    ...(candidate.dispatch?.automaticRetryAt !== undefined
      ? { automaticRetryAt: candidate.dispatch.automaticRetryAt }
      : {}),
    reasons: candidate.reasons,
    contextualSignals: contextualSignalsForCandidate(candidate),
    alternatives: disposition === 'allowed' ? [] : alternativesFor(resolution.snapshot, targetCatId),
  };
}
