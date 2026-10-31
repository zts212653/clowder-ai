import type { RecallOpportunityV1 } from '@cat-cafe/shared';
import {
  buildCueEnvelope,
  type MemoryCueResolver,
  type MemoryCueResolverContext,
  type MemoryCueSourceProjection,
} from '../MemoryCueResolverRegistry.js';

export interface DecisionCueSource {
  resolve(input: { ownerUserId: string; decisionAnchor: string }): Promise<MemoryCueSourceProjection | null>;
}

export class DecisionCueResolver implements MemoryCueResolver {
  readonly family = 'decision' as const;
  readonly resolverVersion = 1;

  constructor(private readonly source: DecisionCueSource) {}

  async resolve(opportunity: RecallOpportunityV1, context: MemoryCueResolverContext) {
    if (opportunity.kind !== 'accepted_decision_required') return [];
    const source = await this.source.resolve({
      ownerUserId: opportunity.scope.ownerUserId,
      decisionAnchor: opportunity.payload.decisionAnchor,
    });
    if (!source) return [];
    return [
      buildCueEnvelope({
        opportunity,
        family: this.family,
        resolverVersion: this.resolverVersion,
        whyNow:
          'The current owner task names one accepted decision; drill its exact revision before relying on it, and keep authority with the decision record.',
        source,
        context,
      }),
    ];
  }
}
