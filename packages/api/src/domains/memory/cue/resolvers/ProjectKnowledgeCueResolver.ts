import type { RecallOpportunityV1 } from '@cat-cafe/shared';
import {
  buildCueEnvelope,
  type MemoryCueResolver,
  type MemoryCueResolverContext,
  type MemoryCueSourceProjection,
} from '../MemoryCueResolverRegistry.js';

export interface ProjectKnowledgeCueSource {
  resolve(input: { ownerUserId: string; featureId: string }): Promise<MemoryCueSourceProjection | null>;
}

export class ProjectKnowledgeCueResolver implements MemoryCueResolver {
  readonly family = 'project_knowledge' as const;
  readonly resolverVersion = 1;

  constructor(private readonly source: ProjectKnowledgeCueSource) {}

  async resolve(opportunity: RecallOpportunityV1, context: MemoryCueResolverContext) {
    if (opportunity.kind !== 'project_source_required') return [];
    const source = await this.source.resolve({
      ownerUserId: opportunity.scope.ownerUserId,
      featureId: opportunity.payload.featureId,
    });
    if (!source) return [];
    return [
      buildCueEnvelope({
        opportunity,
        family: this.family,
        resolverVersion: this.resolverVersion,
        whyNow:
          'The current task is bound to this exact feature source; drill its revision for grounding without treating the F209 index as authority.',
        source,
        context,
      }),
    ];
  }
}
