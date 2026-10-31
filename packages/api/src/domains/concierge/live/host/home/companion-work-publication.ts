import { isDeepStrictEqual } from 'node:util';
import type { CompanionWorkDestination } from '../../work/companion-work-navigation.js';
import { readCompanionWorkDestination } from '../../work/companion-work-navigation.js';
import { companionMessagePublications } from '../../work/companion-work-publications.js';
import type { HomeWorkPublication } from './home-hub-delivery.js';

/** Reuses the C owner read at consume time; no selectors or new publication state come from the renderer. */
export async function resolveCompanionWorkPublication(
  options: Parameters<typeof readCompanionWorkDestination>[0],
  original: CompanionWorkDestination,
): Promise<HomeWorkPublication | null> {
  if (!original.messageId || !original.item) return null;
  const destination = await readCompanionWorkDestination(options, {
    kind: 'publication',
    threadId: original.threadId,
    messageId: original.messageId,
    item: original.item,
  });
  if (!destination || !isDeepStrictEqual(original.artifact, destination.artifact)) return null;
  const message = await options.messages.getById(original.messageId);
  const publication = companionMessagePublications(message, options.ownerUserId, original.threadId).find((item) =>
    isDeepStrictEqual(item.publicationItem, original.item),
  );
  await options.assertCurrent();
  if (!message || !publication?.url) return null;
  return {
    source: {
      kind: 'message',
      threadId: original.threadId,
      messageId: original.messageId,
      messageRevision: String(message.timestamp),
      item: original.item,
      expectedUrl: publication.url,
    },
    ...(destination.artifact ? { artifact: destination.artifact } : {}),
  };
}
