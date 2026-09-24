import {
  createWaitContinuationCarrier,
  parseWaitContinuationCarrier,
  type WaitContinuationCarrierV1,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';

export class WaitContinuationCarrierError extends Error {
  readonly code = 'INVALID_WAIT_CONTINUATION_CARRIER';
}

export function waitContinuationCarrierFromStoredMessage(
  message: Pick<StoredMessage, 'source'> | null | undefined,
): WaitContinuationCarrierV1 | undefined {
  if (message?.source?.connector !== 'github-wait') return undefined;
  const carrier = parseWaitContinuationCarrier(message.source.meta?.waitContinuationCarrier);
  if (!carrier) throw new WaitContinuationCarrierError('github-wait message is missing a valid continuation carrier');
  return carrier;
}

export async function loadWaitContinuationCarrier(
  messageStore: Pick<IMessageStore, 'getById'> | undefined,
  messageId: string,
): Promise<WaitContinuationCarrierV1 | undefined> {
  if (!messageStore) return undefined;
  return waitContinuationCarrierFromStoredMessage(await messageStore.getById(messageId));
}

export function waitContinuationCarriersMatch(
  left: WaitContinuationCarrierV1 | undefined,
  right: WaitContinuationCarrierV1 | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (left.v !== right.v || left.waitId !== right.waitId || left.outcomeId !== right.outcomeId) return false;
  if (left.ownerFence.kind !== right.ownerFence.kind) return false;
  if (left.ownerFence.generation !== right.ownerFence.generation) return false;
  return (
    left.ownerFence.kind === 'containing_task' ||
    (right.ownerFence.kind === 'action_successor' && left.ownerFence.leaseId === right.ownerFence.leaseId)
  );
}

/**
 * Fail closed unless a frozen github-wait carrier still names the exact
 * canonical task outcome that is pending delivery to this owner.
 *
 * The connector Message is immutable transport evidence; the Task remains the
 * authority for whether that wait generation is current and deliverable.
 */
export async function assertCurrentWaitContinuationCarrier(
  taskStore: Pick<ITaskStore, 'get'> | undefined,
  carrier: WaitContinuationCarrierV1,
  scope: { threadId: string; userId: string; catId: string },
): Promise<void> {
  if (!taskStore) {
    throw new WaitContinuationCarrierError('github-wait admission requires the canonical task store');
  }
  const task = await taskStore.get(carrier.waitId);
  const outcome = task?.automationState?.waitOutcome;
  const currentCarrier = outcome ? createWaitContinuationCarrier(carrier.waitId, outcome) : undefined;
  if (
    !task ||
    (task.kind !== 'pr_tracking' && task.kind !== 'issue_tracking') ||
    task.threadId !== scope.threadId ||
    task.userId !== scope.userId ||
    task.ownerCatId !== scope.catId ||
    outcome?.delivery !== 'pending' ||
    outcome.generation !== carrier.ownerFence.generation ||
    !waitContinuationCarriersMatch(carrier, currentCarrier)
  ) {
    throw new WaitContinuationCarrierError('github-wait continuation is stale or outside its owner scope');
  }
}
