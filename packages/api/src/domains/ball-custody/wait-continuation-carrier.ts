import { parseWaitContinuationCarrier, type WaitContinuationCarrierV1 } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';

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
