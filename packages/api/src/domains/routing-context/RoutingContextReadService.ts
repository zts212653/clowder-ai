import {
  type RoutingCandidateBindingV1,
  type RoutingContextReadModelV1,
  routingContextReadModelV1Schema,
} from '@cat-cafe/shared';
import type { ResolveRoutingContextInput, RoutingContextResolutionWithSources } from './RoutingContextResolver.js';

const MAX_READ_MODEL_LEDGER_ITEMS = 10_000;

function latest<T>(items: readonly T[]): T[] {
  return items.slice(-MAX_READ_MODEL_LEDGER_ITEMS);
}

export interface RoutingCandidateCatalogSnapshot {
  catalogRevision: string;
  candidates: RoutingCandidateBindingV1[];
}

export interface RoutingCandidateCatalogSource {
  load(input: { ownerId: string; targetCatIds?: readonly string[] }): Promise<RoutingCandidateCatalogSnapshot>;
}

interface RoutingContextReadResolver {
  resolveWithSources(input: ResolveRoutingContextInput): Promise<RoutingContextResolutionWithSources>;
}

interface RoutingContextReadServiceDependencies {
  catalogSource: RoutingCandidateCatalogSource;
  resolver: RoutingContextReadResolver;
}

export interface RoutingContextReadInput {
  ownerId: string;
  observedAt: number;
  intent?: 'review' | 'architecture';
  targetCatIds?: readonly string[];
}

export class RoutingContextReadService {
  constructor(private readonly dependencies: RoutingContextReadServiceDependencies) {}

  async read(input: RoutingContextReadInput): Promise<RoutingContextReadModelV1> {
    const catalog = await this.dependencies.catalogSource.load({
      ownerId: input.ownerId,
      targetCatIds: input.targetCatIds,
    });
    const loaded = await this.dependencies.resolver.resolveWithSources({
      ownerId: input.ownerId,
      observedAt: input.observedAt,
      catalogRevision: catalog.catalogRevision,
      intent: input.intent,
      candidates: catalog.candidates,
    });
    const resolution =
      loaded.resolution.status === 'fresh'
        ? {
            state: 'fresh' as const,
            snapshot: loaded.resolution.snapshot,
            inputRevisionRef: loaded.resolution.inputRevisionRef,
            sourceRefs: {
              signalEventIds: latest(loaded.resolution.sourceRefs.signalEventIds),
              preferenceRevisionIds: latest(loaded.resolution.sourceRefs.preferenceRevisionIds),
              dossierRevisions: loaded.resolution.sourceRefs.dossierRevisions,
            },
          }
        : {
            state: 'degraded' as const,
            reason: loaded.resolution.reason,
            affectedCatIds: loaded.resolution.affectedCatIds,
            candidateBindings: catalog.candidates,
          };
    return routingContextReadModelV1Schema.parse({
      v: 1,
      ownerId: input.ownerId,
      observedAt: input.observedAt,
      catalogRevision: catalog.catalogRevision,
      resolution,
      signalEvents: latest(loaded.signalEvents),
      preferenceRevisions: latest(loaded.preferenceRevisions),
    });
  }
}
