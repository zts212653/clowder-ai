import { isDeepStrictEqual } from 'node:util';
import type { ApprovalOriginRef, TasteProposal } from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';

/** F221 has no system-origin exemption: the original message must belong to this owner and thread. */
export async function eligibleTasteOrigin(
  messages: Pick<IMessageStore, 'getById'> | undefined,
  messageId: string,
  owner: { userId: string; threadId: string },
): Promise<boolean> {
  const message = await messages?.getById(messageId);
  return Boolean(
    message &&
      !message.deletedAt &&
      !message._tombstone &&
      message.userId === owner.userId &&
      message.threadId === owner.threadId,
  );
}

/** Legacy event origins and inconsistent stored coordinates cannot be upgraded by a retry. */
export async function readTasteProposalOrigin(
  proposal: TasteProposal,
  messages: Pick<IMessageStore, 'getById'> | undefined,
): Promise<Extract<ApprovalOriginRef, { kind: 'message' }> | null> {
  const origin = proposal.approvalOriginRef;
  if (
    !origin ||
    origin.kind !== 'message' ||
    origin.threadId !== proposal.threadId ||
    (proposal.sourceMessageId !== undefined && proposal.sourceMessageId !== origin.messageId)
  )
    return null;
  if (
    proposal.publication?.state === 'anchored' &&
    (!isDeepStrictEqual(proposal.publication.envelope.originRef, origin) ||
      proposal.publication.envelope.approvalCardRef.threadId !== proposal.threadId)
  )
    return null;
  return (await eligibleTasteOrigin(messages, origin.messageId, proposal)) ? origin : null;
}
