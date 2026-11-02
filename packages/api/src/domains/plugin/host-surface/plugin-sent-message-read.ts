import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { MessagingError } from '../../messaging/contract/host-types.js';

/** An original durable Message and its admitted Queue recipients. Not execution completion. */
export interface PluginSentMessage {
  readonly messageId: string;
  readonly threadId: string;
  readonly content: string;
  readonly routedCatIds: readonly string[];
  readonly deliveryStatus?: 'queued' | 'delivered' | 'canceled';
}
export interface PluginSentMessageLookup {
  readonly threadId: string;
  readonly idempotencyKey: string;
}
export function pluginSentMessageStorageKey(pluginInstanceId: string, idempotencyKey: string): string {
  return `plugmsg:${encodeURIComponent(pluginInstanceId)}:${encodeURIComponent(idempotencyKey)}`;
}
export interface PluginSentMessageReadServices {
  readonly readMessageTargets?: (threadId: string, messageId: string) => Promise<readonly string[]>;
}

/** Read the permanent Message index, not the expiring transport settlement ledger. */
export function createPluginSentMessageReader(
  deps: PluginSentMessageReadServices & {
    readonly pluginInstanceId: string;
    readonly ownerUserId: string;
    readonly messageStore?: Pick<IMessageStore, 'getById'> & Partial<Pick<IMessageStore, 'getByIdempotencyKey'>>;
    readonly threadStore: Pick<IThreadStore, 'get'>;
    readonly assertCurrent?: () => void;
  },
): (input: PluginSentMessageLookup) => Promise<PluginSentMessage | null> {
  return async (input) => {
    deps.assertCurrent?.();
    if (
      !input ||
      Object.keys(input).some((key) => !['threadId', 'idempotencyKey'].includes(key)) ||
      ![input.threadId, input.idempotencyKey].every(
        (value) => typeof value === 'string' && value.length > 0 && value.length <= 500 && value.trim() === value,
      )
    )
      throw new MessagingError('VALIDATION', 'A thread and original idempotency key are required');
    const { threadId, idempotencyKey } = input;
    const thread = await deps.threadStore.get(threadId);
    deps.assertCurrent?.();
    if (!thread || thread.deletedAt) return null;
    if (!deps.messageStore?.getByIdempotencyKey || !deps.readMessageTargets)
      throw new MessagingError('PERMISSION', 'Durable Host delivery lookup is unavailable');
    const key = pluginSentMessageStorageKey(deps.pluginInstanceId, idempotencyKey);
    const original = await deps.messageStore.getByIdempotencyKey(deps.ownerUserId, threadId, key);
    deps.assertCurrent?.();
    if (!original) return null;
    const queueTargets = await deps.readMessageTargets(threadId, original.id);
    deps.assertCurrent?.();
    // Adoption commits the History dispatch before removing the Queue target.
    // Refresh History after reading Queue, so that handoff cannot erase both
    // pieces of recipient evidence or leave the returned delivery state stale.
    const message = await deps.messageStore.getByIdempotencyKey(deps.ownerUserId, threadId, key);
    deps.assertCurrent?.();
    if (
      !message ||
      message.id !== original.id ||
      message.threadId !== threadId ||
      message.userId !== deps.ownerUserId ||
      message.deletedAt ||
      message._tombstone ||
      message.recall ||
      message.from?.kind !== 'plugin' ||
      message.from.instanceId !== deps.pluginInstanceId
    )
      return null;
    const routedCatIds = [
      ...new Set([...queueTargets, ...(message.lifecycle?.dispatchRefs?.map((ref) => ref.targetId) ?? [])]),
    ];
    deps.assertCurrent?.();
    return Object.freeze({
      messageId: message.id,
      threadId,
      content: message.content,
      routedCatIds: Object.freeze(routedCatIds),
      ...(message.deliveryStatus ? { deliveryStatus: message.deliveryStatus } : {}),
    });
  };
}
