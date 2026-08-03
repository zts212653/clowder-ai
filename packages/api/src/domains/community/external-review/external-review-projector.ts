import type { CommunityEvent, ExternalReviewAggregate } from '@cat-cafe/shared';
import {
  applyExternalReviewEvent,
  createExternalReviewAggregate,
  type ExternalReviewApplyResult,
} from './external-review-aggregate.js';

const EXTERNAL_REVIEW_EVENT_KINDS = new Set<CommunityEvent['kind']>([
  'case.external_review_assigned',
  'case.head_observed',
  'case.ci_observed',
  'case.cloud_review_observed',
  'case.review_ready',
  'case.reviewer_wake_delivered',
  'case.review_verdict_recorded',
]);

const EXTERNAL_REVIEW_TERMINAL_EVENT_KINDS = new Set<CommunityEvent['kind']>([
  'pr.merged',
  'pr.closed',
  'case.declined',
]);

export function isExternalReviewEventKind(kind: CommunityEvent['kind']): boolean {
  return EXTERNAL_REVIEW_EVENT_KINDS.has(kind);
}

export function isExternalReviewTerminalEventKind(kind: CommunityEvent['kind']): boolean {
  return EXTERNAL_REVIEW_TERMINAL_EVENT_KINDS.has(kind);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function readActionLeaseRef(value: unknown): { leaseId: string; generation: number } | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const lease = value as Record<string, unknown>;
  if (
    typeof lease.leaseId !== 'string' ||
    lease.leaseId.length === 0 ||
    typeof lease.generation !== 'number' ||
    !Number.isInteger(lease.generation) ||
    lease.generation <= 0
  ) {
    return undefined;
  }
  return { leaseId: lease.leaseId, generation: lease.generation };
}

export function applyExternalReviewProjectionEvent(
  current: ExternalReviewAggregate | null,
  event: CommunityEvent,
): ExternalReviewApplyResult | { readonly ok: false; readonly reason: 'aggregate_missing' | 'invalid_assignment' } {
  if (event.kind === 'case.external_review_assigned') {
    const { mode, cloudPolicy, reviewerCatId, reviewerThreadId, actionLeaseRef } = event.payload;
    const parsedLease = readActionLeaseRef(actionLeaseRef);
    if (
      (mode !== 'observe_only' && mode !== 'maintainer_review') ||
      (cloudPolicy !== 'optional' && cloudPolicy !== 'required') ||
      !isOptionalString(reviewerCatId) ||
      !isOptionalString(reviewerThreadId) ||
      parsedLease === undefined
    ) {
      return { ok: false, reason: 'invalid_assignment' };
    }

    const configured = createExternalReviewAggregate({
      mode,
      cloudPolicy,
      reviewerCatId: typeof reviewerCatId === 'string' ? reviewerCatId : null,
      reviewerThreadId: typeof reviewerThreadId === 'string' ? reviewerThreadId : null,
      actionLeaseRef: parsedLease ?? current?.actionLeaseRef ?? null,
    });
    return {
      ok: true,
      value: current
        ? {
            ...current,
            mode: configured.mode,
            cloudPolicy: configured.cloudPolicy,
            reviewerCatId: configured.reviewerCatId,
            reviewerThreadId: configured.reviewerThreadId,
            actionLeaseRef: configured.actionLeaseRef,
          }
        : configured,
    };
  }

  if (!current) return { ok: false, reason: 'aggregate_missing' };
  return applyExternalReviewEvent(current, event);
}
