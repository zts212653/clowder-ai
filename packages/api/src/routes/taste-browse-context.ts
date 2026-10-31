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
    return { status: 'approved', proposedAt: proposal.createdAt, approvedAt: proposal.approvedAt ?? null };
  } catch {
    return { status: 'unavailable' };
  }
}
