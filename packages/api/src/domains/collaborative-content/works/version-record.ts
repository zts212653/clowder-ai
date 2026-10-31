import type { CommitWork, WorkVersionRecord } from '@cat-cafe/shared';
import type { ContentSettlementReceiptV1, WorkPublicationScopeV1 } from '../../video-studio/content-owner/types.js';

export function workVersionRecord(
  command: CommitWork,
  scope: WorkPublicationScopeV1,
  receipt: ContentSettlementReceiptV1,
  requestDigest: string,
): WorkVersionRecord {
  return {
    contentRef: receipt.contentRef,
    ownerRevision: receipt.ownerRevision,
    ownerUserId: scope.ownerUserId,
    threadId: scope.threadId,
    title: command.title,
    changeSummary: command.changeSummary,
    ...(command.versionLabel ? { versionLabel: command.versionLabel } : {}),
    source: command.source,
    operationId: command.operationId,
    requestDigest,
    receiptRef: receipt.receiptId,
  };
}
