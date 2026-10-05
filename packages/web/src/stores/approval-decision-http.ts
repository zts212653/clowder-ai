'use client';

/**
 * F246: what the Approval Hub's decision requests share: endpoint routing, the error body a producer answers with, and the
 * small pure helpers the decision actions and the batch actions both use.
 */

import type { ApprovalHubItem, EntityConflictContext, EntityConflictResolutionRequest } from '@cat-cafe/shared';
import { approvalFeatureMeta } from '@/lib/approval-features';
import { DecisionNotSent } from './approval-decision-attempts';

/**
 * Per-feature endpoint routing for approve/reject actions. Dedicated decision
 * routes live in the exhaustive client registry; all others use the default.
 */
/** Default endpoint for features without a dedicated decision route. */
const DEFAULT_ENDPOINT_BASE = '/api/dispatch-proposals';

export function resolveEndpoint(
  featureId: ApprovalHubItem['sourceFeatureId'] | undefined,
  proposalId: string,
  action: 'approve' | 'reject',
): string {
  const metadata = featureId ? approvalFeatureMeta(featureId) : undefined;
  if (metadata?.decisionSurface === 'origin_card') {
    throw new DecisionNotSent(`${featureId} decisions are available only on the canonical origin card`);
  }
  const base = metadata?.decisionEndpointBase ?? DEFAULT_ENDPOINT_BASE;
  return `${base}/${proposalId}/${action}`;
}

export interface DecisionErrorBody {
  error?: string;
  detail?: string;
  message?: string;
  conflict?: EntityConflictContext | null;
}

export interface EntityResolutionSuccessBody {
  proposalId: string;
  entityId: string;
  status: 'approved';
}

export const ENTITY_RESOLUTION_ACTION_LABELS: Record<EntityConflictResolutionRequest['action'], string> = {
  'merge-aliases': '合并别名',
  replace: '明确替换',
  correct: '纠错归并',
  transfer: '转移归属',
  polysemy: '多义并存',
};

export function decisionErrorMessage(body: DecisionErrorBody, fallback: string): string {
  const summary = body.message ?? body.error ?? fallback;
  return body.detail ? `${summary}: ${body.detail}` : summary;
}

export function stablePersonMemoryDecisionId(
  proposalId: string,
  action: 'approve' | 'not-now' | 'reject' | 'withdraw',
  selectedDraftIds: string[] = [],
): string {
  const input = `${proposalId}\0${action}\0${[...selectedDraftIds].sort().join('\0')}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `f276_${action.replace('-', '_')}_${(hash >>> 0).toString(16)}`;
}

/** Map of proposalId → what the Hub is doing to it, for optimistic UI feedback. */
export type DecidingMap = Record<string, 'approving' | 'rejecting' | 'resolving' | 'deferring' | 'withdrawing'>;

export function withoutDecision(deciding: DecidingMap, proposalId: string): DecidingMap {
  const next = { ...deciding };
  delete next[proposalId];
  return next;
}

export function applyConflictFeedback(
  items: ApprovalHubItem[],
  proposalId: string,
  conflict: EntityConflictContext,
  message: string,
): ApprovalHubItem[] {
  return items.map((item) =>
    item.proposalId === proposalId ? { ...item, detail: { ...item.detail, conflict, conflictError: message } } : item,
  );
}
