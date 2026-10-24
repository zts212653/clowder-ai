import {
  type RoutingCandidateBindingV1,
  type RoutingContextReadModelV1,
  routingContextReadModelV1Schema,
} from '@cat-cafe/shared';
import type { RoutingExecutionBindingProof } from '../../config/account-routing-capacity.js';
import type {
  ResolveRoutingContextInput,
  RoutingContextResolution,
  RoutingContextResolutionWithSources,
} from './RoutingContextResolver.js';

const MAX_READ_MODEL_LEDGER_ITEMS = 10_000;

function latest<T>(items: readonly T[]): T[] {
  return items.slice(-MAX_READ_MODEL_LEDGER_ITEMS);
}

export interface RoutingCandidateCatalogSnapshot {
  catalogRevision: string;
  candidates: RoutingCandidateBindingV1[];
}

export interface RoutingCandidateCatalogSource {
  load(input: {
    ownerId: string;
    targetCatIds?: readonly string[];
    observedAt?: number;
    executionBindings?: readonly RoutingExecutionBindingProof[];
  }): Promise<RoutingCandidateCatalogSnapshot>;
}

interface RoutingContextReadResolver {
  resolve(input: ResolveRoutingContextInput): Promise<RoutingContextResolution>;
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

export type RoutingSnapshotReadModel = Pick<RoutingContextReadModelV1, 'resolution'>;

function projectResolution(
  loaded: RoutingContextResolution,
  catalog: RoutingCandidateCatalogSnapshot,
): RoutingSnapshotReadModel['resolution'] {
  return loaded.status === 'fresh'
    ? {
        state: 'fresh',
        snapshot: loaded.snapshot,
        inputRevisionRef: loaded.inputRevisionRef,
        sourceRefs: {
          signalEventIds: latest(loaded.sourceRefs.signalEventIds),
          preferenceRevisionIds: latest(loaded.sourceRefs.preferenceRevisionIds),
          dossierRevisions: loaded.sourceRefs.dossierRevisions,
        },
      }
    : {
        state: 'degraded',
        reason: loaded.reason,
        affectedCatIds: loaded.affectedCatIds,
        candidateBindings: catalog.candidates,
      };
}

export class RoutingContextReadService {
  constructor(private readonly dependencies: RoutingContextReadServiceDependencies) {}

  /** Selection is a decision read, not a history/presentation read. Never load the audit ledger here. */
  async readSnapshot(input: RoutingContextReadInput): Promise<RoutingSnapshotReadModel> {
    const catalog = await this.dependencies.catalogSource.load(input);
    const resolution = await this.dependencies.resolver.resolve({
      ...input,
      catalogRevision: catalog.catalogRevision,
      candidates: catalog.candidates,
    });
    return { resolution: projectResolution(resolution, catalog) };
  }

  async read(input: RoutingContextReadInput): Promise<RoutingContextReadModelV1> {
    const catalog = await this.dependencies.catalogSource.load({
      ownerId: input.ownerId,
      targetCatIds: input.targetCatIds,
      observedAt: input.observedAt,
    });
    const loaded = await this.dependencies.resolver.resolveWithSources({
      ownerId: input.ownerId,
      observedAt: input.observedAt,
      catalogRevision: catalog.catalogRevision,
      intent: input.intent,
      candidates: catalog.candidates,
    });
    const resolution = projectResolution(loaded.resolution, catalog);
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
