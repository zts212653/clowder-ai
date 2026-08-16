export type QueueEntrySettlement = 'consume' | 'transfer' | 'rollback' | 'retain';

export type QueueEntryTerminalReason = 'succeeded' | 'user_cancel' | 'system_failure' | 'superseded';

export type QueueReplacementCustody =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'verified';
      readonly previousEntryId: string;
      readonly replacementEntryId: string;
      readonly sourceMessageId: string;
    };

export type QueueEntryActionFence =
  | { readonly kind: 'none' }
  | { readonly kind: 'action_successor'; readonly leaseId: string; readonly generation: number };

/** Existing durable lifecycle that has already accepted terminal responsibility for this Queue carrier. */
export type QueueEntryDurableTerminalOwner =
  | { readonly kind: 'none' }
  | { readonly kind: 'freshness_supplement'; readonly supplementId: string };

export interface QueueEntrySettlementInput {
  readonly terminalReason: QueueEntryTerminalReason;
  readonly replacement: QueueReplacementCustody;
  readonly actionFence: QueueEntryActionFence;
  readonly durableTerminalOwner?: QueueEntryDurableTerminalOwner;
  /** Legacy rows without durable custody cannot be rolled back truthfully after their message was published. */
  readonly custody?: 'durable' | 'legacy_unbound' | 'absent';
}

/**
 * Gate 2 canonical Queue-attempt decision.
 *
 * This function chooses responsibility only. F264 exact target evidence still
 * performs the successful-message receipt commit; it is not a second Queue
 * lifecycle owner.
 */
export function resolveQueueEntrySettlement(input: QueueEntrySettlementInput): QueueEntrySettlement {
  if (input.terminalReason === 'user_cancel' || input.terminalReason === 'succeeded') return 'consume';

  if (input.terminalReason === 'superseded') {
    return input.replacement.kind === 'verified' ? 'transfer' : 'retain';
  }

  if (input.actionFence.kind === 'action_successor' || input.durableTerminalOwner?.kind === 'freshness_supplement') {
    return 'consume';
  }
  return input.custody === 'legacy_unbound' ? 'consume' : 'rollback';
}
