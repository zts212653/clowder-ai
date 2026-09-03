import { createHash } from 'node:crypto';
import type { StoredEventMemory } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import { isDelivered } from '../../../cats/services/stores/ports/MessageStore.js';
import type { IEventMemoryStore } from '../../EventMemoryStore.js';
import type { MemoryCueEpisodeStore } from '../MemoryCueEpisodeStore.js';
import type { MemoryCueOpportunitySeed } from '../MemoryCueInvocationPromptService.js';
import type { MemoryCueSourceProjection } from '../MemoryCueResolverRegistry.js';
import type { EventCueSource } from '../resolvers/EventCueResolver.js';

const EVENT_MEMORY_ANCHOR_PREFIX = 'event-memory:';
export const EVENT_CUE_WINDOW_MS = 15 * 60_000;

function revisionOf(event: StoredEventMemory): string {
  const revisionTuple = [
    event.eventId,
    event.ownerUserId,
    event.type,
    event.trigger,
    event.cat,
    event.threadId,
    event.messageId,
    event.timestamp,
    event.summary,
    event.cognitiveTransition,
    event.relatedHarness,
    event.confidence,
  ];
  return `sha256:${createHash('sha256').update(JSON.stringify(revisionTuple)).digest('hex')}`;
}

function sourceVisibilityFailure(
  message: Awaited<ReturnType<IMessageStore['getById']>>,
  event: StoredEventMemory,
): 'source_forgotten' | 'scope_revoked' | null {
  if (!message || message.deletedAt !== undefined || message._tombstone || message.recall) return 'source_forgotten';
  if (
    message.userId !== event.ownerUserId ||
    message.threadId !== event.threadId ||
    message.catId !== null ||
    message.source !== undefined ||
    message.visibility === 'whisper' ||
    !isDelivered(message)
  ) {
    return 'scope_revoked';
  }
  return null;
}

export type EventMemoryCueReadResult =
  | { status: 'ok'; payload: unknown }
  | {
      status: 'not_available';
      invalidationReason: 'source_corrected' | 'source_forgotten' | 'scope_revoked' | 'expired';
    };

export class EventMemoryCueSource implements EventCueSource {
  constructor(
    private readonly deps: {
      ownerUserId: string;
      eventStore: Pick<IEventMemoryStore, 'listEvents' | 'getEvent'>;
      messageStore: Pick<IMessageStore, 'getById'>;
      episodeStore: Pick<MemoryCueEpisodeStore, 'hasTerminalConsumptionForSource'>;
      now?: () => number;
    },
  ) {}

  async prepareOpportunity(input: {
    ownerUserId: string;
    threadId: string;
    occurredAt: number;
  }): Promise<Extract<MemoryCueOpportunitySeed, { kind: 'recent_event_available' }> | null> {
    if (input.ownerUserId !== this.deps.ownerUserId) return null;
    const candidate = this.deps.eventStore.listEvents({
      ownerUserId: input.ownerUserId,
      threadId: input.threadId,
      confidence: 'high',
      since: input.occurredAt - EVENT_CUE_WINDOW_MS,
      until: input.occurredAt,
      limit: 1,
    })[0];
    if (!candidate || (await this.visibilityFailure(candidate))) return null;
    const revision = revisionOf(candidate);
    const anchor = `${EVENT_MEMORY_ANCHOR_PREFIX}${candidate.eventId}`;
    if (
      this.deps.episodeStore.hasTerminalConsumptionForSource({
        ownerUserId: input.ownerUserId,
        resolverFamily: 'event',
        sourceAnchor: anchor,
        sourceRevision: revision,
      })
    ) {
      return null;
    }
    return {
      kind: 'recent_event_available',
      producer: 'event_memory',
      occurredAt: input.occurredAt,
      payload: {
        eventId: candidate.eventId,
        subjectThreadId: candidate.threadId,
        sourceRevision: revision,
      },
    };
  }

  async resolve(input: {
    ownerUserId: string;
    threadId: string;
    eventId: string;
    subjectThreadId: string;
    sourceRevision: string;
  }): Promise<MemoryCueSourceProjection | null> {
    if (input.ownerUserId !== this.deps.ownerUserId || input.subjectThreadId !== input.threadId) return null;
    const snapshot = await this.currentEvent(input.eventId, input.ownerUserId, input.threadId);
    if (!snapshot || revisionOf(snapshot) !== input.sourceRevision || this.isExpired(snapshot)) return null;
    return {
      title: 'A recent event can establish continuity',
      summary: 'Drill the bounded Event record before using it to establish chronology or continuity in this thread.',
      anchor: `${EVENT_MEMORY_ANCHOR_PREFIX}${snapshot.eventId}`,
      revision: input.sourceRevision,
      asOf: snapshot.timestamp,
      visibility: 'owner_private',
      drillFamily: 'event',
    };
  }

  async read(input: {
    ownerUserId: string;
    threadId: string;
    anchor: string;
    expectedRevision: string;
  }): Promise<EventMemoryCueReadResult> {
    if (input.ownerUserId !== this.deps.ownerUserId) {
      return { status: 'not_available', invalidationReason: 'scope_revoked' };
    }
    if (!input.anchor.startsWith(EVENT_MEMORY_ANCHOR_PREFIX)) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    const eventId = input.anchor.slice(EVENT_MEMORY_ANCHOR_PREFIX.length);
    const event = this.deps.eventStore.getEvent(eventId);
    if (!event) return { status: 'not_available', invalidationReason: 'source_forgotten' };
    if (event.ownerUserId !== input.ownerUserId || event.threadId !== input.threadId) {
      return { status: 'not_available', invalidationReason: 'scope_revoked' };
    }
    if (revisionOf(event) !== input.expectedRevision) {
      return { status: 'not_available', invalidationReason: 'source_corrected' };
    }
    const visibilityFailure = await this.visibilityFailure(event);
    if (visibilityFailure) return { status: 'not_available', invalidationReason: visibilityFailure };
    if (this.isExpired(event)) return { status: 'not_available', invalidationReason: 'expired' };
    return {
      status: 'ok',
      payload: {
        eventId: event.eventId,
        type: event.type,
        trigger: event.trigger,
        cat: event.cat,
        timestamp: event.timestamp,
        summary: event.summary,
        cognitiveTransition: event.cognitiveTransition,
        relatedHarness: event.relatedHarness,
        confidence: event.confidence,
        source: { threadId: event.threadId, messageId: event.messageId },
        sourceRevision: input.expectedRevision,
      },
    };
  }

  private async currentEvent(
    eventId: string,
    ownerUserId: string,
    threadId: string,
  ): Promise<StoredEventMemory | null> {
    const event = this.deps.eventStore.getEvent(eventId);
    if (!event || event.ownerUserId !== ownerUserId || event.threadId !== threadId) return null;
    return (await this.visibilityFailure(event)) ? null : event;
  }

  private async visibilityFailure(event: StoredEventMemory) {
    const message = await Promise.resolve(this.deps.messageStore.getById(event.messageId));
    return sourceVisibilityFailure(message, event);
  }

  private isExpired(event: StoredEventMemory): boolean {
    return (this.deps.now?.() ?? Date.now()) > event.timestamp + EVENT_CUE_WINDOW_MS;
  }
}
