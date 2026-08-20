import type { DeliveredWriteOpportunityRecordV1 } from '@cat-cafe/shared';

/**
 * Persisted delivered-opportunity evidence, so a later F276 tool callback can be bound back to the
 * exact opportunity that prompted it.
 *
 * The disposition does not arrive inside the invocation closure: the cat calls an F276 MCP tool,
 * which lands on a separate HTTP callback. Without this, the only way to attribute a disposition
 * would be to infer "which opportunity did it probably mean", which is ambiguous the moment two
 * opportunities were delivered and is exactly the classifier-for-judgment substitution KD-8 forbids.
 *
 * Keyed by (owner, opportunityId) rather than by invocation, so validation is a single point read
 * and the stored `invocationId` becomes the thing being checked rather than part of the lookup path.
 */
export interface WriteOpportunityDeliveryStore {
  /** Idempotent; a later attempt may rebind only the same immutable generation after cat absence. */
  recordDelivered(record: DeliveredWriteOpportunityRecordV1): Promise<void>;
  get(ownerUserId: string, opportunityId: string): Promise<DeliveredWriteOpportunityRecordV1 | null>;
  /** Content-free reverse lookup used to reject an unattributed disposition, never to guess one. */
  listInvocationOpportunityIds(ownerUserId: string, invocationId: string): Promise<readonly string[]>;
  /** Purge on invalidation so a dead lineage cannot be dispositioned afterwards. */
  purgeLineage(ownerUserId: string, dedupeLineage: string): Promise<number>;
}

export class WriteOpportunityDeliveryConflictError extends Error {
  constructor(readonly opportunityId: string) {
    super(`delivered_record_conflict: ${opportunityId} already has a different delivered record`);
    this.name = 'WriteOpportunityDeliveryConflictError';
  }
}

export type WriteOpportunityRefValidation =
  | { readonly status: 'valid'; readonly record: DeliveredWriteOpportunityRecordV1 }
  | { readonly status: 'rejected'; readonly reason: WriteOpportunityRefRejectionReason };

export type WriteOpportunityRefRejectionReason =
  | 'unknown_opportunity'
  | 'owner_mismatch'
  | 'invocation_mismatch'
  | 'lineage_mismatch'
  | 'generation_mismatch'
  | 'expired';

export interface WriteOpportunityRef {
  readonly opportunityId: string;
  readonly dedupeLineage: string;
  readonly generation: number;
}

/**
 * Validate a cat-supplied ref against server-held delivery evidence.
 *
 * Every field the caller supplies is re-derived from the stored record rather than trusted, and the
 * invocation binding is checked so a ref cannot be replayed from an earlier turn. `expired` is
 * checked last so the more specific mismatches win the error message.
 */
export function validateWriteOpportunityRef(input: {
  readonly ref: WriteOpportunityRef;
  readonly record: DeliveredWriteOpportunityRecordV1 | null;
  readonly ownerUserId: string;
  readonly invocationId: string;
  readonly now: number;
}): WriteOpportunityRefValidation {
  const { ref, record } = input;
  if (!record) return { status: 'rejected', reason: 'unknown_opportunity' };
  if (record.ownerUserId !== input.ownerUserId) return { status: 'rejected', reason: 'owner_mismatch' };
  if (record.invocationId !== input.invocationId) {
    return { status: 'rejected', reason: 'invocation_mismatch' };
  }
  if (record.dedupeLineage !== ref.dedupeLineage) return { status: 'rejected', reason: 'lineage_mismatch' };
  if (record.generation !== ref.generation) return { status: 'rejected', reason: 'generation_mismatch' };
  if (input.now >= record.expiresAt) return { status: 'rejected', reason: 'expired' };
  return { status: 'valid', record };
}
