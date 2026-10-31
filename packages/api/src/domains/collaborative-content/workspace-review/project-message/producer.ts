import {
  deriveGrowingSourceMessageRevision,
  type StoredMessage,
} from '../../../cats/services/stores/ports/MessageStore.js';
import { projectMessageAttachments, type VideoProjectMessageImporter } from './import.js';
import { isDeliveredProjectHuman } from './visibility.js';

/** The actual Chat writer calls this after persistence; recovery also consumes the same durable MessageStore. */
export function createProjectMessageProducer(deps: {
  importer: VideoProjectMessageImporter;
  changed: (ownerUserId: string, reviewId: string) => void;
}) {
  return async (message: StoredMessage) => {
    if (!isDeliveredProjectHuman(message, message.userId)) return;
    const principal = { userId: message.userId, actor: { kind: 'human' as const, actorId: message.userId } };
    for (const attachment of projectMessageAttachments(message))
      for (const selection of attachment.selections) {
        const result = await deps.importer.import({
          principal,
          contentRef: attachment.contentRef,
          threadId: message.threadId,
          messageId: message.id,
          messageRevision: deriveGrowingSourceMessageRevision(message),
          attachmentId: attachment.id,
          selectionId: selection.id,
        });
        if (!result.replayed) deps.changed(message.userId, result.review.reviewId);
      }
  };
}
