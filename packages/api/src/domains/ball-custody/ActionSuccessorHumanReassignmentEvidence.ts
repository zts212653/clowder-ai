import { messageFrom } from '../cats/services/stores/message-from.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import { deriveGrowingSourceMessageRevision } from '../cats/services/stores/ports/MessageStore.js';
import type { ActionSuccessorHumanReassignmentEvidence } from './ActionSuccessorAdmissionContract.js';

const messageRefPattern = /^message:([^\s:][^\s]{0,159})$/;

/**
 * Turn a caller-named source into server-custodied evidence. This validates
 * identity and location only; prose is deliberately never parsed into a grant.
 */
export async function resolveActionSuccessorHumanReassignmentEvidence(input: {
  messageStore: Pick<IMessageStore, 'getById'>;
  groundingEvidenceRef: string | undefined;
  userId: string;
  childThreadId: string;
  now: number;
}): Promise<ActionSuccessorHumanReassignmentEvidence | undefined> {
  const match = input.groundingEvidenceRef ? messageRefPattern.exec(input.groundingEvidenceRef) : null;
  const sourceMessageId = match?.[1];
  if (!sourceMessageId) return undefined;
  const source = await input.messageStore.getById(sourceMessageId);
  if (
    !source ||
    source.id !== sourceMessageId ||
    source.userId !== input.userId ||
    source.threadId !== input.childThreadId ||
    messageFrom(source).kind !== 'user' ||
    source.deletedAt ||
    source._tombstone ||
    source.source ||
    source.timestamp > input.now
  ) {
    return undefined;
  }
  const sourceMessageRevision = deriveGrowingSourceMessageRevision(source);
  return {
    sourceMessageId,
    sourceMessageRevision,
    evidenceRef: `human-reassignment:message:${sourceMessageId}:${sourceMessageRevision}`,
    userId: source.userId,
    threadId: source.threadId,
    authoredAt: source.timestamp,
  };
}
