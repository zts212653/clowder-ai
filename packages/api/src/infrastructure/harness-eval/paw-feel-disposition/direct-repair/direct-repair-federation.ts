import { createHash } from 'node:crypto';
import {
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  type PawFeelDirectRepairAuthorityDecisionV1,
  type PawFeelDirectRepairBindingV1,
  type PawFeelDirectRepairOutcomeV1,
  type PawFeelDirectRepairOwnerRouteV1,
  type SourceToolRouteRefV1,
  type VerifiedPawFeelDirectRepairSourceV1,
} from '@cat-cafe/shared';
import type { PawFeelResolvedFix } from '../commands.js';
import { PawFeelDirectRepairError } from './direct-repair-errors.js';

export interface PawFeelDirectRepairOwnerProvider {
  resolveAuthority(input: {
    source: VerifiedPawFeelDirectRepairSourceV1;
    custody: PawFeelResolvedFix;
    actionRef: string;
  }): Promise<PawFeelDirectRepairAuthorityDecisionV1>;
  verifyOutcome(input: {
    binding: PawFeelDirectRepairBindingV1;
    ownerOutcomeRef: OwnerTruthRefV1;
    taskTerminalRef: OwnerTruthRefV1;
    leaseTerminalRef: OwnerTruthRefV1;
  }): Promise<PawFeelDirectRepairOutcomeV1>;
}

export interface PawFeelDirectRepairProviderSnapshot {
  route: PawFeelDirectRepairOwnerRouteV1;
  provider?: PawFeelDirectRepairOwnerProvider;
}

export interface SelectedPawFeelDirectRepairProvider {
  route: PawFeelDirectRepairOwnerRouteV1;
  provider: PawFeelDirectRepairOwnerProvider;
  providerRouteRef: OwnerTruthRefV1;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function validSourceToolRoute(candidate: SourceToolRouteRefV1): boolean {
  return (
    hasExactKeys(candidate, ['match', 'ownerFeatureId', 'ownerStateRef']) &&
    candidate.ownerFeatureId === candidate.ownerFeatureId.trim() &&
    candidate.ownerFeatureId.length > 0 &&
    candidate.ownerStateRef === candidate.ownerStateRef.trim() &&
    /^[a-z][a-z0-9-]*:[^\s{}[\]"']+$/u.test(candidate.ownerStateRef) &&
    (candidate.match === 'exact' || candidate.match === 'prefix')
  );
}

function validRoute(route: PawFeelDirectRepairOwnerRouteV1): boolean {
  return (
    hasExactKeys(route, ['providerId', 'providerVersion', 'schemaVersion', 'sourceToolRoutes']) &&
    route.schemaVersion === 1 &&
    route.providerId === route.providerId.trim() &&
    route.providerId.length > 0 &&
    route.providerVersion === route.providerVersion.trim() &&
    route.providerVersion.length > 0 &&
    route.sourceToolRoutes.length > 0 &&
    route.sourceToolRoutes.every(validSourceToolRoute)
  );
}

function matches(route: SourceToolRouteRefV1, source: OwnerTruthRefV1): boolean {
  if (route.ownerFeatureId !== source.ownerFeatureId) return false;
  return route.match === 'exact'
    ? route.ownerStateRef === source.ownerStateRef
    : source.ownerStateRef.startsWith(route.ownerStateRef);
}

function overlap(left: SourceToolRouteRefV1, right: SourceToolRouteRefV1): boolean {
  if (left.ownerFeatureId !== right.ownerFeatureId) return false;
  if (left.match === 'exact' && right.match === 'exact') return left.ownerStateRef === right.ownerStateRef;
  if (left.match === 'exact') return left.ownerStateRef.startsWith(right.ownerStateRef);
  if (right.match === 'exact') return right.ownerStateRef.startsWith(left.ownerStateRef);
  return left.ownerStateRef.startsWith(right.ownerStateRef) || right.ownerStateRef.startsWith(left.ownerStateRef);
}

function canonicalRoutes(route: PawFeelDirectRepairOwnerRouteV1): SourceToolRouteRefV1[] {
  return [...route.sourceToolRoutes].sort((left, right) =>
    [left.ownerFeatureId, left.ownerStateRef, left.match]
      .join('\u0000')
      .localeCompare([right.ownerFeatureId, right.ownerStateRef, right.match].join('\u0000')),
  );
}

function frozenRoute(route: PawFeelDirectRepairOwnerRouteV1): PawFeelDirectRepairOwnerRouteV1 {
  const sourceToolRoutes = Object.freeze(canonicalRoutes(route).map((candidate) => Object.freeze({ ...candidate })));
  return Object.freeze({ ...route, sourceToolRoutes });
}

export function derivePawFeelProviderRouteRef(route: PawFeelDirectRepairOwnerRouteV1): OwnerTruthRefV1 {
  const digest = createHash('sha256')
    .update(JSON.stringify([route.providerId, route.providerVersion, canonicalRoutes(route)]))
    .digest('hex');
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F278',
    ownerStateRef: `paw-feel-direct-repair-route:sha256:${digest}`,
    version: route.providerVersion,
  });
}

export class PawFeelDirectRepairFederation {
  private readonly snapshots: readonly PawFeelDirectRepairProviderSnapshot[];
  private readonly invalid: boolean;
  private readonly ambiguous: boolean;

  constructor(snapshots: readonly PawFeelDirectRepairProviderSnapshot[]) {
    this.snapshots = Object.freeze(
      snapshots.map((snapshot) =>
        Object.freeze({
          route: frozenRoute(snapshot.route),
          ...(snapshot.provider ? { provider: snapshot.provider } : {}),
        }),
      ),
    );
    const providerIds = new Set<string>();
    this.invalid = this.snapshots.some(({ route }) => {
      const duplicate = providerIds.has(route.providerId);
      providerIds.add(route.providerId);
      return duplicate || !validRoute(route);
    });
    const routes = this.snapshots.flatMap((snapshot) => snapshot.route.sourceToolRoutes);
    this.ambiguous = routes.some((left, leftIndex) =>
      routes.some((right, rightIndex) => rightIndex > leftIndex && overlap(left, right)),
    );
  }

  select(sourceToolRef: OwnerTruthRefV1): SelectedPawFeelDirectRepairProvider {
    const source = ownerTruthRefV1Schema.parse(sourceToolRef);
    if (this.invalid) throw new PawFeelDirectRepairError('registration_invalid', 'provider registration is invalid');
    if (this.ambiguous) {
      throw new PawFeelDirectRepairError('provider_ambiguous', 'provider source-tool routes overlap');
    }
    const matchesSource = this.snapshots.filter(({ route }) =>
      route.sourceToolRoutes.some((candidate) => matches(candidate, source)),
    );
    if (matchesSource.length === 0) {
      throw new PawFeelDirectRepairError('provider_not_found', 'no provider owns the source tool route');
    }
    if (matchesSource.length !== 1) {
      throw new PawFeelDirectRepairError('provider_ambiguous', 'multiple providers own the source tool route');
    }
    const selected = matchesSource[0];
    if (!selected?.provider) {
      throw new PawFeelDirectRepairError('provider_unavailable', 'selected source-tool provider is unavailable');
    }
    return {
      route: selected.route,
      provider: selected.provider,
      providerRouteRef: derivePawFeelProviderRouteRef(selected.route),
    };
  }
}
