import type { EntrustedWorkOwnerReadV1, ProducerAttentionReceiptV1 } from '@cat-cafe/shared';

export type EligibleNeedsMeReceipt = Extract<ProducerAttentionReceiptV1, { eligible: true }>;

export interface NeedsMeItem {
  ownerRead: EntrustedWorkOwnerReadV1;
  receipt: EligibleNeedsMeReceipt;
  itemRef: string;
}

export function needsMeItemRef(ownerRead: EntrustedWorkOwnerReadV1, receipt: ProducerAttentionReceiptV1): string {
  return [
    ownerRead.envelope.subjectRef,
    ownerRead.envelope.revision,
    receipt.producer.producerId,
    receipt.producer.subjectRef,
    receipt.producer.revision,
  ].join('|');
}

/** The shared owner-read projection is the only source of Needs Me visibility and count. */
export function selectNeedsMeItems(ownerReads: readonly EntrustedWorkOwnerReadV1[]): NeedsMeItem[] {
  return ownerReads.flatMap((ownerRead) =>
    ownerRead.attentionReceipts.flatMap((receipt) =>
      receipt.eligible && ownerRead.envelope.freshness.state === 'current' && ownerRead.preparedArtifact
        ? [{ ownerRead, receipt, itemRef: needsMeItemRef(ownerRead, receipt) }]
        : [],
    ),
  );
}
