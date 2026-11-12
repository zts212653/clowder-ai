import type { ContextAttachment } from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { getContextAttachmentDraft } from './thread-drafts';

/** One attachment per id, the later one winning. */
function mergeContextAttachments(
  first: readonly ContextAttachment[],
  second: readonly ContextAttachment[],
): ContextAttachment[] {
  return [...new Map([...first, ...second].map((attachment) => [attachment.id, attachment])).values()];
}

/** The input's places after an insert: removed ids go (or are replaced in place), new ones are added. */
export function applyContextAttachmentDelta(
  current: readonly ContextAttachment[],
  incoming: readonly ContextAttachment[],
  removedIds: ReadonlySet<string>,
): ContextAttachment[] {
  if (removedIds.size === 0) return mergeContextAttachments(current, incoming);

  const replacements = new Map(
    incoming.filter((attachment) => removedIds.has(attachment.id)).map((attachment) => [attachment.id, attachment]),
  );
  const consumed = new Set<string>();
  const next = current.flatMap((attachment) => {
    if (!removedIds.has(attachment.id)) return [attachment];
    const replacement = replacements.get(attachment.id);
    if (!replacement) return [];
    consumed.add(attachment.id);
    return [replacement];
  });
  const present = new Set(next.map((attachment) => attachment.id));

  for (const attachment of incoming) {
    if (consumed.has(attachment.id) || present.has(attachment.id)) continue;
    next.push(attachment);
    present.add(attachment.id);
  }
  return next;
}

/** What the composer holds right now: its stored draft with anything already queued for it applied on top. */
export function composerAttachments(threadId: string): ContextAttachment[] {
  const draft = [...getContextAttachmentDraft(threadId)];
  const queued = useChatStore.getState().pendingChatInsert;
  if (!queued || queued.threadId !== threadId) return draft;
  return applyContextAttachmentDelta(
    draft,
    queued.contextAttachments ?? [],
    new Set(queued.removeContextAttachmentIds ?? []),
  );
}
