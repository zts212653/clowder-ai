import { createHash } from 'node:crypto';
import { ownerTruthRefV1Schema, refIdentity } from '@cat-cafe/shared';
import type { EvalRepairOwnerLineage } from './eval-repair-approval-contracts.js';
import type {
  EvalRepairOwnerRuntimeBindings,
  EvalRepairOwnerRuntimeRouteRefV1,
  EvalRepairOwnerRuntimeRouteV1,
} from './eval-repair-owner-runtime.js';

interface ProviderSnapshot {
  route: EvalRepairOwnerRuntimeRouteV1;
  bindings?: EvalRepairOwnerRuntimeBindings;
}

type CompositionResult =
  | { status: 'active'; bindings: EvalRepairOwnerRuntimeBindings }
  | { status: 'blocked'; missing: string[] };

function validRouteRef(candidate: EvalRepairOwnerRuntimeRouteRefV1): boolean {
  return (
    typeof candidate.ownerFeatureId === 'string' &&
    candidate.ownerFeatureId.trim().length > 0 &&
    typeof candidate.ownerStateRef === 'string' &&
    /^[^\s{}[\]"']+$/.test(candidate.ownerStateRef) &&
    (candidate.match === 'exact' || candidate.match === 'prefix')
  );
}

function matchesRouteRef(
  route: EvalRepairOwnerRuntimeRouteRefV1,
  candidate: { ownerFeatureId: string; ownerStateRef: string },
): boolean {
  if (route.ownerFeatureId !== candidate.ownerFeatureId) return false;
  return route.match === 'exact'
    ? route.ownerStateRef === candidate.ownerStateRef
    : candidate.ownerStateRef.startsWith(route.ownerStateRef);
}

function routeRefsOverlap(left: EvalRepairOwnerRuntimeRouteRefV1, right: EvalRepairOwnerRuntimeRouteRefV1): boolean {
  if (left.ownerFeatureId !== right.ownerFeatureId) return false;
  if (left.match === 'exact' && right.match === 'exact') return left.ownerStateRef === right.ownerStateRef;
  if (left.match === 'exact') return left.ownerStateRef.startsWith(right.ownerStateRef);
  if (right.match === 'exact') return right.ownerStateRef.startsWith(left.ownerStateRef);
  return left.ownerStateRef.startsWith(right.ownerStateRef) || right.ownerStateRef.startsWith(left.ownerStateRef);
}

function hasCrossProviderOverlap(
  snapshots: readonly ProviderSnapshot[],
  refs: (route: EvalRepairOwnerRuntimeRouteV1) => readonly EvalRepairOwnerRuntimeRouteRefV1[],
): boolean {
  for (let leftIndex = 0; leftIndex < snapshots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < snapshots.length; rightIndex += 1) {
      if (
        refs(snapshots[leftIndex].route).some((left) =>
          refs(snapshots[rightIndex].route).some((right) => routeRefsOverlap(left, right)),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function invalidRoutes(snapshots: readonly ProviderSnapshot[]): boolean {
  const providerIds = new Set<string>();
  for (const { route } of snapshots) {
    if (
      route.schemaVersion !== 1 ||
      route.providerId.trim().length === 0 ||
      providerIds.has(route.providerId) ||
      route.programRefs.length === 0 ||
      route.repairTargetRefs.length === 0 ||
      route.assetVersionRefs.length === 0 ||
      [
        ...route.repairTargetRefs,
        ...route.assetVersionRefs,
        ...route.interventionReceiptRefs,
        ...route.freshOutcomeReceiptRefs,
      ].some((candidate) => !validRouteRef(candidate))
    ) {
      return true;
    }
    try {
      route.programRefs.forEach((ref) => ownerTruthRefV1Schema.parse(ref));
    } catch {
      return true;
    }
    providerIds.add(route.providerId);
  }
  return false;
}

function ambiguousRoutes(snapshots: readonly ProviderSnapshot[]): boolean {
  for (let leftIndex = 0; leftIndex < snapshots.length; leftIndex += 1) {
    const left = snapshots[leftIndex].route;
    for (let rightIndex = leftIndex + 1; rightIndex < snapshots.length; rightIndex += 1) {
      const right = snapshots[rightIndex].route;
      if (
        left.programRefs.some((candidate) =>
          right.programRefs.some((ref) => refIdentity(candidate) === refIdentity(ref)),
        )
      ) {
        return true;
      }
    }
  }
  return (
    hasCrossProviderOverlap(snapshots, (route) => route.repairTargetRefs) ||
    hasCrossProviderOverlap(snapshots, (route) => route.assetVersionRefs) ||
    hasCrossProviderOverlap(snapshots, (route) => route.interventionReceiptRefs) ||
    hasCrossProviderOverlap(snapshots, (route) => route.freshOutcomeReceiptRefs)
  );
}

function blockerRef(kind: 'unresolved' | 'unavailable', parts: readonly string[]) {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F266',
    ownerStateRef: `owner-federation:${kind}:sha256:${digest}`,
  });
}

function byProgram(
  snapshots: readonly ProviderSnapshot[],
  programRef: { ownerFeatureId: string; ownerStateRef: string },
) {
  return snapshots.find((candidate) =>
    candidate.route.programRefs.some((routeRef) => refIdentity(routeRef) === refIdentity(programRef)),
  );
}

function byRouteRef(
  snapshots: readonly ProviderSnapshot[],
  targetRef: { ownerFeatureId: string; ownerStateRef: string },
  refs: (route: EvalRepairOwnerRuntimeRouteV1) => readonly EvalRepairOwnerRuntimeRouteRefV1[],
) {
  return snapshots.find((candidate) => refs(candidate.route).some((routeRef) => matchesRouteRef(routeRef, targetRef)));
}

function byReceipt(
  snapshots: readonly ProviderSnapshot[],
  receiptRef: { ownerFeatureId: string; ownerStateRef: string },
  refs: (route: EvalRepairOwnerRuntimeRouteV1) => readonly EvalRepairOwnerRuntimeRouteRefV1[],
) {
  return snapshots.find((candidate) => refs(candidate.route).some((routeRef) => matchesRouteRef(routeRef, receiptRef)));
}

function unavailable(snapshot: ProviderSnapshot | undefined, operation: string) {
  return blockerRef(snapshot ? 'unavailable' : 'unresolved', [snapshot?.route.providerId ?? 'none', operation]);
}

export function composeEvalRepairOwnerBindings(snapshots: readonly ProviderSnapshot[]): CompositionResult {
  if (snapshots.length === 0 || invalidRoutes(snapshots)) {
    return { status: 'blocked', missing: ['ownerBindings:route_invalid'] };
  }
  if (ambiguousRoutes(snapshots)) {
    return { status: 'blocked', missing: ['ownerBindings:route_ambiguous'] };
  }
  if (!snapshots.some((snapshot) => snapshot.bindings)) {
    return { status: 'blocked', missing: ['ownerBindings'] };
  }

  const bindings: EvalRepairOwnerRuntimeBindings = {
    async resolveOwnerChangeContract(input) {
      const snapshot = byRouteRef(
        snapshots,
        {
          ownerFeatureId: input.featureId,
          ownerStateRef: input.componentId ?? '',
        },
        (route) => route.repairTargetRefs,
      );
      if (!snapshot?.bindings) {
        return {
          status: 'blocked',
          reason: 'owner_unresolved',
          blockerRef: unavailable(snapshot, 'resolve-owner'),
        };
      }
      return snapshot.bindings.resolveOwnerChangeContract(input);
    },
    canonicalRepairDispatcher: {
      async materialize(input) {
        const snapshot = byRouteRef(snapshots, input.targetVersionRef, (route) => route.assetVersionRefs);
        if (!snapshot?.bindings) {
          return {
            status: 'blocked',
            reason: 'owner_unresolved',
            blockerRef: unavailable(snapshot, 'materialize'),
          };
        }
        return snapshot.bindings.canonicalRepairDispatcher.materialize(input);
      },
    },
    interventionReceiptOwner: {
      async resolve(receiptRef) {
        const snapshot = byReceipt(snapshots, receiptRef, (route) => route.interventionReceiptRefs);
        return snapshot?.bindings ? snapshot.bindings.interventionReceiptOwner.resolve(receiptRef) : null;
      },
    },
    freshOutcomeOwner: {
      async resolve(receiptRef) {
        const snapshot = byReceipt(snapshots, receiptRef, (route) => route.freshOutcomeReceiptRefs);
        return snapshot?.bindings ? snapshot.bindings.freshOutcomeOwner.resolve(receiptRef) : null;
      },
    },
    requestAuthorityVerifier: {
      async verify(authority, lineage?: EvalRepairOwnerLineage) {
        const snapshot = lineage ? byProgram(snapshots, lineage.programRef) : undefined;
        return snapshot?.bindings
          ? snapshot.bindings.requestAuthorityVerifier.verify(authority, lineage)
          : { status: 'blocked', reason: 'owner_unresolved' };
      },
    },
    lineageResolver: {
      async resolve(lineage) {
        const snapshot = byProgram(snapshots, lineage.programRef);
        return snapshot?.bindings
          ? snapshot.bindings.lineageResolver.resolve(lineage)
          : { status: 'blocked', reason: 'lineage_missing' };
      },
    },
    valueDecisionAuthorityVerifier: {
      async verify(authority, subject) {
        const snapshot = byProgram(snapshots, subject.programRef);
        return snapshot?.bindings
          ? snapshot.bindings.valueDecisionAuthorityVerifier.verify(authority, subject)
          : { status: 'blocked', reason: 'value_owner_unverified' };
      },
    },
    decisionOwner: {
      async execute(input) {
        const snapshot = byProgram(snapshots, input.programRef);
        return snapshot?.bindings
          ? snapshot.bindings.decisionOwner.execute(input)
          : { status: 'blocked', reason: 'owner_unresolved' };
      },
    },
  };
  return { status: 'active', bindings };
}
