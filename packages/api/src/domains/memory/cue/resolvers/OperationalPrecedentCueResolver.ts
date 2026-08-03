import type { RecallOpportunityV1 } from '@cat-cafe/shared';
import {
  buildCueEnvelope,
  type MemoryCueResolver,
  type MemoryCueResolverContext,
  type MemoryCueSourceProjection,
} from '../MemoryCueResolverRegistry.js';

export interface OperationalPrecedentCueSource {
  resolve(input: {
    ownerUserId: string;
    repoFullName: string;
    prNumber: number;
    headSha: string;
    externalCondition: 'billing_spending_limit_zero_step';
    candidateAction: 'merge';
    sourceMessageId: string;
  }): Promise<MemoryCueSourceProjection | null>;
}

export class OperationalPrecedentCueResolver implements MemoryCueResolver {
  readonly family = 'operational_precedent' as const;
  readonly resolverVersion = 1;

  constructor(private readonly source: OperationalPrecedentCueSource) {}

  async resolve(opportunity: RecallOpportunityV1, context: MemoryCueResolverContext) {
    if (opportunity.kind !== 'delivery_decision') return [];
    const source = await this.source.resolve({
      ownerUserId: opportunity.scope.ownerUserId,
      repoFullName: opportunity.payload.repoFullName,
      prNumber: opportunity.payload.prNumber,
      headSha: opportunity.payload.headSha,
      externalCondition: opportunity.payload.externalCondition,
      candidateAction: opportunity.payload.candidateAction,
      sourceMessageId: opportunity.payload.sourceMessageId,
    });
    if (!source) return [];
    return [
      buildCueEnvelope({
        opportunity,
        family: this.family,
        resolverVersion: this.resolverVersion,
        whyNow: 'A merge decision has complete source evidence and an exact external billing condition.',
        source,
        context,
      }),
    ];
  }
}
