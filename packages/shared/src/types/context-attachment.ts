export const CONTEXT_ATTACHMENT_VERSION = 1 as const;
export const CONTEXT_ATTACHMENT_MAX_COUNT = 12;
export const CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH = 20_000;
export const CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH = 10_000;
export const CONTEXT_ATTACHMENT_PROMPT_MAX_CHARS = 48_000;

interface ContextAttachmentBase {
  readonly v: typeof CONTEXT_ATTACHMENT_VERSION;
  readonly id: string;
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
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

export interface MessageQuoteSource {
  readonly kind: 'message';
  readonly threadId: string;
  readonly messageId: string;
  readonly senderCatId?: string;
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
  readonly language?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

export type QuoteContextSource = MessageQuoteSource | CliOutputQuoteSource | WorkspaceFileQuoteSource;

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

export type ContextAttachment = ThreadContextAttachment | WorkspaceFileContextAttachment | QuoteContextAttachment;

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
