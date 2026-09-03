import { createCatId } from '@cat-cafe/shared';
import type { IInvocationRecordStore } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../cats/services/stores/ports/TurnExecutionStore.js';
import { canonicalizeActionSubjectRef } from './action-successor-state-machine.js';

export interface LegacyLocalReviewSourceResolverDeps {
  messageStore: Pick<IMessageStore, 'getById'>;
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>;
  turnExecutionStore: Pick<ITurnExecutionStore, 'get'>;
}

export interface ResolvedLegacyLocalReviewSource {
  source: StoredMessage;
  subjectRef: string;
  reviewerCatId: string;
  leaseRef: { leaseId: string; generation: number };
}

function resolveTerminalMessage(
  message: StoredMessage | null,
  ownerUserId: string,
): Omit<ResolvedLegacyLocalReviewSource, 'leaseRef'> | null {
  if (!message || message.userId !== ownerUserId || !message.catId) return null;
  if (message.extra?.localReviewVerdict || message.extra?.legacyLocalReviewDisposition) return null;
  const coordination = message.extra?.coordination;
  if (coordination?.phase !== 'terminal' || !coordination.subjectRef) return null;
  try {
    return {
      source: message,
      subjectRef: canonicalizeActionSubjectRef(coordination.subjectRef),
      reviewerCatId: message.catId,
    };
  } catch {
    return null;
  }
}

export async function resolveLegacyLocalReviewSource(
  deps: LegacyLocalReviewSourceResolverDeps,
  sourceMessageId: string,
  ownerUserId: string,
): Promise<ResolvedLegacyLocalReviewSource | null> {
  const resolved = resolveTerminalMessage(await deps.messageStore.getById(sourceMessageId), ownerUserId);
  if (!resolved) return null;
  const sourceInvocationId = resolved.source.extra?.crossPost?.sourceInvocationId;
  const sourceThreadId = resolved.source.extra?.crossPost?.sourceThreadId;
  if (
    !sourceInvocationId ||
    !sourceThreadId ||
    resolved.source.extra?.stream?.turnInvocationId !== sourceInvocationId
  ) {
    return null;
  }
  const turn = await deps.turnExecutionStore.get(sourceInvocationId);
  if (
    !turn ||
    turn.invocationId !== sourceInvocationId ||
    turn.threadId !== sourceThreadId ||
    turn.userId !== ownerUserId ||
    turn.catId !== resolved.reviewerCatId
  ) {
    return null;
  }
  const parent = await deps.invocationRecordStore.get(turn.parentInvocationId);
  const leaseRef = parent?.actionLeaseCarrier;
  if (
    !parent ||
    parent.id !== turn.parentInvocationId ||
    parent.threadId !== sourceThreadId ||
    parent.userId !== ownerUserId ||
    !parent.targetCats.includes(createCatId(resolved.reviewerCatId)) ||
    leaseRef?.kind !== 'action_successor'
  ) {
    return null;
  }
  return {
    ...resolved,
    leaseRef: { leaseId: leaseRef.leaseId, generation: leaseRef.generation },
  };
}
