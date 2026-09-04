import type { RecallOpportunityV1 } from '@cat-cafe/shared';
import {
  buildCueEnvelope,
  type MemoryCueResolver,
  type MemoryCueResolverContext,
  type MemoryCueSourceProjection,
} from '../MemoryCueResolverRegistry.js';

export interface CatOwnedSeedCueSource {
  resolve(input: {
    ownerUserId: string;
    consumerCatId: string;
    producingCatId: string;
    seedId: string;
    sourceRevision: string;
  }): Promise<MemoryCueSourceProjection | null>;
}

export class CatOwnedSeedCueResolver implements MemoryCueResolver {
  readonly family = 'cat_owned_seed' as const;
  readonly resolverVersion = 1;

  constructor(private readonly source: CatOwnedSeedCueSource) {}

  async resolve(opportunity: RecallOpportunityV1, context: MemoryCueResolverContext) {
    if (opportunity.kind !== 'owned_seed_available' || !context.consumerCatId) return [];
    const source = await this.source.resolve({
      ownerUserId: opportunity.scope.ownerUserId,
      consumerCatId: context.consumerCatId,
      producingCatId: opportunity.payload.producingCatId,
      seedId: opportunity.payload.seedId,
      sourceRevision: opportunity.payload.sourceRevision,
    });
    if (!source) return [];
    return [
      buildCueEnvelope({
        opportunity,
        family: this.family,
        resolverVersion: this.resolverVersion,
        whyNow: 'This producing cat has one revision-bound private seed during its scheduled Present Loop.',
        source,
        context,
      }),
    ];
  }
}
