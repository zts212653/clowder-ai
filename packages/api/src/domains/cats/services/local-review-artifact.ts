import { isValidAcceptedSource, isValidReviewSubjectRef, type LocalReviewVerdict } from '@cat-cafe/shared';
import type { StoredMessage } from './stores/ports/MessageStore.js';

const FULL_GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface DurableLocalReviewFact {
  readonly messageId: string;
  readonly threadId: string;
  readonly reviewerCatId: string;
  readonly reviewSubjectRef: string;
  readonly acceptedSourceRef: string;
  readonly acceptedRevision: string;
  readonly reviewedHeadSha: string;
  readonly verdict: LocalReviewVerdict;
  readonly clientMessageId: string;
  readonly evidenceRef: string;
}

export function readDurableLocalReviewFact(
  message: Pick<StoredMessage, 'id' | 'threadId' | 'catId' | 'extra'>,
): DurableLocalReviewFact | null {
  const artifact = message.extra?.localReviewVerdict;
  if (
    !artifact ||
    !message.catId ||
    !artifact.reviewedHeadSha ||
    !FULL_GIT_REVISION.test(artifact.reviewedHeadSha) ||
    !artifact.reviewSubjectRef ||
    !isValidReviewSubjectRef(artifact.reviewSubjectRef) ||
    !artifact.acceptedSourceRef ||
    !artifact.acceptedRevision ||
    !isValidAcceptedSource(artifact.acceptedSourceRef, artifact.acceptedRevision)
  ) {
    return null;
  }

  return {
    messageId: message.id,
    threadId: message.threadId,
    reviewerCatId: message.catId,
    reviewSubjectRef: artifact.reviewSubjectRef,
    acceptedSourceRef: artifact.acceptedSourceRef,
    acceptedRevision: artifact.acceptedRevision,
    reviewedHeadSha: artifact.reviewedHeadSha,
    verdict: artifact.verdict,
    clientMessageId: artifact.clientMessageId,
    evidenceRef: `local-review:${message.id}:${artifact.verdict}`,
  };
}

export type LocalReviewLoopBrake =
  | { readonly kind: 'pause_once'; readonly formalChangesRequested: number }
  | { readonly kind: 'continue'; readonly formalChangesRequested: number }
  | { readonly kind: 'warn_open'; readonly reason: string };

export function classifyLocalReviewLoopBrake(
  history: readonly DurableLocalReviewFact[] | null,
  newMessageIds: readonly string[],
  reviewSubjectRef: string,
  authorCatId: string,
): LocalReviewLoopBrake {
  if (history === null) {
    return { kind: 'warn_open', reason: 'durable local-review history unavailable' };
  }

  const formal = history.filter(
    (fact) =>
      fact.reviewSubjectRef === reviewSubjectRef &&
      fact.reviewerCatId !== authorCatId &&
      fact.verdict === 'changes_requested',
  );
  const newIds = new Set(newMessageIds);
  const previousCount = formal.filter((fact) => !newIds.has(fact.messageId)).length;
  return previousCount < 4 && formal.length >= 4
    ? { kind: 'pause_once', formalChangesRequested: formal.length }
    : { kind: 'continue', formalChangesRequested: formal.length };
}
