import type { ContextAttachment } from '@cat-cafe/shared';
import type { ComposerDraftInsert } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { applyContextAttachmentDelta } from './durable-composer-draft-merge';
import { getContextAttachmentDraft } from './thread-drafts';

/**
 * What a place chosen in a file or on a picture needs to know about the chat input before it is queued for it: what
 * the input holds right now, and whether the slot it is queued in is busy carrying something the server confirmed.
 */

/** What the composer holds right now: its stored draft with anything already queued for it applied on top. */
export function composerAttachments(threadId: string, local?: readonly ContextAttachment[]): ContextAttachment[] {
  const draft = [...(local ?? getContextAttachmentDraft(threadId))];
  const queued = useChatStore.getState().pendingChatInsert;
  if (!queued || queued.threadId !== threadId) return draft;
  return applyContextAttachmentDelta(
    draft,
    queued.contextAttachments ?? [],
    new Set(queued.removeContextAttachmentIds ?? []),
  );
}

/**
 * Whether an insert is the server's answer to a recall (what `composerInsertFromRecall` builds): it owns the editor's
 * content and the revision it names is taken by the input as already saved. Anything added to it would be taken as
 * saved too, and never written.
 */
function carriesServerAck(insert: ComposerDraftInsert): boolean {
  return insert.authoritative === true || insert.serverRevision !== undefined;
}

/**
 * Whether the one queued slot holds a recall's answer the input has not taken yet, whichever conversation it is for.
 * A place must not be added to it, and must not take the slot from it: the answer keeps its own meaning (it replaces,
 * and its revision is saved), and nothing waits behind it, because a wait that outlives the slot's owner would write
 * into a collection nobody checked, or over a newer answer. The person adds the place again a moment later.
 */
export function queuedServerAckBlocks(): boolean {
  const queued = useChatStore.getState().pendingChatInsert;
  return Boolean(queued && carriesServerAck(queued));
}
