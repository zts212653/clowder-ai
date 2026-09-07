import { z } from 'zod';
import type { ProducerAttentionReceiptV1 } from './growing.js';

export type EligibleAttentionReceipt = Extract<ProducerAttentionReceiptV1, { eligible: true }>;

export function canonicalProducerEvidence(receipts: readonly EligibleAttentionReceipt[]) {
  return receipts
    .map((receipt) => ({
      producerId: receipt.producer.producerId,
      ownerRef: receipt.producer.ownerRef,
      revision: receipt.producer.revision,
    }))
    .sort((left, right) =>
      [left.producerId, left.ownerRef, left.revision]
        .join('\u0000')
        .localeCompare([right.producerId, right.ownerRef, right.revision].join('\u0000')),
    );
}

export function sameProducerEvidence(left: unknown, right: ReturnType<typeof canonicalProducerEvidence>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function selectCanonicalOwnerTime<T extends { role: 'business_deadline' | 'review_by' | 'execution_trigger' }>(
  timeRefs: readonly T[],
): T | undefined {
  const priority = ['review_by', 'business_deadline', 'execution_trigger'] as const;
  return priority.flatMap((role) => timeRefs.filter((timeRef) => timeRef.role === role))[0];
}

interface OwnerTimeCoordinates {
  envelope: { subjectRef: string; ownerRef: string; revision: number };
  timeRefs: Array<{
    role: 'business_deadline' | 'review_by' | 'execution_trigger';
    subjectRef: string;
    ownerRef: string;
    revision: number;
  }>;
}

export function validateOwnerTimeCoordinates(ownerRead: OwnerTimeCoordinates, context: z.RefinementCtx): void {
  const roles = new Set<string>();
  ownerRead.timeRefs.forEach((timeRef, index) => {
    if (
      timeRef.subjectRef !== ownerRead.envelope.subjectRef ||
      timeRef.ownerRef !== ownerRead.envelope.ownerRef ||
      timeRef.revision !== ownerRead.envelope.revision
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeRefs', index],
        message: 'time coordinate must be linked to the canonical Task owner revision',
      });
    }
    if (roles.has(timeRef.role)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['timeRefs', index], message: 'time role must be unique' });
    }
    roles.add(timeRef.role);
  });
}
