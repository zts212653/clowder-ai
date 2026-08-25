import type { DeferredPersonMemoryReceipt, DeferredWriteOpportunityReceiptV1 } from '@cat-cafe/shared';

function sameSourceRefs(
  left: DeferredWriteOpportunityReceiptV1['sourceRefs'],
  right: DeferredWriteOpportunityReceiptV1['sourceRefs'],
): boolean {
  return (
    left.length === right.length &&
    left.every((ref, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        ref.artifactId === other.artifactId &&
        ref.sourceRevision === other.sourceRevision &&
        ref.attributionRevision === other.attributionRevision &&
        ref.segmentStart === other.segmentStart &&
        ref.segmentEnd === other.segmentEnd
      );
    })
  );
}

function sameDeferredWriteReceipt(
  left: DeferredWriteOpportunityReceiptV1 | undefined,
  right: DeferredWriteOpportunityReceiptV1 | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.receiptId === right.receiptId &&
    left.opportunityId === right.opportunityId &&
    left.reflexId === right.reflexId &&
    left.reflexVersion === right.reflexVersion &&
    left.generation === right.generation &&
    left.dedupeLineage === right.dedupeLineage &&
    left.eligibleAt === right.eligibleAt &&
    left.expiresAt === right.expiresAt &&
    left.rearmPredicate === right.rearmPredicate &&
    left.destinationProposalContract === right.destinationProposalContract &&
    left.state === right.state &&
    sameSourceRefs(left.sourceRefs, right.sourceRefs)
  );
}

/** A replay may reuse an existing receipt only when the full server-derived attribution matches. */
export function sameDeferredWriteOpportunityBinding(
  left: DeferredPersonMemoryReceipt,
  right: DeferredPersonMemoryReceipt,
): boolean {
  const leftLineage = left.writeOpportunityLineage;
  const rightLineage = right.writeOpportunityLineage;
  if (!leftLineage || !rightLineage) {
    return (
      leftLineage === rightLineage &&
      left.writeOpportunityReceipt === undefined &&
      right.writeOpportunityReceipt === undefined
    );
  }
  return (
    leftLineage.reflexId === rightLineage.reflexId &&
    leftLineage.reflexVersion === rightLineage.reflexVersion &&
    leftLineage.opportunityId === rightLineage.opportunityId &&
    leftLineage.dedupeLineage === rightLineage.dedupeLineage &&
    leftLineage.generation === rightLineage.generation &&
    sameDeferredWriteReceipt(left.writeOpportunityReceipt, right.writeOpportunityReceipt)
  );
}
