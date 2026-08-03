import type { RecallOpportunityV1 } from '@cat-cafe/shared';
import type { MemoryCueResolver, MemoryCueResolverContext } from '../MemoryCueResolverRegistry.js';

export class ProjectKnowledgeCueResolver implements MemoryCueResolver {
  readonly family = 'project_knowledge' as const;
  readonly resolverVersion = 1;

  async resolve(_opportunity: RecallOpportunityV1, _context: MemoryCueResolverContext) {
    return [];
  }
}
