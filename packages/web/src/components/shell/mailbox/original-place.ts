import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import {
  resolveArtifactReviewTarget,
  reviewSurfaceFromPreparedRef,
} from '@/components/workbench/artifact-review-surface';
import { resolveEntrustedWorkActionTarget } from '@/hooks/useWorkspaceNavigate';
import { APPROVAL_FEATURES } from '@/lib/approval-features';
import { readMailboxReviewSource } from './mailbox-review-match';
import { eligibleReceiptOf, isRecord } from './work-detail';

export type MailboxDestination = 'approval' | 'needs-me';

/**
 * Where a row can really take you from the 待办 panel.
 *  - `exact`: the source message, a collective-work result, or an owner-verified F309 prepared review in its F307 host.
 *  - `list`: the original list when this build has no verified exact source coordinate. A generic list is never
 *    presented as the exact place.
 */
export type OriginalPlace =
  | { kind: 'exact'; actionRef: string; host?: 'workspace' }
  | { kind: 'list'; destination: MailboxDestination };

const REACHABLE_FROM_PANEL = new Set(['message', 'collective-work', 'collective-accountability']);

function actionRefOf(item: UnifiedAttentionItemV1): string | null {
  const accountabilityRef = item.collectiveAccountabilityRequest?.actionRef;
  if (typeof accountabilityRef === 'string' && accountabilityRef.trim() !== '') return accountabilityRef;
  const action = eligibleReceiptOf(item)?.receipt.action;
  const ref = isRecord(action) ? action.actionRef : undefined;
  return typeof ref === 'string' && ref.trim() !== '' ? ref : null;
}

/** An id this build's catalog does not know (a newer producer) is not on an origin card as far as this build can tell. */
export function decidesOnOriginCard(featureId: string): boolean {
  const meta = (APPROVAL_FEATURES as Record<string, { decisionSurface?: string } | undefined>)[featureId];
  return meta?.decisionSurface === 'origin_card';
}

function approvalCardPlace(item: UnifiedAttentionItemV1): OriginalPlace {
  const navigation = item.approval?.navigation;
  if (navigation?.state === 'anchored') {
    const { threadId, messageId } = navigation.approvalCardRef;
    return { kind: 'exact', actionRef: `message:${threadId}:${messageId}` };
  }
  return { kind: 'list', destination: 'approval' };
}

export function resolveOriginalPlace(item: UnifiedAttentionItemV1): OriginalPlace {
  if (item.userMention)
    return { kind: 'exact', actionRef: `message:${item.userMention.threadId}:${item.userMention.messageId}` };
  if (item.runtimeInteraction) {
    const { threadId, messageId, blockId } = item.runtimeInteraction.cardRef;
    return { kind: 'exact', actionRef: `message:${threadId}:${messageId}#${blockId}` };
  }
  if (item.choiceRequest) {
    const { threadId, messageId, blockId } = item.choiceRequest.cardRef;
    return { kind: 'exact', actionRef: `message:${threadId}:${messageId}#${blockId}` };
  }
  if (item.kind === 'approval') return approvalCardPlace(item);
  const review = originalReviewPlace(item);
  if (review) return review;
  const actionRef = actionRefOf(item);
  const target = actionRef ? resolveEntrustedWorkActionTarget(actionRef) : null;
  return actionRef && target && REACHABLE_FROM_PANEL.has(target.kind)
    ? { kind: 'exact', actionRef }
    : { kind: 'list', destination: 'needs-me' };
}

/** Prepared review navigation is accepted only with the current typed F309 owner receipt. */
function originalReviewPlace(item: UnifiedAttentionItemV1): OriginalPlace | null {
  const entry = eligibleReceiptOf(item);
  const envelope = entry?.ownerRead.envelope;
  const visibility = isRecord(envelope) ? envelope.visibility : null;
  const owner = isRecord(visibility) ? visibility.ownerUserId : null;
  const review = typeof owner === 'string' ? readMailboxReviewSource(item, owner) : null;
  const prepared = entry?.ownerRead.preparedArtifact;
  const ref =
    isRecord(prepared) && typeof prepared.openInWorkspaceRef === 'string' ? prepared.openInWorkspaceRef : null;
  const surface = ref ? reviewSurfaceFromPreparedRef(ref) : null;
  const reviewTarget = surface && resolveArtifactReviewTarget(surface);
  const work = entry?.ownerRead.work;
  if (
    ref &&
    review &&
    reviewTarget &&
    reviewTarget.reviewId === review.reviewId &&
    isRecord(work) &&
    reviewTarget.threadId === work.threadId
  ) {
    return { kind: 'exact', host: 'workspace', actionRef: ref };
  }
  return null;
}
