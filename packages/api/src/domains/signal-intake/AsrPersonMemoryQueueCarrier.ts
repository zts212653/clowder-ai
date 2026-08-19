import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { BoundAsrPersonMemoryScene } from '../memory/people/AsrPersonMemoryOpportunityPromptService.js';

/**
 * Bind server-written ASR scenes to the exact persisted Queue message that carried them.
 * The carrier is data-only; this check grants neither transcript truth nor person-memory authority.
 */
export function bindAsrPersonMemoryScenesFromQueueMessage(
  message: StoredMessage,
  scope: { readonly ownerUserId: string; readonly threadId: string },
): readonly BoundAsrPersonMemoryScene[] {
  if (
    message.userId !== scope.ownerUserId ||
    message.threadId !== scope.threadId ||
    message.catId !== null ||
    message.deletedAt !== undefined ||
    message._tombstone ||
    message.extra?.meetingArtifact?.trust !== 'untrusted_external' ||
    message.extra.meetingArtifact.instructionPolicy !== 'data_only'
  ) {
    return [];
  }
  return (message.extra.dynamicSceneEntries ?? []).map((scene) => ({
    scene,
    source: {
      kind: 'message',
      threadId: message.threadId,
      sourceMessageId: message.id,
      authorUserId: message.userId,
      authorRole: 'owner',
      visibility: 'verified_live_owner_message',
    },
  }));
}
