import { isDeepStrictEqual } from 'node:util';
import type { GlobalArtifactDTO, MessageMediaItemSelector, ThreadArtifactDTO } from '@cat-cafe/shared';
import { aggregateThreadArtifacts } from '../../../cats/services/agents/routing/thread-artifacts-aggregator.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import {
  isDurableOwnerReadEvidence,
  passesManagedHoldViewerBoundary,
} from '../../../cats/services/stores/visibility.js';
import type { CompanionArtifactSource } from './companion-work-source.js';

/** Conversation aids and human attachments are not partner deliveries. */
export function isCompanionDeliveryPublication(
  artifact: ThreadArtifactDTO,
): artifact is ThreadArtifactDTO & { catId: string; publicationItem: MessageMediaItemSelector } {
  return (
    artifact.catId !== null &&
    artifact.publicationItem !== undefined &&
    ['image', 'video', 'file'].includes(artifact.type)
  );
}

export function companionMessagePublications(
  message: StoredMessage | null,
  ownerUserId: string,
  threadId: string,
): GlobalArtifactDTO[] {
  if (
    !message ||
    message.userId !== ownerUserId ||
    message.threadId !== threadId ||
    message.catId === null ||
    message.recall ||
    message.deletedAt ||
    message._tombstone ||
    !isDurableOwnerReadEvidence(message) ||
    !passesManagedHoldViewerBoundary(message, ownerUserId)
  )
    return [];
  return aggregateThreadArtifacts({ messages: [message], prTasks: [], fileLedger: [] })
    .filter(isCompanionDeliveryPublication)
    .map((artifact) => ({ ...artifact, threadId, threadTitle: threadId }));
}

/** Recheck the exact published item; a successful older catalogue read is not a visibility lease. */
export async function currentCompanionPublications(
  messages: Pick<IMessageStore, 'getById'>,
  ownerUserId: string,
  rows: CompanionArtifactSource['artifacts'],
) {
  const current = [];
  for (const row of rows) {
    if (!row.sourceMessageId || row.fileLedgerRef !== undefined || !isCompanionDeliveryPublication(row)) continue;
    const message = await messages.getById(row.sourceMessageId);
    const publications = companionMessagePublications(message, ownerUserId, row.threadId);
    if (
      publications.some(
        (item) =>
          item.sourceMessageId === row.sourceMessageId &&
          item.createdAt === row.createdAt &&
          item.type === row.type &&
          item.name === row.name &&
          item.url === row.url &&
          item.ref === row.ref &&
          isDeepStrictEqual(item.publicationItem, row.publicationItem),
      )
    )
      current.push(row);
  }
  return current;
}
