import { createHash } from 'node:crypto';
import type {
  RoutingCandidateBindingV1,
  RoutingContextSnapshotV1,
  RoutingPreferenceRevisionV1,
  RoutingSignalEventV1,
} from '@cat-cafe/shared';
import type {
  CapabilityProfileDegradationReason,
  CapabilityProfileRevisionLoadResult,
  CapabilityProfileRevisionSource,
} from './CapabilityProfileRevisionSource.js';
import {
  type RoutingSignalDecisionProjectionV1,
  routingSignalDecisionClosureMap,
  routingSignalDecisionSourceEventIds,
} from './preflight/RoutingSignalDecisionProjection.js';
import type { IRoutingPreferenceStore } from './RoutingPreferenceStore.js';
import type { IRoutingSignalEventStore } from './RoutingSignalEventStore.js';
import { reduceRoutingContext } from './routing-context-reducer.js';

export interface ResolveRoutingContextInput {
  ownerId: string;
  observedAt: number;
  catalogRevision: string;
  intent?: 'review' | 'architecture';
  candidates: readonly RoutingCandidateBindingV1[];
}

export type RoutingContextResolution =
  | {
      status: 'degraded';
      reason: CapabilityProfileDegradationReason;
      affectedCatIds: string[];
    }
  | {
      status: 'fresh';
      snapshot: RoutingContextSnapshotV1;
      inputRevisionRef: string;
      sourceRefs: {
        signalEventIds: string[];
        preferenceRevisionIds: string[];
        dossierRevisions: string[];
      };
    };

export interface RoutingContextResolutionWithSources {
  resolution: RoutingContextResolution;
  signalEvents: RoutingSignalEventV1[];
  preferenceRevisions: RoutingPreferenceRevisionV1[];
}

interface RoutingContextResolverDependencies {
  signalStore: Pick<IRoutingSignalEventStore, 'getOwnerRevision' | 'readDecisionProjection' | 'listByOwner'>;
  preferenceStore: Pick<IRoutingPreferenceStore, 'listByOwner'>;
  profileRevisionSource: CapabilityProfileRevisionSource;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function sortCandidates(candidates: readonly RoutingCandidateBindingV1[]): RoutingCandidateBindingV1[] {
  return [...candidates].sort(
    (left, right) => left.catId.localeCompare(right.catId) || left.providerId.localeCompare(right.providerId),
  );
}

function sortSignals(events: readonly RoutingSignalEventV1[]): RoutingSignalEventV1[] {
  return [...events].sort(
    (left, right) => left.observedAt - right.observedAt || left.eventId.localeCompare(right.eventId),
  );
}

function sortPreferences(revisions: readonly RoutingPreferenceRevisionV1[]): RoutingPreferenceRevisionV1[] {
  return [...revisions].sort(
    (left, right) =>
      left.preferenceId.localeCompare(right.preferenceId) ||
      left.version - right.version ||
      left.revisionId.localeCompare(right.revisionId),
  );
}

export class RoutingContextResolver {
  private readonly signalProjectionCache = new Map<string, RoutingSignalDecisionProjectionV1>();
  private readonly signalProjectionLoads = new Map<string, Promise<RoutingSignalDecisionProjectionV1>>();

  constructor(private readonly dependencies: RoutingContextResolverDependencies) {}

  async resolve(input: ResolveRoutingContextInput): Promise<RoutingContextResolution> {
    const [signalProjection, preferenceRevisions, profileResult] = await Promise.all([
      this.loadSignalProjection(input.ownerId),
      this.dependencies.preferenceStore.listByOwner(input.ownerId),
      this.dependencies.profileRevisionSource.load({
        ownerId: input.ownerId,
        candidates: input.candidates,
        intent: input.intent,
      }),
    ]);
    return this.composeResolution(input, signalProjection, preferenceRevisions, profileResult);
  }

  async resolveWithSources(input: ResolveRoutingContextInput): Promise<RoutingContextResolutionWithSources> {
    const [{ signalProjection, signalEvents }, preferenceRevisions, profileResult] = await Promise.all([
      this.loadSignalProjectionWithTimeline(input.ownerId),
      this.dependencies.preferenceStore.listByOwner(input.ownerId),
      this.dependencies.profileRevisionSource.load({
        ownerId: input.ownerId,
        candidates: input.candidates,
        intent: input.intent,
      }),
    ]);
    const preferences = sortPreferences(preferenceRevisions);
    return {
      resolution: this.composeResolution(input, signalProjection, preferences, profileResult),
      signalEvents: sortSignals(signalEvents),
      preferenceRevisions: preferences,
    };
  }

  private composeResolution(
    input: ResolveRoutingContextInput,
    signalProjection: RoutingSignalDecisionProjectionV1,
    preferenceRevisions: readonly RoutingPreferenceRevisionV1[],
    profileResult: CapabilityProfileRevisionLoadResult,
  ): RoutingContextResolution {
    if (profileResult.status === 'degraded') return profileResult;
    const candidates = sortCandidates(input.candidates);
    const signals = sortSignals(signalProjection.assertions);
    const preferences = sortPreferences(preferenceRevisions);
    const profiles = [...profileResult.profiles].sort(
      (left, right) =>
        left.catId.localeCompare(right.catId) || left.dossierRevision.localeCompare(right.dossierRevision),
    );
    const profileDiagnostics = profileResult.diagnostics ?? [];
    const snapshot = reduceRoutingContext({
      ...input,
      candidates,
      profiles,
      profileDiagnostics,
      signalEvents: signals,
      signalClosures: routingSignalDecisionClosureMap(signalProjection, input.observedAt),
      preferenceRevisions: preferences,
    });
    const inputRevisionRef = digest({
      ownerId: input.ownerId,
      observedAt: input.observedAt,
      catalogRevision: input.catalogRevision,
      intent: input.intent ?? null,
      candidates,
      profiles,
      ...(profileDiagnostics.length > 0 ? { profileDiagnostics } : {}),
      signalProjection: {
        v: signalProjection.v,
        ownerId: signalProjection.ownerId,
        revision: signalProjection.revision,
        contentHash: signalProjection.contentHash,
      },
      preferenceRevisions: preferences,
    });

    return {
      status: 'fresh',
      snapshot,
      inputRevisionRef,
      sourceRefs: {
        signalEventIds: routingSignalDecisionSourceEventIds(signalProjection),
        preferenceRevisionIds: preferences.map((preference) => preference.revisionId),
        dossierRevisions: profiles.map((profile) => profile.dossierRevision),
      },
    };
  }

  private async loadSignalProjection(ownerId: string): Promise<RoutingSignalDecisionProjectionV1> {
    const ownerRevision = await this.dependencies.signalStore.getOwnerRevision(ownerId);
    const cached = this.signalProjectionCache.get(ownerId);
    if (cached?.revision === ownerRevision) {
      this.signalProjectionCache.delete(ownerId);
      this.signalProjectionCache.set(ownerId, cached);
      return cached;
    }

    let load = this.signalProjectionLoads.get(ownerId);
    if (!load) {
      load = this.dependencies.signalStore.readDecisionProjection(ownerId);
      this.signalProjectionLoads.set(ownerId, load);
    }
    let projection: RoutingSignalDecisionProjectionV1;
    try {
      projection = await load;
    } finally {
      if (this.signalProjectionLoads.get(ownerId) === load) this.signalProjectionLoads.delete(ownerId);
    }
    this.signalProjectionCache.set(ownerId, projection);
    while (this.signalProjectionCache.size > 256) {
      const oldestOwnerId = this.signalProjectionCache.keys().next().value;
      if (oldestOwnerId === undefined) break;
      this.signalProjectionCache.delete(oldestOwnerId);
    }
    if (projection.revision < ownerRevision) return this.loadSignalProjection(ownerId);
    return projection;
  }

  private async loadSignalProjectionWithTimeline(ownerId: string): Promise<{
    signalProjection: RoutingSignalDecisionProjectionV1;
    signalEvents: RoutingSignalEventV1[];
  }> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const signalProjection = await this.loadSignalProjection(ownerId);
      const signalEvents = await this.dependencies.signalStore.listByOwner(ownerId);
      if (signalProjection.revision === (await this.dependencies.signalStore.getOwnerRevision(ownerId))) {
        return { signalProjection, signalEvents };
      }
      this.signalProjectionCache.delete(ownerId);
    }
    throw new TypeError(`routing signal owner revision changed during read-model resolution: ${ownerId}`);
  }
}
