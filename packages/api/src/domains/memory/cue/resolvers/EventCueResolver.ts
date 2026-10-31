import type { RecallOpportunityV1 } from '@cat-cafe/shared';
import {
  buildCueEnvelope,
  type MemoryCueResolver,
  type MemoryCueResolverContext,
  type MemoryCueSourceProjection,
} from '../MemoryCueResolverRegistry.js';

export interface EventCueSource {
  resolve(input: {
    ownerUserId: string;
    threadId: string;
    eventId: string;
    subjectThreadId: string;
    sourceRevision: string;
  }): Promise<MemoryCueSourceProjection | null>;
}

export class EventCueResolver implements MemoryCueResolver {
  readonly family = 'event' as const;
  readonly resolverVersion = 1;

  constructor(private readonly source: EventCueSource) {}

  async resolve(opportunity: RecallOpportunityV1, context: MemoryCueResolverContext) {
    if (opportunity.kind !== 'recent_event_available') return [];
    const source = await this.source.resolve({
      ownerUserId: opportunity.scope.ownerUserId,
      threadId: opportunity.scope.threadId,
      eventId: opportunity.payload.eventId,
      subjectThreadId: opportunity.payload.subjectThreadId,
      sourceRevision: opportunity.payload.sourceRevision,
    });
    if (!source) return [];
    return [
      buildCueEnvelope({
        opportunity,
        family: this.family,
        resolverVersion: this.resolverVersion,
        whyNow: 'A high-confidence Event in this thread is still inside its bounded continuity window.',
        source,
        context,
      }),
    ];
  }
}
