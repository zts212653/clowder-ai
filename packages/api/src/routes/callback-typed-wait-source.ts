import type { ManagedHoldDispositionService } from '../domains/ball-custody/ManagedHoldDispositionService.js';
import type { TypedWaitSource } from '../domains/ball-custody/TypedWaitRegistration.js';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { isOwnerVisibleManagedHoldConnector } from '../domains/cats/services/stores/visibility.js';

/** Start at callback entry: describe() snapshots adopted sources synchronously before its first await. */
export async function captureTypedWaitSource(
  auth: InvocationRecord,
  deps: {
    readonly messageStore: Pick<IMessageStore, 'getById'>;
    readonly managedHoldDispositionService?: Partial<Pick<ManagedHoldDispositionService, 'describe'>>;
  },
): Promise<TypedWaitSource | undefined> {
  try {
    const selectionPromise = deps.managedHoldDispositionService?.describe?.(auth);
    const selection = await selectionPromise;
    if (selection?.state === 'ambiguous_multiple_pending') return undefined;
    const selected = selection?.state === 'single_canonical_pending' ? selection.candidates[0] : undefined;
    if (selected) {
      const source = await deps.messageStore.getById(selected.sourceMessageId);
      if (
        !source ||
        !isOwnerVisibleManagedHoldConnector(source, auth.userId) ||
        source.source?.meta?.catId !== auth.catId ||
        source.source.meta.taskId !== selected.taskId
      )
        return undefined;
      return {
        kind: selected.sourceMessageId === auth.originTriggerMessageId ? 'primary' : 'adopted_hold',
        sourceMessageId: selected.sourceMessageId,
        holdTaskId: selected.taskId,
      };
    }
    if (!auth.originTriggerMessageId) return undefined;
    const origin = await deps.messageStore.getById(auth.originTriggerMessageId);
    if (
      !origin ||
      origin.threadId !== auth.threadId ||
      origin.userId !== auth.userId ||
      origin.source?.connector === 'hold-ball' ||
      origin.deletedAt !== undefined ||
      origin._tombstone
    )
      return undefined;
    return { kind: 'primary', sourceMessageId: origin.id };
  } catch {
    // Registration remains useful without authority to consume an unresolved source.
    return undefined;
  }
}
