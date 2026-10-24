import { createHash } from 'node:crypto';
import type { CatConfig, RoutingCandidateBindingV1 } from '@cat-cafe/shared';
import {
  type RoutingExecutionBindingProof,
  readAccountRoutingCapacity,
} from '../../config/account-routing-capacity.js';
import { resolveOwnerGate } from '../../utils/owner-gate.js';
import type { RoutingCandidateCatalogSnapshot, RoutingCandidateCatalogSource } from './RoutingContextReadService.js';

export interface RuntimeRoutingCandidateCatalogSourceOptions {
  getConfigs: () => Record<string, CatConfig>;
  projectRoot?: string;
}

function catalogDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/**
 * Binds F293 to the live runtime member catalog without inventing account or
 * quota-pool identities. Dynamic availability remains owned by signal truth.
 */
export class RuntimeRoutingCandidateCatalogSource implements RoutingCandidateCatalogSource {
  constructor(private readonly options: RuntimeRoutingCandidateCatalogSourceOptions) {}

  async load(input: {
    ownerId: string;
    targetCatIds?: readonly string[];
    observedAt?: number;
    executionBindings?: readonly RoutingExecutionBindingProof[];
  }): Promise<RoutingCandidateCatalogSnapshot> {
    const configs = this.options.getConfigs();
    const entries = Object.entries(configs).sort(([left], [right]) => left.localeCompare(right));
    let capacity: ReturnType<typeof readAccountRoutingCapacity> | undefined;
    if (this.options.projectRoot) {
      try {
        if (resolveOwnerGate(input.ownerId)) throw new Error('routing_capacity_owner_required');
        capacity = readAccountRoutingCapacity({
          projectRoot: this.options.projectRoot,
          configs,
          observedAt: input.observedAt ?? Date.now(),
          ...(input.executionBindings ? { executionBindings: input.executionBindings } : {}),
        });
      } catch {
        capacity = new Map(
          entries.map(([catId]) => [
            catId,
            {
              provenQuotaPools: [],
              capacityFacts: {
                v: 1,
                current: { state: 'unknown', reason: 'source_unavailable', windows: [] },
                switchRequired: [],
              },
            },
          ]),
        );
      }
    }
    const allCandidates: RoutingCandidateBindingV1[] = entries.map(([catId, config]) => ({
      v: 1,
      catId,
      providerId:
        input.executionBindings?.find((proof) => proof.catId === catId)?.providerId ??
        (config.provider?.trim() || config.clientId),
      provenQuotaPools: [],
      ...capacity?.get(catId),
    }));
    return {
      catalogRevision: catalogDigest(
        allCandidates.map((candidate) => ({
          ...candidate,
          modelId: configs[candidate.catId]?.defaultModel,
        })),
      ),
      candidates: input.targetCatIds
        ? allCandidates.filter((candidate) => input.targetCatIds?.includes(candidate.catId))
        : allCandidates,
    };
  }
}
