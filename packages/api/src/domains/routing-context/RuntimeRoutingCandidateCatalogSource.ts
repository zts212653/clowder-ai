import { createHash } from 'node:crypto';
import type { CatConfig, RoutingCandidateBindingV1 } from '@cat-cafe/shared';
import type { RoutingCandidateCatalogSnapshot, RoutingCandidateCatalogSource } from './RoutingContextReadService.js';

export interface RuntimeRoutingCandidateCatalogSourceOptions {
  getConfigs: () => Record<string, CatConfig>;
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

  async load(input: { ownerId: string; targetCatIds?: readonly string[] }): Promise<RoutingCandidateCatalogSnapshot> {
    const configs = this.options.getConfigs();
    const entries = Object.entries(configs).sort(([left], [right]) => left.localeCompare(right));
    const allCandidates: RoutingCandidateBindingV1[] = entries.map(([catId, config]) => ({
      v: 1,
      catId,
      providerId: config.provider?.trim() || config.clientId,
      provenQuotaPools: [],
    }));
    return {
      catalogRevision: catalogDigest(
        entries.map(([catId, config]) => ({
          catId,
          providerId: config.provider?.trim() || config.clientId,
          modelId: config.defaultModel,
        })),
      ),
      candidates: input.targetCatIds
        ? allCandidates.filter((candidate) => input.targetCatIds?.includes(candidate.catId))
        : allCandidates,
    };
  }
}
