import type { RecallOpportunityV1 } from '@cat-cafe/shared';
import {
  buildCueEnvelope,
  type MemoryCueResolver,
  type MemoryCueResolverContext,
  type MemoryCueSourceProjection,
} from '../MemoryCueResolverRegistry.js';

export interface PersonEntityCueSource {
  resolve(input: {
    ownerUserId: string;
    threadId: string;
    entityId: string;
    matchedAlias: string;
    sourceMessageId: string;
  }): Promise<MemoryCueSourceProjection | null>;
}

export class PersonEntityCueResolver implements MemoryCueResolver {
  readonly family = 'person_entity' as const;
  readonly resolverVersion = 1;

  constructor(private readonly source: PersonEntityCueSource) {}

  async resolve(opportunity: RecallOpportunityV1, context: MemoryCueResolverContext) {
    if (opportunity.kind !== 'subject_seen') return [];
    const source = await this.source.resolve({
      ownerUserId: opportunity.scope.ownerUserId,
      threadId: opportunity.scope.threadId,
      entityId: opportunity.payload.entityId,
      matchedAlias: opportunity.payload.matchedAlias,
      sourceMessageId: opportunity.payload.sourceMessageId,
    });
    if (!source) return [];
    return [
      buildCueEnvelope({
        opportunity,
        family: this.family,
        resolverVersion: this.resolverVersion,
        whyNow: 'An exact named subject is present in the current decision frame.',
        source,
        context,
      }),
    ];
  }
}
