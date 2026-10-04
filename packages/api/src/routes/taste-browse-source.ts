import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveThreadMessageVisibility } from '../domains/cats/services/stores/visibility.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import type { TasteMemoryReadResult } from '../domains/memory/taste/TasteMemoryReader.js';
import type { ITasteProposalStore } from '../domains/taste/stores/ports/TasteProposalStore.js';

export interface TasteSourceReaders {
  proposalStore: Pick<ITasteProposalStore, 'get'>;
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
  messageStore: Pick<IMessageStore, 'getById'>;
}

/** Provenance uses the settled proposal, never timestamp/quote searches. */
export async function readTasteSource(memory: TasteMemoryReadResult, owner: string, readers: TasteSourceReaders) {
  const unavailable = { status: 'unavailable', title: null, canOpen: false };
  const notRecorded = { status: 'not_recorded', title: null, canOpen: false };
  if (!memory.payload.proposalId) return notRecorded;
  const proposal = await readers.proposalStore.get(memory.payload.proposalId);
  if (!proposal) return unavailable;
  if (proposal.userId !== owner || proposal.status !== 'approved' || proposal.vignettePath !== memory.sourcePath)
    return unavailable;
  const origin = proposal.approvalOriginRef;
  const messageId =
    proposal.sourceMessageId ??
    (origin?.kind === 'message' && origin.threadId === proposal.threadId ? origin.messageId : undefined);
  if (!messageId) return notRecorded;
  const thread = await readers.threadStore.get(proposal.threadId);
  if (!thread || thread.deletedAt) return unavailable;
  if (!canAccessThread(thread, owner)) {
    if (thread.createdBy !== 'system' || !(await readers.threadStore.list(owner)).some((item) => item.id === thread.id))
      return unavailable;
  }
  const message = await readers.messageStore.getById(messageId);
  if (!message || message.threadId !== thread.id || message.userId !== owner || message.deletedAt) return unavailable;
  if (!resolveThreadMessageVisibility({ includeQueuedUserMessages: true }, owner)(message)) return unavailable;
  return {
    status: 'ready',
    title: thread.title?.trim() || null,
    canOpen: true,
    threadId: thread.id,
    messageId: message.id,
  };
}
