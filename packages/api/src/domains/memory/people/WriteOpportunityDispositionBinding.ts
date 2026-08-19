import type { DeliveredWriteOpportunityRecordV1, WriteOpportunityRefV1 } from '@cat-cafe/shared';
import {
  validateWriteOpportunityRef,
  type WriteOpportunityDeliveryStore,
  type WriteOpportunityRefRejectionReason,
} from './WriteOpportunityDeliveryStore.js';
import type { WriteOpportunityTerminalLedger } from './WriteOpportunityTerminalLedger.js';

export type WriteOpportunityDispositionBindingRejectionReason =
  | WriteOpportunityRefRejectionReason
  | 'write_opportunity_evidence_unavailable'
  | 'write_opportunity_ref_required'
  | 'write_opportunity_terminal_authority_unavailable'
  | 'write_opportunity_lineage_invalidated';

export type WriteOpportunityDispositionBinding =
  | { readonly status: 'absent' }
  | { readonly status: 'resolved'; readonly record: DeliveredWriteOpportunityRecordV1 }
  | { readonly status: 'rejected'; readonly reason: WriteOpportunityDispositionBindingRejectionReason };

/**
 * Bind one tool disposition to server-held F296 delivery evidence.
 *
 * A missing ref is accepted only when the invocation received no write opportunity. This keeps the
 * ordinary F276 tools backward compatible without allowing a cat-visible opportunity to evaporate
 * through the legacy unattributed path. Multiple delivered opportunities remain unambiguous because
 * the caller must name the exact identity triple and every field is re-derived here.
 */
export async function resolveWriteOpportunityDispositionBinding(input: {
  readonly store?: WriteOpportunityDeliveryStore;
  readonly terminalLedger?: WriteOpportunityTerminalLedger;
  readonly ref?: WriteOpportunityRefV1;
  readonly ownerUserId: string;
  readonly invocationId: string;
  readonly now: number;
}): Promise<WriteOpportunityDispositionBinding> {
  if (!input.store) {
    return input.ref ? { status: 'rejected', reason: 'write_opportunity_evidence_unavailable' } : { status: 'absent' };
  }
  if (!input.ref) {
    const delivered = await input.store.listInvocationOpportunityIds(input.ownerUserId, input.invocationId);
    return delivered.length > 0
      ? { status: 'rejected', reason: 'write_opportunity_ref_required' }
      : { status: 'absent' };
  }
  const record = await input.store.get(input.ownerUserId, input.ref.opportunityId);
  const validation = validateWriteOpportunityRef({
    ref: input.ref,
    record,
    ownerUserId: input.ownerUserId,
    invocationId: input.invocationId,
    now: input.now,
  });
  if (validation.status === 'rejected') return { status: 'rejected', reason: validation.reason };
  if (!input.terminalLedger) return { status: 'resolved', record: validation.record };
  try {
    const states = await input.terminalLedger.readLineageStates(input.ownerUserId, [validation.record.dedupeLineage]);
    const state = states.get(validation.record.dedupeLineage);
    if (state?.invalidatedReason) {
      return { status: 'rejected', reason: 'write_opportunity_lineage_invalidated' };
    }
  } catch {
    return { status: 'rejected', reason: 'write_opportunity_terminal_authority_unavailable' };
  }
  return { status: 'resolved', record: validation.record };
}
