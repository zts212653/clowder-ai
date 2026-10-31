import {
  type ArtifactReviewAnchor,
  ContextAttachmentsSchema,
  contentModificationOutcome,
  type MediaContextAttachment,
  MediaContextAttachmentSchema,
} from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { composerAttachments, queuedServerAckBlocks } from '../composer-queue';
import {
  type AddMediaSelection,
  type AddMediaWork,
  addMediaSelection,
  addMediaWork,
  type MediaChatTarget,
  pendingMediaAttachment,
  removeMediaSelection,
  sameMediaSource,
} from './media-chat-selection';
import { sameMediaContentWithAdvancedReview } from './media-work-identity';

/**
 * Where circled places on an image enter the one chat composer. Like a text selection, it only lands in that
 * conversation's input as a chip: it never sends, delegates or records anything. The decision about what the
 * media attachment becomes is `media-chat-selection`; this only reads the composer and queues the change.
 */

export { composerAttachments };

/**
 * Queues one change to the media attachment. A change to an attachment the composer already holds is a replace in
 * place (the same id, plus its id in the remove list), exactly as other chips are edited; anything else already queued
 * for this conversation on the same tick is kept.
 */
function queueMediaChange(
  threadId: string,
  attachmentId: string,
  next: MediaContextAttachment | null,
  replacing: boolean,
): void {
  const queued = useChatStore.getState().pendingChatInsert;
  const base = queued && queued.threadId === threadId ? queued : { threadId, text: '' };
  const removed = new Set(base.removeContextAttachmentIds ?? []);
  if (replacing) removed.add(attachmentId);
  useChatStore.getState().setPendingChatInsert({
    ...base,
    ...(!base.selectionRange ? { preserveSelection: base.preserveSelection ?? true } : {}),
    contextAttachments: [
      ...(base.contextAttachments ?? []).filter((attachment) => attachment.id !== attachmentId),
      ...(next ? [next] : []),
    ],
    ...(removed.size ? { removeContextAttachmentIds: [...removed] } : {}),
  });
}

export type AddMediaSelectionToChat = AddMediaSelection | { readonly kind: 'refused'; readonly reason: 'no_thread' };

export function addMediaWorkToChat(
  threadId: string | null,
  target: MediaChatTarget,
  refreshWholeReview = false,
): AddMediaWork | { readonly kind: 'refused'; readonly reason: 'no_thread' } {
  if (!threadId) return { kind: 'refused', reason: 'no_thread' };
  if (queuedServerAckBlocks()) return { kind: 'refused', reason: 'recall_pending' };
  const current = composerAttachments(threadId);
  const pending =
    pendingMediaAttachment(current, target) ??
    (refreshWholeReview
      ? current.find(
          (item): item is MediaContextAttachment =>
            item.kind === 'media' && sameMediaContentWithAdvancedReview(item, target),
        )
      : undefined);
  const refresh =
    refreshWholeReview &&
    pending?.selections.length === 0 &&
    (sameMediaSource(pending, target) || sameMediaContentWithAdvancedReview(pending, target));
  const result = addMediaWork(refresh ? current.filter((item) => item.id !== pending.id) : current, target);
  if (result.kind === 'added') {
    const attachment = refresh ? { ...result.attachment, id: pending.id } : result.attachment;
    queueMediaChange(threadId, attachment.id, attachment, pending !== undefined);
    return { ...result, attachment };
  }
  return result;
}

export function addMediaSelectionToChat(
  threadId: string | null,
  target: MediaChatTarget,
  anchor: ArtifactReviewAnchor,
  instruction?: string,
  replaceWholeWork = false,
): AddMediaSelectionToChat {
  if (!threadId) return { kind: 'refused', reason: 'no_thread' };
  // A recall's answer waiting for the input is not something a place can be added to, or take the slot from: the input
  // would take the place as already saved. Nothing is queued, so nothing is lost; the person adds it again a moment
  // later.
  if (queuedServerAckBlocks()) return { kind: 'refused', reason: 'recall_pending' };
  const current = composerAttachments(threadId);
  const pending =
    pendingMediaAttachment(current, target) ??
    (replaceWholeWork
      ? current.find(
          (item): item is MediaContextAttachment =>
            item.kind === 'media' && sameMediaContentWithAdvancedReview(item, target),
        )
      : undefined);
  // The accepted image page references the whole work on open. A deliberate canvas selection replaces
  // only that same-source empty reference, atomically after all ordinary selection/collection checks.
  // Existing callers retain the refusal; another work, recall or invalid selection can never be erased.
  const whole =
    replaceWholeWork &&
    pending &&
    pending.selections.length === 0 &&
    (sameMediaSource(pending, target) || sameMediaContentWithAdvancedReview(pending, target))
      ? pending
      : null;
  const result = addMediaSelection(
    whole ? current.filter((item) => item.id !== whole.id) : current,
    target,
    anchor,
    instruction,
  );
  if (result.kind === 'added') {
    const attachment = whole ? { ...result.attachment, id: whole.id } : result.attachment;
    queueMediaChange(threadId, attachment.id, attachment, pending !== undefined);
    return { ...result, attachment };
  }
  return result;
}

/**
 * Takes one place out of the attachment that shows it. The attachment is named by id, never assumed to be the first
 * media attachment of the composer: a draft can hold more than one, and a place belongs to the one it is shown on.
 */
export function removeMediaSelectionFromChat(threadId: string, attachmentId: string, selectionId: string): boolean {
  const attachment = composerAttachments(threadId).find(
    (item): item is MediaContextAttachment => item.kind === 'media' && item.id === attachmentId,
  );
  if (!attachment) return false;
  const next = removeMediaSelection(attachment, selectionId);
  if (next === attachment) return false;
  // Reachable only while the input is not taking what is queued for it; changing a recall's answer is never done.
  if (queuedServerAckBlocks()) return false;
  queueMediaChange(threadId, attachment.id, next, true);
  return true;
}

/** Edit exactly one original place through the same queued composer delta, preserving sibling works and text. */
export function updateMediaSelectionWordsInChat(
  threadId: string,
  attachmentId: string,
  selectionId: string,
  words: string,
): boolean {
  if (queuedServerAckBlocks()) return false;
  const current = composerAttachments(threadId);
  const attachment = current.find(
    (item): item is MediaContextAttachment => item.kind === 'media' && item.id === attachmentId,
  );
  if (!attachment || !attachment.selections.some((item) => item.id === selectionId)) return false;
  const instruction = words.trim();
  const parsed = MediaContextAttachmentSchema.safeParse({
    ...attachment,
    selections: attachment.selections.map((item) => {
      if (item.id !== selectionId) return item;
      const place = { ...item };
      delete place.instruction;
      return { ...place, ...(instruction ? { instruction } : {}) };
    }),
  });
  if (!parsed.success) return false;
  try {
    contentModificationOutcome({ body: '', selections: parsed.data.selections });
  } catch {
    return false;
  }
  if (
    !ContextAttachmentsSchema.safeParse(current.map((item) => (item.id === attachmentId ? parsed.data : item))).success
  )
    return false;
  queueMediaChange(threadId, attachmentId, parsed.data, true);
  return true;
}
