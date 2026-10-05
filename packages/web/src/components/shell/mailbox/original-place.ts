import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { resolveEntrustedWorkActionTarget } from '@/hooks/useWorkspaceNavigate';
import { APPROVAL_FEATURES } from '@/lib/approval-features';
import { eligibleReceiptOf, isRecord } from './work-detail';

export type MailboxDestination = 'approval' | 'needs-me';

/**
 * Where a row can really take you from the 待办 panel.
 *  - `exact`: a place `navigateToEntrustedWorkAction` can reach without the workspace's own surface machinery — the
 *    source message (with its block) or a collective-work result.
 *  - `list`: the original list. Approvals, meeting-intake repairs and artifact reviews are located through F307 workspace
 *    surfaces that exist only inside the workspace host, so the panel does not claim to find the one item; it says so
 *    and opens the list that owns it. A generic list is never presented as the exact place.
 */
export type OriginalPlace = { kind: 'exact'; actionRef: string } | { kind: 'list'; destination: MailboxDestination };

const REACHABLE_FROM_PANEL = new Set(['message', 'collective-work']);

function actionRefOf(item: UnifiedAttentionItemV1): string | null {
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
  if (item.approval && decidesOnOriginCard(item.approval.sourceFeatureId) && navigation?.state === 'anchored') {
    const { threadId, messageId } = navigation.approvalCardRef;
    return { kind: 'exact', actionRef: `message:${threadId}:${messageId}` };
  }
  return { kind: 'list', destination: 'approval' };
}

export function resolveOriginalPlace(item: UnifiedAttentionItemV1): OriginalPlace {
  if (item.kind === 'approval') return approvalCardPlace(item);
  const actionRef = actionRefOf(item);
  const target = actionRef ? resolveEntrustedWorkActionTarget(actionRef) : null;
  return actionRef && target && REACHABLE_FROM_PANEL.has(target.kind)
    ? { kind: 'exact', actionRef }
    : { kind: 'list', destination: 'needs-me' };
}
