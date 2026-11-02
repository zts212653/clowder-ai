import type { RecallOpportunityV1 } from '@cat-cafe/shared';
import {
  buildCueEnvelope,
  type MemoryCueResolver,
  type MemoryCueResolverContext,
  type MemoryCueSourceProjection,
} from '../MemoryCueResolverRegistry.js';
import type { ContextProjectCueSource } from '../sources/ContextProjectCueSource.js';

export interface ProjectKnowledgeCueSource {
  resolve(input: { ownerUserId: string; featureId: string }): Promise<MemoryCueSourceProjection | null>;
}

export class ProjectKnowledgeCueResolver implements MemoryCueResolver {
  readonly family = 'project_knowledge' as const;
  readonly resolverVersion = 1;

  constructor(
    private readonly source: ProjectKnowledgeCueSource,
    private readonly contextSource?: ContextProjectCueSource,
    private readonly messages?: Pick<
      import('../../../cats/services/stores/ports/MessageStore.js').IMessageStore,
      'getById'
    >,
  ) {}

  async resolve(opportunity: RecallOpportunityV1, context: MemoryCueResolverContext) {
    if (opportunity.kind === 'fresh_context_sources' || opportunity.kind === 'authorized_task_sources') {
      const message = await this.messages?.getById(opportunity.payload.sourceMessageId);
      if (
        !this.contextSource ||
        !message ||
        message.userId !== opportunity.scope.ownerUserId ||
        message.threadId !== opportunity.scope.threadId ||
        message.deletedAt ||
        message._tombstone
      )
        return [];
      const result = await this.contextSource.discover({
        scope: opportunity.scope,
        query: message.content,
        signal: context.signal,
      });
      for (const reason of result.omissions ?? (result.omission ? [result.omission] : []))
        context.recordOmission?.(reason);
      return result.sources.map((source) =>
        buildCueEnvelope({
          opportunity,
          family: this.family,
          resolverVersion: this.resolverVersion,
          whyNow: 'A current project source can be read.',
          source,
          context,
        }),
      );
    }
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
