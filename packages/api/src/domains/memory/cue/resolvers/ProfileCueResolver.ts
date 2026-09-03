import type { RecallOpportunityV1 } from '@cat-cafe/shared';
import {
  buildCueEnvelope,
  type MemoryCueResolver,
  type MemoryCueResolverContext,
  type MemoryCueSourceProjection,
} from '../MemoryCueResolverRegistry.js';

export interface ProfileCueSource {
  resolve(input: {
    ownerUserId: string;
    profileUri: 'cat-cafe-profile://relationship/current';
    sourceRevision: string;
  }): Promise<MemoryCueSourceProjection | null>;
}

export class ProfileCueResolver implements MemoryCueResolver {
  readonly family = 'profile' as const;
  readonly resolverVersion = 2;

  constructor(private readonly source?: ProfileCueSource) {}

  async resolve(opportunity: RecallOpportunityV1, context: MemoryCueResolverContext) {
    if (opportunity.kind !== 'profile_revision_available' || !this.source) return [];
    const source = await this.source.resolve({
      ownerUserId: opportunity.scope.ownerUserId,
      profileUri: opportunity.payload.profileUri,
      sourceRevision: opportunity.payload.sourceRevision,
    });
    if (!source) return [];
    return [
      buildCueEnvelope({
        opportunity,
        family: this.family,
        resolverVersion: this.resolverVersion,
        whyNow: 'A canonical owner Profile revision has no applied or dismissed receipt yet.',
        source,
        context,
      }),
    ];
  }
}
