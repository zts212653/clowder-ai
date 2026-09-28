import type { ITaskStore } from '../cats/services/stores/ports/TaskStoreContract.js';
import {
  isLiveTypedWaitRegistration,
  type TypedWaitContinuationIdentity,
  type TypedWaitReference,
} from './TypedWaitRegistration.js';

type Resolution =
  | { readonly kind: 'bypass'; readonly reference: TypedWaitReference }
  | {
      readonly kind: 'reject';
      readonly reason: 'state_source_unavailable' | 'missing_identity' | 'no_candidate' | 'query_failed';
    };

/** A fresh exact-source lookup; old trackers and other invocations grant no authority. */
export async function resolveTypedWaitContinuation(input: {
  readonly taskStore?: Pick<ITaskStore, 'listByThread' | 'getWaitRegistration'>;
  readonly invocationId?: string;
  readonly userId: string;
  readonly catId: string;
  readonly threadId: string;
  readonly sourceMessageId?: string;
  readonly holdTaskId?: string;
  readonly now?: number;
}): Promise<Resolution> {
  if (!input.taskStore?.getWaitRegistration) return { kind: 'reject', reason: 'state_source_unavailable' };
  if (!input.invocationId || !input.sourceMessageId) return { kind: 'reject', reason: 'missing_identity' };
  const identity: TypedWaitContinuationIdentity = {
    ...input,
    invocationId: input.invocationId,
    sourceMessageId: input.sourceMessageId,
  };
  try {
    const tasks = await input.taskStore.listByThread(input.threadId);
    for (const task of tasks) {
      if (task.kind !== 'pr_tracking' && task.kind !== 'issue_tracking') continue;
      if (
        task.ownerCatId !== input.catId ||
        task.userId !== input.userId ||
        task.status === 'done' ||
        !task.automationState?.await
      )
        continue;
      const snapshot = await input.taskStore.getWaitRegistration(task.id);
      if (isLiveTypedWaitRegistration(snapshot, identity, input.now ?? Date.now()) && snapshot?.receipt) {
        return { kind: 'bypass', reference: { taskId: task.id, generation: snapshot.receipt.generation } };
      }
    }
    return { kind: 'reject', reason: 'no_candidate' };
  } catch {
    return { kind: 'reject', reason: 'query_failed' };
  }
}
