import { createHash } from 'node:crypto';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { PersonMemoryRecallService } from '../../people/PersonMemoryRecallService.js';
import type { MemoryCueSourceProjection } from '../MemoryCueResolverRegistry.js';
import type { PersonEntityCueSource } from '../resolvers/PersonEntityCueResolver.js';

const PERSON_MEMORY_ANCHOR_PREFIX = 'person-memory:';

function revisionOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export type PersonMemoryCueReadResult =
  | { status: 'ok'; payload: unknown }
  | { status: 'not_available'; invalidationReason: 'source_corrected' | 'source_forgotten' };

/** Read-only projection over F276 canonical person memory. */
export class PersonMemoryCueSource implements PersonEntityCueSource {
  constructor(
    private readonly deps: {
      recall: PersonMemoryRecallService;
      messageStore: Pick<IMessageStore, 'getById'>;
    },
  ) {}

  async resolve(input: {
    ownerUserId: string;
    threadId: string;
    entityId: string;
    matchedAlias: string;
    sourceMessageId: string;
  }): Promise<MemoryCueSourceProjection | null> {
    if (!input.entityId.startsWith('person:')) return null;
    const sourceMessage = await Promise.resolve(this.deps.messageStore.getById(input.sourceMessageId));
    if (
      !sourceMessage ||
      sourceMessage.userId !== input.ownerUserId ||
      sourceMessage.threadId !== input.threadId ||
      sourceMessage.catId !== null ||
      sourceMessage.deletedAt !== undefined ||
      sourceMessage._tombstone
    ) {
      return null;
    }
    const recalled = await this.deps.recall.recallByWorkspaceEntityRef(input.ownerUserId, input.entityId);
    if (recalled.status !== 'resolved') return null;
    return {
      title: recalled.card.displayName,
      summary: `Relationship memory is available (${recalled.card.facts.length} bounded fact${
        recalled.card.facts.length === 1 ? '' : 's'
      }).`,
      anchor: `${PERSON_MEMORY_ANCHOR_PREFIX}${recalled.card.personId}`,
      revision: revisionOf(recalled.card),
      visibility: 'owner_private',
      drillFamily: 'person_memory',
    };
  }

  async read(input: {
    ownerUserId: string;
    anchor: string;
    expectedRevision: string;
  }): Promise<PersonMemoryCueReadResult> {
    if (!input.anchor.startsWith(PERSON_MEMORY_ANCHOR_PREFIX)) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    const personId = input.anchor.slice(PERSON_MEMORY_ANCHOR_PREFIX.length);
    const recalled = await this.deps.recall.recallByPersonId(input.ownerUserId, personId).catch(() => null);
    if (!recalled || recalled.status !== 'resolved') {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    if (revisionOf(recalled.card) !== input.expectedRevision) {
      return { status: 'not_available', invalidationReason: 'source_corrected' };
    }
    return { status: 'ok', payload: recalled.card };
  }
}
