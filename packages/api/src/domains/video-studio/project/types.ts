import type { VideoProjectDocumentV1 } from '@cat-cafe/shared';
import type { ContentSettlementReceiptV1 } from '../content-owner/types.js';
import type { VideoProjectPrincipal } from './access.js';

export interface VideoProjectSnapshot {
  readonly contentRef: string;
  readonly ownerRevision: number;
  readonly blobDigest: `sha256:${string}`;
  readonly document: VideoProjectDocumentV1;
}

/** Content-free adapter contract; consumers need no dependency on the implementation class. */
export interface VideoProjectReadPort {
  load(input: {
    principal: VideoProjectPrincipal;
    contentRef: string;
    ownerRevision?: number;
  }): Promise<VideoProjectSnapshot>;
  authorize(input: {
    principal: VideoProjectPrincipal;
    contentRef: string;
    permission: 'read' | 'write';
  }): Promise<void>;
  operationReceipt(input: {
    principal: VideoProjectPrincipal;
    contentRef: string;
    operationId: string;
  }): Promise<ContentSettlementReceiptV1 | undefined>;
}
