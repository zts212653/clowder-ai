import type { RecallOpportunityV1 } from '@cat-cafe/shared';
import {
  buildCueEnvelope,
  type MemoryCueResolver,
  type MemoryCueResolverContext,
} from '../MemoryCueResolverRegistry.js';

export interface TasteDimensionMapSource {
  resolve(input: {
    ownerUserId: string;
    stage: 'quality_gate' | 'review';
    selectedSkill: 'writing-plans' | 'co-creation-docs' | 'fresh-context-review' | 'request-review';
    featureId: string;
  }): Promise<{
    dimensions: string[];
    revision: string;
    visibility?: 'owner_public' | 'owner_private';
  } | null>;
}

function normalizeDimensions(dimensions: readonly string[]): string[] {
  return [...new Set(dimensions.map((dimension) => dimension.trim()).filter(Boolean))].sort().slice(0, 6);
}

export class TasteCueResolver implements MemoryCueResolver {
  readonly family = 'taste' as const;
  readonly resolverVersion = 1;

  constructor(private readonly source: TasteDimensionMapSource) {}

  async resolve(opportunity: RecallOpportunityV1, context: MemoryCueResolverContext) {
    if (opportunity.kind !== 'judgment_surface_entered') return [];
    const result = await this.source.resolve({
      ownerUserId: opportunity.scope.ownerUserId,
      stage: opportunity.payload.stage,
      selectedSkill: opportunity.payload.selectedSkill,
      featureId: opportunity.payload.featureId,
    });
    if (!result) return [];
    const dimensions = normalizeDimensions(result.dimensions);
    if (dimensions.length === 0) return [];
    const dimensionList = dimensions.join(',');
    return [
      buildCueEnvelope({
        opportunity,
        family: this.family,
        resolverVersion: this.resolverVersion,
        whyNow: 'An explicit workflow-selected judgment surface is active.',
        source: {
          title: 'Relevant Taste dimensions are available',
          summary: `Relevant dimensions: ${dimensions.join(', ')}. Drill the map to choose evidence.`,
          anchor: `taste-dimensions:${dimensionList}`,
          revision: result.revision,
          visibility: result.visibility ?? 'owner_private',
          drillFamily: 'taste',
        },
        context,
      }),
    ];
  }
}
