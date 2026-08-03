import type {
  PawFeelDenominator,
  PawFeelDispositionProjection,
  PawFeelDispositionState,
  PawFeelInboxItem,
  PawFeelReviewBundle,
  PawFeelReviewBundleBasis,
  PawFeelReviewBundleCounts,
} from '@cat-cafe/shared';

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
    return [{ ...bundle, members, rawSignalCount: members.length, stateCounts }];
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
