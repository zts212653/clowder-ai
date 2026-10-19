import type { QueueLedgerEntry } from '../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { queueEntryId } from '../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { actionSuccessorFencesMatch, buildActionSuccessorFence } from './ActionSuccessorAdmissionContract.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export function isExactOrphanRecoveryEntry(
  entry: QueueLedgerEntry,
  source: StoredMessage,
  lease: ActionSuccessorLease,
): boolean {
  const holder = lease.holderCatIds[0];
  return Boolean(
    holder &&
      entry.id === queueEntryId(source.id) &&
      entry.threadId === lease.holderThreadId &&
      entry.owner.kind === 'user' &&
      entry.owner.userId === lease.tenantScope &&
      entry.kind === 'message_wake' &&
      entry.from.kind === 'agent' &&
      entry.from.catId === lease.predecessorCatId &&
      entry.targets.length === 1 &&
      entry.targets[0] === holder &&
      entry.payload.sourceRecordId === source.id &&
      entry.payload.messageId === source.id &&
      entry.payload.content === source.content &&
      entry.execution.intent === 'execute' &&
      entry.execution.autoExecute === true &&
      entry.execution.a2aTriggerMessageId === source.id &&
      entry.sourceCategory === 'a2a' &&
      entry.status !== 'terminal' &&
      actionSuccessorFencesMatch(
        entry.execution.actionSuccessorFence,
        buildActionSuccessorFence(lease, lease.dispatchId),
      ) &&
      source.lifecycle?.kind === 'input' &&
      (source.lifecycle.dispatchRefs?.length ?? 0) === 0,
  );
}
