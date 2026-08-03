import type { RecallOpportunityV1 } from '@cat-cafe/shared';
import type { MemoryCueResolver, MemoryCueResolverContext } from '../MemoryCueResolverRegistry.js';

export class ProfileCueResolver implements MemoryCueResolver {
  readonly family = 'profile' as const;
  readonly resolverVersion = 1;

  async resolve(_opportunity: RecallOpportunityV1, _context: MemoryCueResolverContext) {
    return [];
  }
}
