import type { TypedWaitSource } from '../domains/ball-custody/TypedWaitRegistration.js';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { isOwnerVisibleManagedHoldConnector } from '../domains/cats/services/stores/visibility.js';

/**
 * Snapshot the exact lifecycle inputs at callback entry. Later queue adoption
 * must not retrospectively grant a wait registration authority over a source
 * that was not part of this callback's initial view.
 */
export async function captureTypedWaitSource(
  auth: InvocationRecord,
  deps: {
    readonly messageStore: Pick<IMessageStore, 'getById'>;
    readonly invocationTracker?: Pick<InvocationTracker, 'getActiveSlots'>;
  },
): Promise<TypedWaitSource | undefined> {
  const activeRun = deps.invocationTracker
    ?.getActiveSlots(auth.threadId)
    .find((slot) => slot.catId === auth.catId && slot.activeRun?.invocationId === auth.invocationId)?.activeRun;
  const inputMessageIds = activeRun ? [...activeRun.inputMessageIds] : [];

  try {
    const managedHoldSources: Extract<TypedWaitSource, { holdTaskId?: string }>[] = [];
    for (const sourceMessageId of inputMessageIds) {
      const source = await deps.messageStore.getById(sourceMessageId);
      const taskId = source?.source?.meta?.taskId;
      if (
        !source ||
        !isOwnerVisibleManagedHoldConnector(source, auth.userId) ||
        source.source?.meta?.catId !== auth.catId ||
        typeof taskId !== 'string' ||
        taskId.length === 0
      ) {
        continue;
      }
      managedHoldSources.push({
        kind: sourceMessageId === auth.originTriggerMessageId ? 'primary' : 'adopted_hold',
        sourceMessageId,
        holdTaskId: taskId,
      });
    }
    if (managedHoldSources.length > 1) return undefined;
    if (managedHoldSources[0]) return managedHoldSources[0];

    if (!auth.originTriggerMessageId || !inputMessageIds.includes(auth.originTriggerMessageId)) return undefined;
    const origin = await deps.messageStore.getById(auth.originTriggerMessageId);
    if (
      !origin ||
      origin.threadId !== auth.threadId ||
      origin.userId !== auth.userId ||
      origin.source?.connector === 'hold-ball' ||
      origin.deletedAt !== undefined ||
      origin._tombstone
    ) {
      return undefined;
    }
    return { kind: 'primary', sourceMessageId: origin.id };
  } catch {
    // The public tracking task remains useful without private continuation authority.
    return undefined;
  }
}
