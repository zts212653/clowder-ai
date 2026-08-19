import type {
  PawFeelDenominator,
  PawFeelDispositionProjection,
  PawFeelDispositionState,
  PawFeelInboxItem,
  PawFeelResponsibilityCounts,
  PawFeelResponsibilityProjection,
  PawFeelReviewBundle,
  PawFeelReviewBundleBasis,
  PawFeelReviewBundleCounts,
} from '@cat-cafe/shared';
import { aggregatePawFeelResponsibility } from './responsibility-aggregation.js';

export function emptyResponsibilityCounts(): PawFeelResponsibilityCounts {
  return { unreviewed: 0, bound_in_repair: 0, signature_waiting: 0, blocked: 0, terminal: 0 };
}

export interface PawFeelResponsibilityEvidence {
  proposalIsPending?: boolean;
  repairBindingIsActive?: boolean;
}

export function derivePawFeelResponsibility(
  projection: PawFeelDispositionProjection,
  evidence: PawFeelResponsibilityEvidence = {},
): PawFeelResponsibilityProjection {
  if (projection.state === 'fix') {
    const leaseId = projection.actionLeaseRef?.leaseId;
    const evidenceRefs = [projection.taskId, leaseId, projection.custodyEvidenceRef].filter((value): value is string =>
      Boolean(value),
    );
    const validExit = Boolean(
      projection.ownerCatId &&
        projection.taskId &&
        leaseId &&
        projection.custodyEvidenceRef &&
        evidence.repairBindingIsActive,
    );
    return {
      state: validExit ? 'bound_in_repair' : 'unreviewed',
      validExit,
      exitKind: 'repair_binding',
      evidenceRefs,
      ...(projection.ownerCatId ? { ownerCatId: projection.ownerCatId } : {}),
      ...(projection.taskId ? { taskId: projection.taskId } : {}),
      ...(leaseId ? { leaseId } : {}),
    };
  }
  if (projection.state === 'signature_waiting' && projection.signatureRequest) {
    return {
      state: 'signature_waiting',
      validExit: false,
      exitKind: 'signature_request',
      evidenceRefs: [projection.signatureRequest.requestId],
      signerExclusionCatId: projection.signatureRequest.excludedSignerCatId,
      ...(projection.signatureRequest.preferredSignerCatId
        ? { preferredSignerCatId: projection.signatureRequest.preferredSignerCatId }
        : {}),
    };
  }
  if (projection.state === 'blocked' && projection.blocker) {
    return {
      state: 'blocked',
      validExit: true,
      exitKind: 'explicit_blocker',
      evidenceRefs: [projection.blocker.ref],
      blocker: projection.blocker,
    };
  }
  if (projection.state === 'route_pending' && projection.proposalId && evidence.proposalIsPending) {
    return {
      state: 'blocked',
      validExit: true,
      exitKind: 'pending_proposal',
      evidenceRefs: [projection.proposalId],
      proposalId: projection.proposalId,
    };
  }
  if (projection.state === 'closed' || projection.state === 'duplicate' || projection.state === 'no_action') {
    return {
      state: 'terminal',
      validExit: true,
      exitKind: 'terminal_disposition',
      evidenceRefs: [projection.outcomeRef, projection.duplicateOf, projection.reasonCode].filter(
        (value): value is string => Boolean(value),
      ),
      ...(projection.ownerCatId ? { ownerCatId: projection.ownerCatId } : {}),
    };
  }
  return { state: 'unreviewed', validExit: false, exitKind: 'none', evidenceRefs: [] };
}

function deriveBundleResponsibility(members: readonly PawFeelInboxItem[]): PawFeelResponsibilityProjection {
  const responsibilities = members.map((member) => member.responsibility);
  return aggregatePawFeelResponsibility(responsibilities, 'paw-feel responsibility bundle has no members');
}

export function emptyBundleCounts(): PawFeelReviewBundleCounts {
  return {
    total: 0,
    byBasis: {
      message: 0,
      turn_invocation: 0,
      legacy_invocation: 0,
      single_signal: 0,
    },
  };
}

export function emptyDenominator(): PawFeelDenominator {
  return {
    reportOccurrences: 0,
    uniqueSourceMessages: 0,
    historicalBackfill: 0,
    postActivationIntake: 0,
    typedConfirmed: 0,
    ambiguousOrContaminated: 0,
    reviewBundles: 0,
    problemFamilies: {
      status: 'unavailable',
      reason: 'No authoritative grouping contract',
    },
  };
}

function bundleIdentity(
  item: PawFeelInboxItem,
  sourceOccurrenceCounts: ReadonlyMap<string, number>,
): { bundleKey: string; basis: PawFeelReviewBundleBasis } {
  const projection = item.disposition;
  if (item.source.availability !== 'available') {
    return { bundleKey: `signal:${projection.signalId}`, basis: 'single_signal' };
  }
  if (
    (item.reviewContext?.sourceMarkerCount ?? 0) > 1 ||
    (sourceOccurrenceCounts.get(projection.sourceMessageId) ?? 0) > 1
  ) {
    return { bundleKey: `message:${projection.sourceMessageId}`, basis: 'message' };
  }
  if (item.reviewContext?.turnInvocationId) {
    return {
      bundleKey: `turn:${item.reviewContext.turnInvocationId}`,
      basis: 'turn_invocation',
    };
  }
  if (item.reviewContext?.legacyInvocationId) {
    return {
      bundleKey: `legacy-invocation:${item.reviewContext.legacyInvocationId}`,
      basis: 'legacy_invocation',
    };
  }
  return { bundleKey: `signal:${projection.signalId}`, basis: 'single_signal' };
}

export function filterPawFeelBundles(
  bundles: readonly PawFeelReviewBundle[],
  predicate: (item: PawFeelInboxItem) => boolean,
): PawFeelReviewBundle[] {
  return bundles.flatMap((bundle) => {
    const members = bundle.members.filter(predicate);
    if (members.length === 0) return [];
    const stateCounts: Partial<Record<PawFeelDispositionState, number>> = {};
    for (const member of members) {
      const state = member.disposition.state;
      stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    }
    return [
      {
        ...bundle,
        members,
        rawSignalCount: members.length,
        stateCounts,
        responsibility: deriveBundleResponsibility(members),
      },
    ];
  });
}

export function derivePawFeelBundles(items: readonly PawFeelInboxItem[]): {
  bundles: PawFeelReviewBundle[];
  counts: PawFeelReviewBundleCounts;
} {
  const sourceOccurrenceCounts = new Map<string, number>();
  for (const item of items) {
    const id = item.disposition.sourceMessageId;
    sourceOccurrenceCounts.set(id, (sourceOccurrenceCounts.get(id) ?? 0) + 1);
  }

  const grouped = new Map<string, { basis: PawFeelReviewBundleBasis; members: PawFeelInboxItem[] }>();
  for (const item of items) {
    const identity = bundleIdentity(item, sourceOccurrenceCounts);
    const group = grouped.get(identity.bundleKey);
    if (group) group.members.push(item);
    else grouped.set(identity.bundleKey, { basis: identity.basis, members: [item] });
  }

  const counts = emptyBundleCounts();
  const bundles = [...grouped].map(([bundleKey, group]) => {
    const representative = group.members[0];
    if (!representative) throw new Error(`paw-feel bundle ${bundleKey} has no members`);
    const stateCounts: Partial<Record<PawFeelDispositionState, number>> = {};
    for (const member of group.members) {
      const state = member.disposition.state;
      stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    }
    counts.total += 1;
    counts.byBasis[group.basis] += 1;
    return {
      bundleKey,
      basis: group.basis,
      sourceThreadId: representative.disposition.sourceThreadId,
      representativeSourceMessageId: representative.disposition.sourceMessageId,
      members: group.members,
      rawSignalCount: group.members.length,
      stateCounts,
      responsibility: deriveBundleResponsibility(group.members),
    };
  });
  return { bundles, counts };
}

export function derivePawFeelDenominator(
  projections: readonly PawFeelDispositionProjection[],
  reviewBundles: number,
): PawFeelDenominator {
  const result = emptyDenominator();
  result.reportOccurrences = projections.length;
  result.uniqueSourceMessages = new Set(projections.map((item) => item.sourceMessageId)).size;
  result.historicalBackfill = projections.filter((item) => item.backfilled).length;
  result.postActivationIntake = projections.length - result.historicalBackfill;
  result.typedConfirmed = projections.filter(
    (item) => item.captureMethod === 'typed' && item.captureAssessment === 'confirmed',
  ).length;
  result.ambiguousOrContaminated = projections.filter((item) => item.captureAssessment !== 'confirmed').length;
  result.reviewBundles = reviewBundles;
  return result;
}
