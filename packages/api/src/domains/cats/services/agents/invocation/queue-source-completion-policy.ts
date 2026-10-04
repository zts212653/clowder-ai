import { isCrossThreadProvenance } from '@cat-cafe/shared';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';
import type { TurnExecutionRecord } from '../../stores/ports/TurnExecutionStore.js';

export function isDispatchSource(message: StoredMessage, catId: string): boolean {
  return Boolean(
    message.catId &&
      (message.catId !== catId ||
        isCrossThreadProvenance(message.extra?.crossPost?.sourceThreadId, message.threadId)) &&
      (message.mentions.some((target) => target === catId) ||
        message.extra?.targetCats?.includes(catId) ||
        message.queueCustody?.allTargetCats.some((target) => target === catId)),
  );
}

/** Source-owned read provenance survives a missing execution record; user messages retain source-response semantics. */
export function requiresDispatchDisposition(
  message: StoredMessage,
  catId: string,
  invocationId: string,
  execution: Pick<TurnExecutionRecord, 'queueCompletionPolicy'> | null | undefined,
): boolean {
  return (
    isDispatchSource(message, catId) &&
    (execution?.queueCompletionPolicy === 'explicit_source' ||
      message.queueCustody?.readEvidenceWitnesses?.some(
        (witness) => witness.targetCatId === catId && witness.invocationId === invocationId,
      ) === true)
  );
}
