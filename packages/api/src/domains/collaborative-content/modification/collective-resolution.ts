import { createHash } from 'node:crypto';
import type { CollectiveModificationRecord } from '@cat-cafe/shared';

type Resolution = NonNullable<CollectiveModificationRecord['resolution']>;
export function collectiveResolutionReceipt(
  scopeRef: string,
  requestId: string,
  resolution: Omit<Resolution, 'receiptRef' | 'resolvedAt'>,
) {
  return `collective-resolution:${createHash('sha256')
    .update(
      JSON.stringify([
        scopeRef,
        requestId,
        resolution.kind,
        resolution.operationId,
        resolution.actorHumanId,
        resolution.expectedRequestRevision,
        resolution.proposalRef ?? null,
      ]),
    )
    .digest('hex')}`;
}
