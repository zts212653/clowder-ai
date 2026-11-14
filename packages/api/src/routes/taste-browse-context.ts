import type { TasteProposal } from '@cat-cafe/shared';
import { resolveThreadMessageVisibility } from '../domains/cats/services/stores/visibility.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import type { TasteMemoryReadResult } from '../domains/memory/taste/TasteMemoryReader.js';
import type { TasteRecallView } from './taste-browse-model.js';
import type { TasteSourceReaders } from './taste-browse-source.js';

/** Historical coordinates are readable only after current thread visibility is checked. */
export async function projectTasteContext(
  recall: TasteRecallView | null,
  owner: string,
  readers: TasteSourceReaders,
  titles: Map<string, Promise<{ title: string | null; threadId?: string }>>,
) {
  async function threadView(threadId: string) {
    const existing = titles.get(threadId);
    if (existing) return existing;
    const pending = readThread(threadId);
    titles.set(threadId, pending);
    return pending;
  }
  async function readThread(threadId: string) {
    try {
      const thread = await readers.threadStore.get(threadId);
      if (!thread || thread.deletedAt) return { title: null };
      const accessible =
        canAccessThread(thread, owner) ||
        (thread.createdBy === 'system' && (await readers.threadStore.list(owner)).some((t) => t.id === thread.id));
      return accessible ? { title: thread.title?.trim() || '对话 · 标题没有记录下来', threadId } : { title: null };
    } catch {
      return { title: null };
    }
  }
  if (!recall) return null;
  const named = recall.namedDelivery?.latest;
  const searched = recall.search?.latest;
  return {
    ...recall,
    namedDelivery: recall.namedDelivery
      ? {
          ...recall.namedDelivery,
          latest: named ? { at: named.at, outcome: named.outcome, ...(await threadView(named.threadId)) } : null,
        }
      : null,
    search: recall.search
      ? {
          ...recall.search,
          latest: searched
            ? { at: searched.at, outcome: searched.outcome, ...(await threadView(searched.threadId)) }
            : null,
        }
      : null,
  };
}

export async function readTasteApproval(memory: TasteMemoryReadResult, owner: string, readers: TasteSourceReaders) {
  if (!memory.payload.proposalId) return { status: 'not_recorded' };
  try {
    const proposal = await readers.proposalStore.get(memory.payload.proposalId);
    if (
      !proposal ||
      proposal.userId !== owner ||
      proposal.status !== 'approved' ||
      proposal.vignettePath !== memory.sourcePath
    )
      return { status: 'unavailable' };
    const href = await tasteApprovalHref(proposal, owner, readers);
    return {
      status: 'approved',
      proposedAt: proposal.createdAt,
      approvedAt: proposal.approvedAt ?? null,
      ...(href ? { href } : {}),
    };
  } catch {
    return { status: 'unavailable' };
  }
}

async function tasteApprovalHref(proposal: TasteProposal, owner: string, readers: TasteSourceReaders) {
  const card =
    proposal.publication?.state === 'anchored' &&
    proposal.publication.envelope.ownerUserId === owner &&
    proposal.publication.envelope.canonicalProposalId === proposal.id
      ? proposal.publication.envelope.approvalCardRef
      : null;
  let href: string | undefined;
  if (card) {
    const thread = await readers.threadStore.get(card.threadId);
    const visible =
      thread &&
      !thread.deletedAt &&
      (canAccessThread(thread, owner) ||
        (thread.createdBy === 'system' &&
          (await readers.threadStore.list(owner)).some((item) => item.id === thread.id)));
    if (visible) {
      const message = await readers.messageStore.getById(card.messageId);
      if (
        message &&
        message.threadId === card.threadId &&
        message.userId === owner &&
        !message.deletedAt &&
        resolveThreadMessageVisibility({ includeQueuedUserMessages: true }, owner)(message)
      )
        href = `/thread/${encodeURIComponent(card.threadId)}?message=${encodeURIComponent(card.messageId)}`;
    }
  }
  return href;
}
