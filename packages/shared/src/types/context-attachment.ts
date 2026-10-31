import type { AssetWorkCoordinate } from './asset-canon.js';
import type { MediaContextAttachment } from './media-context-attachment.js';
import type { MessageMediaItemSelector } from './media-publication-source.js';
import type { ProjectScreeningContextAttachment } from './video-project-message.js';

export type { MediaContextAttachment } from './media-context-attachment.js';

import { CONTEXT_ATTACHMENT_VERSION } from './context-attachment-limits.js';

export * from './context-attachment-limits.js';

interface ContextAttachmentBase {
  readonly v: typeof CONTEXT_ATTACHMENT_VERSION;
  readonly id: string;
}
/** A material citation belongs to this exact film and index, never a path's current contents. */
export interface AssetContextAttachment extends ContextAttachmentBase {
  readonly kind: 'asset';
  readonly workTitle?: string;
  readonly name: string;
  readonly mediaType: string;
  readonly indexedVersionRef: string;
  readonly work: AssetWorkCoordinate;
}

export interface ThreadContextAttachment extends ContextAttachmentBase {
  readonly kind: 'thread';
  readonly threadId: string;
  readonly title: string;
}

export interface WorkspaceFileContextAttachment extends ContextAttachmentBase {
  readonly kind: 'workspace_file';
  readonly path: string;
  readonly worktreeId?: string;
  readonly branch?: string;
  /** Exact F063 owner revision. `v` remains the attachment format version. */
  readonly revision?: `sha256:${string}`;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

export interface MessageQuoteSource {
  readonly kind: 'message';
  readonly threadId: string;
  readonly messageId: string;
  readonly senderCatId?: string;
  /** Bounded citation display metadata; never a user comment, permission or current-decision authority. */
  readonly displayLabel?: string;
  /** A quoted file leaf of this message. Metadata describes the displayed copy, never write authority. */
  readonly artifactFile?: {
    readonly item: MessageMediaItemSelector;
    readonly url: string;
    readonly fileName: string;
    readonly messageRevision: string;
    readonly displayDigest: `sha256:${string}`;
  };
}

export interface CliOutputQuoteSource {
  readonly kind: 'cli_output';
  readonly threadId: string;
  readonly messageId: string;
  /** Stable rendered leaf that owns selectionStart/selectionEnd (for example stdout or one tool detail). */
  readonly segmentId?: string;
}

export interface WorkspaceFileQuoteSource {
  readonly kind: 'workspace_file';
  readonly path: string;
  readonly worktreeId?: string;
  readonly branch?: string;
  /** Exact F063 owner revision; absent only on legacy references. */
  readonly revision?: `sha256:${string}`;
  readonly language?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

export interface CollectiveMessageQuoteSource {
  readonly kind: 'collective_message';
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
  readonly channelId: string;
  readonly eventId: string;
}

export type QuoteContextSource =
  | MessageQuoteSource
  | CliOutputQuoteSource
  | WorkspaceFileQuoteSource
  | CollectiveMessageQuoteSource;

export interface QuoteContextAttachment extends ContextAttachmentBase {
  readonly kind: 'quote';
  readonly text: string;
  /** User-authored response that is semantically paired with this quote. */
  readonly comment?: string;
  /** Character offsets inside the immutable rendered source leaf used for annotation markers. */
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
  readonly source: QuoteContextSource;
}

export type ContextAttachment =
  | AssetContextAttachment
  | ThreadContextAttachment
  | WorkspaceFileContextAttachment
  | QuoteContextAttachment
  | MediaContextAttachment
  | ProjectScreeningContextAttachment;

/**
 * Canonical model-facing projection. Keeping the escaping and wrapper here lets
 * the shared collection schema measure the exact payload that routing emits.
 */
export function serializeContextAttachmentsPrompt(attachments: readonly ContextAttachment[]): string {
  const json = JSON.stringify(attachments)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
  return `<context_attachments>${json}</context_attachments>`;
}

export interface ContextAttachmentContent {
  readonly type: 'context_attachment';
  readonly attachment: ContextAttachment;
}

/** A read-only file-side view of existing message quotes; it is not a text annotation ledger. */
export interface WorkspaceFileQuoteReference {
  readonly threadId: string;
  readonly messageId: string;
  readonly authorCatId: string | null;
  readonly timestamp: number;
  readonly quoteNumber: number;
  readonly attachment: QuoteContextAttachment;
  readonly state: 'current' | 'changed' | 'unversioned' | 'unlocated';
  /** Only present after the F063 owner resolves this exact quote against its named current revision. */
  readonly anchor?: { readonly start: number; readonly end: number; readonly quote: string };
}

export interface WorkspaceFileQuotePage {
  readonly sourceRevision: string;
  readonly quotes: readonly WorkspaceFileQuoteReference[];
  /** Cursor through the owner's messages, including pages with no quotes of this file. */
  readonly nextCursor?: string;
}
