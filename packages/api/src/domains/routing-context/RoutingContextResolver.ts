import { createHash } from 'node:crypto';
import type {
  RoutingCandidateBindingV1,
  RoutingContextSnapshotV1,
  RoutingPreferenceRevisionV1,
  RoutingSignalEventV1,
} from '@cat-cafe/shared';
import type {
  CapabilityProfileDegradationReason,
  CapabilityProfileRevisionSource,
} from './CapabilityProfileRevisionSource.js';
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
  signalStore: Pick<IRoutingSignalEventStore, 'getOwnerRevision' | 'listByOwner'>;
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
  private readonly signalTimelineCache = new Map<string, { revision: number; signalEvents: RoutingSignalEventV1[] }>();

  constructor(private readonly dependencies: RoutingContextResolverDependencies) {}

  async resolve(input: ResolveRoutingContextInput): Promise<RoutingContextResolution> {
    return (await this.resolveWithSources(input)).resolution;
  }

  async resolveWithSources(input: ResolveRoutingContextInput): Promise<RoutingContextResolutionWithSources> {
    const [signalEvents, preferenceRevisions, profileResult] = await Promise.all([
      this.loadSignalTimeline(input.ownerId),
      this.dependencies.preferenceStore.listByOwner(input.ownerId),
      this.dependencies.profileRevisionSource.load({
        ownerId: input.ownerId,
        candidates: input.candidates,
        intent: input.intent,
      }),
    ]);
    if (profileResult.status === 'degraded') {
      return {
        resolution: profileResult,
        signalEvents: sortSignals(signalEvents),
        preferenceRevisions: sortPreferences(preferenceRevisions),
      };
    }

    const candidates = sortCandidates(input.candidates);
    const signals = sortSignals(signalEvents);
    const preferences = sortPreferences(preferenceRevisions);
    const profiles = [...profileResult.profiles].sort(
      (left, right) =>
        left.catId.localeCompare(right.catId) || left.dossierRevision.localeCompare(right.dossierRevision),
    );
    const snapshot = reduceRoutingContext({
      ...input,
      candidates,
      profiles,
      signalEvents: signals,
      preferenceRevisions: preferences,
    });
    const inputRevisionRef = digest({
      ownerId: input.ownerId,
      observedAt: input.observedAt,
      catalogRevision: input.catalogRevision,
      intent: input.intent ?? null,
      candidates,
      profiles,
      signalEvents: signals,
      preferenceRevisions: preferences,
    });

    return {
      resolution: {
        status: 'fresh',
        snapshot,
        inputRevisionRef,
        sourceRefs: {
          signalEventIds: signals.map((event) => event.eventId),
          preferenceRevisionIds: preferences.map((preference) => preference.revisionId),
          dossierRevisions: profiles.map((profile) => profile.dossierRevision),
        },
      },
      signalEvents: signals,
      preferenceRevisions: preferences,
    };
  }

  private async loadSignalTimeline(ownerId: string): Promise<RoutingSignalEventV1[]> {
    const revisionBefore = await this.dependencies.signalStore.getOwnerRevision(ownerId);
    const cached = this.signalTimelineCache.get(ownerId);
    if (cached?.revision === revisionBefore) {
      this.signalTimelineCache.delete(ownerId);
      this.signalTimelineCache.set(ownerId, cached);
      return [...cached.signalEvents];
    }

    const signalEvents = sortSignals(await this.dependencies.signalStore.listByOwner(ownerId));
    const revisionAfter = await this.dependencies.signalStore.getOwnerRevision(ownerId);
    if (revisionBefore === revisionAfter) {
      this.signalTimelineCache.set(ownerId, { revision: revisionAfter, signalEvents });
      while (this.signalTimelineCache.size > 256) {
        const oldestOwnerId = this.signalTimelineCache.keys().next().value;
        if (oldestOwnerId === undefined) break;
        this.signalTimelineCache.delete(oldestOwnerId);
      }
    } else {
      this.signalTimelineCache.delete(ownerId);
    }
    return [...signalEvents];
  }
}
