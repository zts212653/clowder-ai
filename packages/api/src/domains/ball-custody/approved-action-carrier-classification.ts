import type { DispatchProposal } from '@cat-cafe/shared';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
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
): ApprovedActionCarrierClassification {
  const targetCats = proposal.targetCats;
  const sourceMatches =
    message.threadId === proposal.targetThreadId &&
    message.userId === proposal.ownerUserId &&
    message.catId === proposal.senderCatId &&
    message.content === proposal.content &&
    message.origin === 'callback' &&
    message.replyTo === proposal.replyTo &&
    message.extra?.isExplicitPost === true &&
    message.extra.crossPost?.sourceThreadId === proposal.sourceThreadId &&
    message.extra.crossPost.effectClass === 'assign_work' &&
    sameOrderedStrings(message.mentions, targetCats) &&
    sameOrderedStrings(message.extra.targetCats, targetCats);
  if (!sourceMatches) return { outcome: 'conflict', reason: 'carrier_source_conflict' };

  const custody = message.queueCustody;
  if (!custody) {
    return message.deliveryStatus === undefined || message.deliveryStatus === 'queued'
      ? { outcome: 'repairable' }
      : { outcome: 'conflict', reason: 'carrier_receipt_conflict' };
  }
  const carrierByTargetCatId = custody.carrierByTargetCatId;
  if (!carrierByTargetCatId) return { outcome: 'conflict', reason: 'carrier_receipt_conflict' };
  const custodyMatches =
    (message.deliveryStatus === 'queued' || message.deliveryStatus === 'delivered') &&
    custody.entryId === `cross-thread:${message.id}` &&
    custody.intent === 'execute' &&
    custody.ownerUserId === proposal.ownerUserId &&
    custody.receiptScope === 'cross_thread_delivery' &&
    sameOrderedStrings(custody.allTargetCats, targetCats) &&
    sameOrderedStrings(Object.keys(carrierByTargetCatId), targetCats) &&
    targetCats.every((catId) => {
      const binding = carrierByTargetCatId[catId];
      return (
        binding?.source === 'agent' &&
        binding.sourceCategory === 'a2a' &&
        binding.callerCatId === proposal.senderCatId &&
        binding.a2aTriggerMessageId === message.id &&
        binding.autoExecute === true &&
        binding.entryId.length > 0
      );
    });
  return custodyMatches ? { outcome: 'admitted' } : { outcome: 'conflict', reason: 'carrier_receipt_conflict' };
}
