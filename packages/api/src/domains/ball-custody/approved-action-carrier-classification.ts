import type { DispatchProposal } from '@cat-cafe/shared';
import type { QueueLedgerEntry } from '../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { messageFrom } from '../cats/services/stores/message-from.js';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { actionSuccessorFencesMatch } from './ActionSuccessorAdmissionContract.js';
import type { ActionSuccessorFence } from './ActionSuccessorAdmissionService.js';
import type { ActionSuccessorDispatchFailureReason } from './action-successor-state-machine.js';

export type ApprovedActionCarrierClassification =
  | { readonly outcome: 'repairable' }
  | { readonly outcome: 'admitted' }
  | { readonly outcome: 'conflict'; readonly reason: ActionSuccessorDispatchFailureReason };

function sameOrderedStrings(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Classify durable source/custody truth after the lease/proposal fence. */
export function classifyApprovedActionCarrier(
  proposal: DispatchProposal,
  message: StoredMessage,
  entries: readonly QueueLedgerEntry[],
  fence: ActionSuccessorFence,
): ApprovedActionCarrierClassification {
  const targetCats = proposal.targetCats;
  const from = messageFrom(message);
  const sourceMatches =
    message.threadId === proposal.targetThreadId &&
    message.userId === proposal.ownerUserId &&
    from.kind === 'agent' &&
    from.catId === proposal.senderCatId &&
    message.content === proposal.content &&
    message.origin === 'callback' &&
    message.replyTo === proposal.replyTo &&
    message.extra?.isExplicitPost === true &&
    message.extra.crossPost?.sourceThreadId === proposal.sourceThreadId &&
    message.extra.crossPost.effectClass === 'assign_work' &&
    sameOrderedStrings(message.mentions, targetCats) &&
    sameOrderedStrings(message.extra.targetCats, targetCats);
  if (!sourceMatches) return { outcome: 'conflict', reason: 'carrier_source_conflict' };

  if (entries.length === 0) {
    return message.deliveryStatus === undefined || message.deliveryStatus === 'queued'
      ? { outcome: 'repairable' }
      : { outcome: 'conflict', reason: 'carrier_receipt_conflict' };
  }
  const [entry] = entries;
  const ledgerMatches =
    message.deliveryStatus !== 'canceled' &&
    entries.length === 1 &&
    Boolean(
      entry &&
        sameOrderedStrings(entry.targets, targetCats) &&
        entry.owner.kind === 'user' &&
        entry.owner.userId === proposal.ownerUserId &&
        entry.from.kind === 'agent' &&
        entry.from.catId === proposal.senderCatId &&
        entry.kind === 'message_wake' &&
        entry.payload.messageId === message.id &&
        entry.payload.sourceRecordId === message.id &&
        entry.payload.content === proposal.content &&
        entry.execution.intent === 'execute' &&
        entry.execution.autoExecute === true &&
        entry.sourceCategory === 'a2a' &&
        entry.execution.actionSuccessorFence &&
        actionSuccessorFencesMatch(entry.execution.actionSuccessorFence, fence),
    );
  return ledgerMatches ? { outcome: 'admitted' } : { outcome: 'conflict', reason: 'carrier_receipt_conflict' };
}
