import type { IMessageStore, StoredMessage } from '../../../../cats/services/stores/ports/MessageStore.js';
import type { LiveContextScope } from '../live-controlled-context.js';

export type OwnerCurrentnessStore = Pick<IMessageStore, 'getById' | 'getByThread' | 'getByThreadAfter'>;
const MESSAGE_WINDOW = 256;

/** Past history is not uncertainty; only a full after-source page is indeterminate. */
export async function isLatestOwnerMessage(
  messages: OwnerCurrentnessStore,
  scope: LiveContextScope,
  source: StoredMessage,
  utteranceMessageIds: readonly string[] = [source.id],
): Promise<boolean> {
  if (!Number.isSafeInteger(source.timestamp) || source.timestamp < 0 || source.timestamp > Date.now()) return false;
  const owner = (message: StoredMessage) => message.userId === scope.userId && message.catId === null;
  const recent = await messages.getByThread(scope.threadId, MESSAGE_WINDOW, scope.userId);
  const current = recent.filter(owner).at(-1);
  if (!current || !utteranceMessageIds.includes(current.id)) return false;
  // Backdated delivered corrections still appear after the source in monotonic
  // visibility order. An unresolved cursor or a full page cannot prove absence.
  const later = await messages.getByThreadAfter(scope.threadId, source.id, MESSAGE_WINDOW, scope.userId);
  if (
    later.length >= MESSAGE_WINDOW ||
    later.some((message) => message.id === source.id || (owner(message) && !utteranceMessageIds.includes(message.id)))
  )
    return false;
  // Queued/recalled owner inputs have no visibility position and may be backdated.
  // Filter before limiting, so old history cannot hide them. No body is injected.
  const uncertain = await messages.getByThread(scope.threadId, 1, scope.userId, {
    includeQueuedUserMessages: true,
    includeRecalledUserMessages: true,
    onlyUnpositionedOwnerMessages: true,
    ownerUncertaintySinceMs: source.timestamp,
  });
  return uncertain.length === 0;
}
