import type {
  AsrPersonMemoryWriteOpportunityV1,
  DeferredWriteOpportunityReceiptV1,
  DeliveredWriteOpportunityRecordV1,
  WriteOpportunityDispositionV1,
} from '@cat-cafe/shared';

/**
 * The minimal delivered-opportunity facts a disposition needs. Both the in-invocation lifecycle
 * state and the persisted delivered record project into this, so the lineage/expiry predicates exist
 * exactly once.
 */
export interface DeliveredOpportunityFacts {
  readonly opportunityId: string;
  readonly generation: number;
  readonly dedupeLineage: string;
  readonly reflexId: 'asr-person-memory';
  readonly reflexVersion: 1;
  readonly presentedAt: number;
  readonly expiresAt: number;
  readonly rearmPredicate: 'next_eligible_owner_context_after_defer';
  readonly destinationProposalContract: 'F276.CaptureCandidate.v1';
  readonly sourceRefs: DeferredWriteOpportunityReceiptV1['sourceRefs'];
}

export type DeliveredDispositionResult =
  | {
      readonly status: 'recorded';
      readonly disposition: WriteOpportunityDispositionV1;
      readonly receipt?: DeferredWriteOpportunityReceiptV1;
    }
  | { readonly status: 'rejected'; readonly reason: string };

export function deliveredFactsFromState(
  opportunity: AsrPersonMemoryWriteOpportunityV1,
  presentedAt: number,
): DeliveredOpportunityFacts {
  return {
    opportunityId: opportunity.opportunityId,
    generation: opportunity.generation,
    dedupeLineage: opportunity.dedupeLineage,
    reflexId: opportunity.reflexId,
    reflexVersion: opportunity.reflexVersion,
    presentedAt,
    expiresAt: opportunity.expiresAt,
    rearmPredicate: opportunity.rearmPredicate,
    destinationProposalContract: opportunity.destination.proposalContract,
    sourceRefs: opportunity.sourceCoordinates.map((coordinate) => ({
      artifactId: coordinate.artifactId,
      sourceRevision: coordinate.sourceRevision,
      attributionRevision: coordinate.speaker.attributionRevision,
      segmentStart: coordinate.segment.start,
      segmentEnd: coordinate.segment.end,
    })),
  };
}

export function deliveredFactsFromRecord(record: DeliveredWriteOpportunityRecordV1): DeliveredOpportunityFacts {
  return {
    opportunityId: record.opportunityId,
    generation: record.generation,
    dedupeLineage: record.dedupeLineage,
    reflexId: record.reflexId,
    reflexVersion: record.reflexVersion,
    presentedAt: record.presentedAt,
    expiresAt: record.expiresAt,
    rearmPredicate: record.rearmPredicate,
    destinationProposalContract: record.destinationProposalContract,
    sourceRefs: record.sourceRefs,
  };
}

/**
 * Exact receipt <-> opportunity lineage equality, used to gate deferred re-entry.
 */
export function receiptMatchesOpportunity(
  receipt: DeferredWriteOpportunityReceiptV1,
  opportunity: AsrPersonMemoryWriteOpportunityV1,
): boolean {
  if (
    receipt.opportunityId !== opportunity.opportunityId ||
    receipt.reflexId !== opportunity.reflexId ||
    receipt.reflexVersion !== opportunity.reflexVersion ||
    receipt.generation !== opportunity.generation ||
    receipt.dedupeLineage !== opportunity.dedupeLineage ||
    receipt.expiresAt !== opportunity.expiresAt ||
    receipt.rearmPredicate !== opportunity.rearmPredicate ||
    receipt.destinationProposalContract !== opportunity.destination.proposalContract ||
    receipt.sourceRefs.length !== opportunity.sourceCoordinates.length
  ) {
    return false;
  }
  return receipt.sourceRefs.every((ref, index) => {
    const coordinate = opportunity.sourceCoordinates[index];
    return (
      coordinate !== undefined &&
      ref.artifactId === coordinate.artifactId &&
      ref.sourceRevision === coordinate.sourceRevision &&
      ref.attributionRevision === coordinate.speaker.attributionRevision &&
      ref.segmentStart === coordinate.segment.start &&
      ref.segmentEnd === coordinate.segment.end
    );
  });
}
