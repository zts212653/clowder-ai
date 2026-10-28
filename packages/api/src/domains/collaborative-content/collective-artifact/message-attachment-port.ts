import type { Readable } from 'node:stream';
import type {
  CollectiveAttachmentScope,
  CollectiveContextAttachmentSelection,
  CollectiveMessageAttachment,
  CollectiveModelContent,
  CollectiveModelImage,
  CollectiveStickerScope,
  MessageSticker,
} from '@cat-cafe/shared';

export interface CollectiveAttachmentAuthority {
  reauthorize(): Promise<CollectiveAttachmentScope>;
}
/** The approved Service delegates private byte custody; public visibility stays with its event owner. */
export interface CollectiveMessageAttachmentOwnerPort {
  modelContent?(
    input: {
      scope: CollectiveAttachmentScope;
      attachment: CollectiveMessageAttachment;
      selection: CollectiveContextAttachmentSelection;
    },
    authority: CollectiveAttachmentAuthority,
    signal: AbortSignal,
  ): Promise<CollectiveModelContent>;
  catalogImage?(
    input: { scope: CollectiveStickerScope; stickerId: string },
    authority: { reauthorize(): Promise<CollectiveStickerScope> },
    signal: AbortSignal,
  ): Promise<{ sticker: MessageSticker; body: Readable }>;
  /** Optional for older Hosts. Freshly authorized pixels are returned only to the active model read. */
  modelImage?(
    input: { scope: CollectiveAttachmentScope; attachment: CollectiveMessageAttachment },
    authority: CollectiveAttachmentAuthority,
    signal: AbortSignal,
  ): Promise<CollectiveModelImage>;
  retain(
    input: {
      scope: CollectiveAttachmentScope;
      fileName: string;
      mediaType: string;
      blobDigest: string;
      bytes: Uint8Array;
      sticker?: MessageSticker;
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
