import {
  type ContextAttachment,
  ContextAttachmentSchema,
  ContextAttachmentsSchema,
  type QuoteContextAttachment,
} from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { createQuoteContextAttachment } from '../chat-context-reference';
import { composerAttachments, queuedServerAckBlocks } from '../composer-queue';
import { COMPOSER_RECALL_PENDING_COPY, COMPOSER_TOO_LARGE_COPY } from '../composer-refusal-copy';
import {
  PROJECT_SCREENING_GROUP_CONFLICT,
  projectScreeningComposerConflict,
} from '../project-screening-composer-group';

/** A selection in one workspace file, with only the coordinates that were actually known. */
export interface WorkspaceFileQuote {
  readonly text: string;
  readonly comment: string;
  readonly path: string;
  /**
   * The exact version of the file the selection was made in: the owner's `sha256:<hex>` or the bare digest a file
   * API answers with. It is required so no producer can forget to say it; `null` is the explicit "this surface cannot
   * vouch for a version" (an unsaved draft, a file it has not verified), which leaves the reference unversioned.
   */
  readonly revision: string | null;
  readonly worktreeId?: string | null;
  readonly branch?: string | null;
  readonly language?: string | null;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
}

const SHA256_REVISION = /^(?:sha256:)?([0-9a-f]{64})$/;

/** The owner's form of a revision, or nothing: a reference never says a version it cannot back. */
function exactRevision(revision: string | null): `sha256:${string}` | null {
  const digest = revision ? SHA256_REVISION.exec(revision)?.[1] : undefined;
  return digest ? `sha256:${digest}` : null;
}

export function workspaceFileQuoteAttachment(quote: WorkspaceFileQuote): ContextAttachment {
  const revision = exactRevision(quote.revision);
  return createQuoteContextAttachment(
    quote.text,
    {
      kind: 'workspace_file',
      path: quote.path,
      ...(quote.worktreeId ? { worktreeId: quote.worktreeId } : {}),
      ...(quote.branch ? { branch: quote.branch } : {}),
      ...(revision ? { revision } : {}),
      ...(quote.language ? { language: quote.language } : {}),
      ...(quote.lineStart !== undefined && quote.lineEnd !== undefined
        ? { lineStart: quote.lineStart, lineEnd: quote.lineEnd }
        : {}),
    },
    {
      comment: quote.comment,
      ...(quote.selectionStart !== undefined && quote.selectionEnd !== undefined
        ? { selectionStart: quote.selectionStart, selectionEnd: quote.selectionEnd }
        : {}),
    },
  );
}

export type AddWorkspaceFileQuote =
  | { readonly kind: 'added' }
  | { readonly kind: 'refused'; readonly reason: 'too_large' | 'recall_pending' | 'other_source' };

const REFUSAL_COPY = {
  too_large: COMPOSER_TOO_LARGE_COPY,
  recall_pending: COMPOSER_RECALL_PENDING_COPY,
  other_source: PROJECT_SCREENING_GROUP_CONFLICT,
} as const;

/**
 * The one "add to chat" for a workspace file selection: it lands in that thread's chat input as an
 * annotation chip. It does not send, delegate, or record anything else.
 *
 * What is already queued for this conversation stays: the input takes a queued place only when it is there to take
 * it (a chat folded away while the file is read does not), so a second place must not replace the first. A place that
 * would make the whole input more than one message can carry, or that would meet a recall's answer the input has not
 * taken yet, is refused before anything is queued: the person is told why, and the caller learns it too, so it can
 * keep the selection and the words where they are.
 */
export function addWorkspaceFileQuoteToChat(threadId: string, quote: WorkspaceFileQuote): AddWorkspaceFileQuote {
  return admitQuoteToChat(threadId, () => workspaceFileQuoteAttachment(quote));
}

/** Shared admission for a source-bound text quote; the current composer remains its only draft. */
export function addQuoteToChat(threadId: string, attachment: ContextAttachment): AddWorkspaceFileQuote {
  return admitQuoteToChat(threadId, () => attachment);
}

function admitQuoteToChat(threadId: string, makeAttachment: () => ContextAttachment): AddWorkspaceFileQuote {
  const refuse = (reason: 'too_large' | 'recall_pending' | 'other_source'): AddWorkspaceFileQuote => {
    useToastStore
      .getState()
      .addToast({ type: 'error', title: '没能放进输入框', message: REFUSAL_COPY[reason], duration: 6000 });
    return { kind: 'refused', reason };
  };
  if (queuedServerAckBlocks()) return refuse('recall_pending');
  const attachment = makeAttachment();
  // The canonical rule for what one message carries, over the whole input: its stored draft with what is queued
  // applied, and this place.
  const effective = [...composerAttachments(threadId), attachment];
  if (projectScreeningComposerConflict(effective)) return refuse('other_source');
  if (!ContextAttachmentsSchema.safeParse(effective).success) return refuse('too_large');
  const store = useChatStore.getState();
  const queued = store.pendingChatInsert;
  const base = queued && queued.threadId === threadId ? queued : { threadId, text: '' };
  store.setPendingChatInsert({ ...base, contextAttachments: [...(base.contextAttachments ?? []), attachment] });
  return { kind: 'added' };
}

/** Update the same unsent place through the composer's delta, preserving every other queued word and reference. */
export function editWorkspaceFileQuoteInChat(
  threadId: string,
  original: QuoteContextAttachment,
  comment: string | null,
): boolean {
  const store = useChatStore.getState();
  if (store.currentThreadId !== threadId) return false;
  const refuse = (reason: keyof typeof REFUSAL_COPY) => {
    useToastStore
      .getState()
      .addToast({ type: 'error', title: '没能更新批注', message: REFUSAL_COPY[reason], duration: 6000 });
    return false;
  };
  if (queuedServerAckBlocks()) return refuse('recall_pending');
  const attachments = composerAttachments(threadId);
  const current = attachments.find((attachment) => attachment.id === original.id);
  if (
    current?.kind !== 'quote' ||
    !(current.source.kind === 'workspace_file' || (current.source.kind === 'message' && current.source.artifactFile)) ||
    current.text !== original.text ||
    JSON.stringify(current.source) !== JSON.stringify(original.source)
  )
    return false;
  const parsed = comment === null ? null : ContextAttachmentSchema.safeParse({ ...current, comment });
  if (parsed && !parsed.success) return refuse('too_large');
  const updated = parsed?.success ? parsed.data : null;
  const next = attachments.flatMap((attachment) =>
    attachment.id !== current.id ? [attachment] : updated ? [updated] : [],
  );
  if (!ContextAttachmentsSchema.safeParse(next).success) return refuse('too_large');
  const queued = store.pendingChatInsert;
  const base = queued?.threadId === threadId ? queued : { threadId, text: '' };
  const incoming = (base.contextAttachments ?? []).flatMap((attachment) =>
    attachment.id !== current.id ? [attachment] : updated ? [updated] : [],
  );
  if (updated && !incoming.some((attachment) => attachment.id === current.id)) incoming.push(updated);
  store.setPendingChatInsert({
    ...base,
    contextAttachments: incoming,
    removeContextAttachmentIds: [...new Set([...(base.removeContextAttachmentIds ?? []), current.id])],
  });
  return true;
}
