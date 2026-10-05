import { createHash } from 'node:crypto';
import { createCatId, type MessageMediaPublicationSource, messageMediaItemKey } from '@cat-cafe/shared';
import { aggregateThreadArtifacts } from '../../cats/services/agents/routing/thread-artifacts-aggregator.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { isDurableOwnerReadEvidence, resolveVisibleReplyParent } from '../../cats/services/stores/visibility.js';
import { MediaOwnerError } from './media-errors.js';
import type { MediaReviewPrincipal } from './published-media-access.js';

function messageItemUrl(message: StoredMessage, source: MessageMediaPublicationSource): string | undefined {
  const selector = source.item;
  if (selector.kind === 'content-block') {
    const item = message.contentBlocks?.[selector.index];
    return item?.type === 'image' || item?.type === 'file' ? item.url : undefined;
  }
  const matches = message.extra?.rich?.blocks?.filter((block) => block.id === selector.blockId) ?? [];
  if (matches.length !== 1) throw new MediaOwnerError('publication_changed');
  const block = matches[0];
  if (selector.kind === 'media-gallery' && block?.kind === 'media_gallery') return block.items[selector.itemIndex]?.url;
  if (selector.kind === 'rich-file' && block?.kind === 'file') return block.url;
  return undefined;
}

/** Resolve an exact published item; no Task or artifact-title matching participates. */
export async function readPublishedMessageItem(
  messages: Pick<IMessageStore, 'getById'>,
  source: MessageMediaPublicationSource,
  principal: MediaReviewPrincipal,
) {
  const message = await resolveVisibleReplyParent(messages, source.messageId, {
    threadId: source.threadId,
    viewer:
      principal.actor.kind === 'human'
        ? { type: 'user' }
        : { type: 'cat', catId: createCatId(principal.actor.actorId) },
  });
  if (
    !message ||
    message.userId !== principal.userId ||
    message.recall ||
    message._tombstone ||
    message.deliveryStatus === 'queued' ||
    !isDurableOwnerReadEvidence(message)
  )
    throw new MediaOwnerError('access_denied');
  const url = messageItemUrl(message, source);
  if (!url || url !== source.expectedUrl || String(message.timestamp) !== source.messageRevision)
    throw new MediaOwnerError('publication_changed');
  const file = /^\/uploads\/([a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|mp4))$/i.exec(url);
  if (!file?.[1] || !file[2]) throw new MediaOwnerError('invalid_media');
  const mediaType = file[2].toLowerCase() === 'png' ? ('image/png' as const) : ('video/mp4' as const);
  return {
    matchingItemCount: aggregateThreadArtifacts({ messages: [message], prTasks: [], fileLedger: [] }).filter(
      (artifact) => artifact.url === url,
    ).length,
    fileName: file[1],
    publisherCatId: message.catId,
    mediaType,
    publication: {
      artifactRef: url,
      sourceRef: `message:${source.threadId}:${source.messageId}`,
      revision: `sha256:${createHash('sha256')
        .update(JSON.stringify([source.messageRevision, messageMediaItemKey(source.item), url, mediaType]))
        .digest('hex')}`,
    },
  };
}
