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

export interface PersonEntityRevisionSource {
  isCurrentVisibleRevision(entityId: string, expectedRevision: string, viewerUserId: string): boolean;
}

export class PersonEntityCueResolver implements MemoryCueResolver {
  readonly family = 'person_entity' as const;
  readonly resolverVersion = 1;

  constructor(
    private readonly source: PersonEntityCueSource,
    private readonly entityRevisions: PersonEntityRevisionSource,
  ) {}

  async resolve(opportunity: RecallOpportunityV1, context: MemoryCueResolverContext) {
    if (opportunity.kind !== 'subject_seen') return [];
    const isCurrent = () =>
      this.entityRevisions.isCurrentVisibleRevision(
        opportunity.payload.entityId,
        opportunity.payload.sourceRevision,
        opportunity.scope.ownerUserId,
      );
    if (!isCurrent()) return [];
    const source = await this.source.resolve({
      ownerUserId: opportunity.scope.ownerUserId,
      threadId: opportunity.scope.threadId,
      entityId: opportunity.payload.entityId,
      matchedAlias: opportunity.payload.matchedAlias,
      sourceMessageId: opportunity.payload.sourceMessageId,
    });
    if (!source) return [];
    // Recheck after the owner-private read so an Entity mutation racing that
    // async boundary cannot emit a cue from a stale identity projection.
    if (!isCurrent()) return [];
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
