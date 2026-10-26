import type { ISessionChainStore } from '../cats/services/stores/ports/SessionChainStore.js';
import type { ISessionHandoffProposalStore } from '../cats/services/stores/ports/SessionHandoffProposalStore.js';

export interface SessionHandoffWaitSourceDeps {
  readonly handoffProposalStore?: Pick<ISessionHandoffProposalStore, 'get'>;
  readonly sessionChainStore?: Pick<ISessionChainStore, 'get'>;
}

/** Re-read the original owners; an arbitrary private entry or the latest message is never a grant. */
export async function resolveSessionHandoffWaitSource(
  ref: { readonly proposalId: string; readonly continuationEntryId: string; readonly sourceSessionId?: string },
  principal: { readonly userId: string; readonly catId: string; readonly threadId: string },
  deps: SessionHandoffWaitSourceDeps,
): Promise<{ readonly sourceMessageId: string; readonly sourceSessionId: string } | undefined> {
  const proposal = await deps.handoffProposalStore?.get(ref.proposalId);
  if (
    !proposal ||
    proposal.proposalId !== ref.proposalId ||
    proposal.status !== 'approved' ||
    proposal.userId !== principal.userId ||
    proposal.sourceCatId !== principal.catId ||
    proposal.sourceThreadId !== principal.threadId ||
    !proposal.sourceMessageId ||
    proposal.continuationEntryId !== ref.continuationEntryId ||
    proposal.sealedSessionId !== proposal.sourceSessionId ||
    (ref.sourceSessionId !== undefined && ref.sourceSessionId !== proposal.sourceSessionId)
  )
    return undefined;
  const session = await deps.sessionChainStore?.get(proposal.sourceSessionId);
  if (
    !session ||
    session.id !== proposal.sourceSessionId ||
    session.userId !== principal.userId ||
    session.catId !== principal.catId ||
    session.threadId !== principal.threadId ||
    session.status !== 'sealed' ||
    session.sealReason !== 'cat_initiated_handoff' ||
    session.catHandoffNote?.proposalId !== proposal.proposalId ||
    session.catHandoffNote.sourceSessionId !== session.id
  )
    return undefined;
  return { sourceMessageId: proposal.sourceMessageId, sourceSessionId: session.id };
}
