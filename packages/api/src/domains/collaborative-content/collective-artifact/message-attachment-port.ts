import type { Readable } from 'node:stream';
import type { CollectiveAttachmentScope, CollectiveMessageAttachment } from '@cat-cafe/shared';

export interface CollectiveAttachmentAuthority {
  reauthorize(): Promise<CollectiveAttachmentScope>;
}
/** The approved Service delegates private byte custody; public visibility stays with its event owner. */
export interface CollectiveMessageAttachmentOwnerPort {
  retain(
    input: {
      scope: CollectiveAttachmentScope;
      fileName: string;
      mediaType: string;
      blobDigest: string;
      bytes: Uint8Array;
    },
    authority: CollectiveAttachmentAuthority,
    signal: AbortSignal,
  ): Promise<CollectiveMessageAttachment>;
  open(
    input: { scope: CollectiveAttachmentScope; attachment: CollectiveMessageAttachment; range?: string },
    authority: CollectiveAttachmentAuthority,
    signal: AbortSignal,
  ): Promise<{
    attachment: CollectiveMessageAttachment;
    status: 200 | 206 | 416;
    start?: number;
    end?: number;
    body: Readable;
  }>;
}
