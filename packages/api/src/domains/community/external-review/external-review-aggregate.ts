import type {
  CloudReviewPolicy,
  ExternalCiStatus,
  ExternalCloudReviewStatus,
  ExternalReviewAggregate,
  ExternalReviewMode,
  ReviewDeliveryOutcome,
} from '@cat-cafe/shared';

export interface CreateExternalReviewAggregateInput {
  readonly mode: ExternalReviewMode;
  readonly cloudPolicy: CloudReviewPolicy;
  readonly reviewerCatId?: string | null;
  readonly reviewerThreadId?: string | null;
  readonly actionLeaseRef?: { readonly leaseId: string; readonly generation: number } | null;
}

export type ExternalReviewAggregateEvent = {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly at: number;
};

export type ExternalReviewApplyResult =
  | { readonly ok: true; readonly value: ExternalReviewAggregate }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid_payload'
        | 'stale_head'
        | 'current_head_missing'
        | 'head_not_ready'
        | 'wake_not_pending'
        | 'delivery_outcome_required'
        | 'delivery_head_mismatch'
        | 'delivery_regression'
        | 'invalid_delivery_outcome'
        | 'observe_only'
        | 'unsupported_event';
    };

export type ExternalReviewReadinessDecision =
  | { readonly kind: 'ready'; readonly headSha: string }
  | {
      readonly kind: 'wait';
      readonly reason:
        | 'observe_only'
        | 'current_head_missing'
        | 'head_already_reviewed'
        | 'ci_not_observed'
        | 'ci_pending'
        | 'ci_failed'
        | 'cloud_review_required'
        | 'cloud_review_running'
        | 'cloud_review_blocking'
        | 'cloud_review_failed_or_timeout'
        | 'wake_already_requested_for_head';
    };

function decideCloudReadiness(
  state: ExternalReviewAggregate,
): Extract<ExternalReviewReadinessDecision, { kind: 'wait' }> | null {
  const cloud = currentFactMatches(state, state.cloud) ? state.cloud : null;
  if (!cloud || cloud.status === 'not_requested') {
    return state.cloudPolicy === 'required' ? { kind: 'wait', reason: 'cloud_review_required' } : null;
  }
  const reasonByStatus = {
    running: 'cloud_review_running',
    blocking: 'cloud_review_blocking',
    failed_or_timeout: 'cloud_review_failed_or_timeout',
  } as const;
  const reason = reasonByStatus[cloud.status as keyof typeof reasonByStatus];
  return reason ? { kind: 'wait', reason } : null;
}

export function createExternalReviewAggregate(input: CreateExternalReviewAggregateInput): ExternalReviewAggregate {
  return {
    mode: input.mode,
    cloudPolicy: input.cloudPolicy,
    lifecycle: 'assigned',
    currentHeadSha: null,
    headGeneration: 0,
    currentHeadObservedAt: null,
    lastReviewedHeadSha: null,
    lastReviewedHeadGeneration: null,
    lastDeliveredHeadSha: null,
    lastDeliveredHeadGeneration: null,
    ci: null,
    cloud: null,
    wake: null,
    delivery: null,
    reviewerCatId: input.reviewerCatId ?? null,
    reviewerThreadId: input.reviewerThreadId ?? null,
    actionLeaseRef: input.actionLeaseRef ?? null,
  };
}

function currentHeadGeneration(state: ExternalReviewAggregate): number {
  return readPositiveInteger(state.headGeneration) ?? (state.currentHeadSha ? 1 : 0);
}

function eventHeadGeneration(state: ExternalReviewAggregate, payload: Record<string, unknown>): number | null {
  if (payload.headGeneration === undefined) return currentHeadGeneration(state);
  return readPositiveInteger(payload.headGeneration) ?? null;
}

function currentFactMatches(
  state: ExternalReviewAggregate,
  fact: { readonly headSha: string; readonly headGeneration?: number } | null,
): boolean {
  if (!fact || fact.headSha !== state.currentHeadSha) return false;
  return (readPositiveInteger(fact.headGeneration) ?? currentHeadGeneration(state)) === currentHeadGeneration(state);
}

export function decideExternalReviewReadiness(state: ExternalReviewAggregate): ExternalReviewReadinessDecision {
  if (state.mode !== 'maintainer_review') return { kind: 'wait', reason: 'observe_only' };
  const headSha = state.currentHeadSha;
  if (!headSha) return { kind: 'wait', reason: 'current_head_missing' };
  const generation = currentHeadGeneration(state);
  const reviewedGeneration =
    readPositiveInteger(state.lastReviewedHeadGeneration) ??
    (state.lastReviewedHeadSha === headSha ? generation : null);
  if (state.lastReviewedHeadSha === headSha && reviewedGeneration === generation) {
    return { kind: 'wait', reason: 'head_already_reviewed' };
  }
  const ci = state.ci;
  if (!currentFactMatches(state, ci)) return { kind: 'wait', reason: 'ci_not_observed' };
  if (ci?.status === 'pending') return { kind: 'wait', reason: 'ci_pending' };
  if (ci?.status === 'fail') return { kind: 'wait', reason: 'ci_failed' };

  const cloudDecision = decideCloudReadiness(state);
  if (cloudDecision) return cloudDecision;

  if (currentFactMatches(state, state.wake)) {
    return { kind: 'wait', reason: 'wake_already_requested_for_head' };
  }
  return { kind: 'ready', headSha };
}

function readHeadSha(payload: Record<string, unknown>): string | null {
  const headSha = payload.headSha;
  return typeof headSha === 'string' && headSha.trim().length > 0 ? headSha : null;
}

function isCiStatus(value: unknown): value is ExternalCiStatus {
  return value === 'pending' || value === 'pass' || value === 'fail';
}

function isCloudStatus(value: unknown): value is ExternalCloudReviewStatus {
  return (
    value === 'not_requested' ||
    value === 'running' ||
    value === 'blocking' ||
    value === 'clean' ||
    value === 'failed_or_timeout'
  );
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readDeliveryOutcome(value: unknown): ReviewDeliveryOutcome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const delivery = value as Record<string, unknown>;
  const headSha = readHeadSha(delivery);
  if (!headSha) return null;

  if (delivery.kind === 'delivered') {
    if (
      typeof delivery.githubUrl !== 'string' ||
      !delivery.githubUrl.startsWith('https://github.com/') ||
      typeof delivery.deliveredAt !== 'number' ||
      !Number.isFinite(delivery.deliveredAt)
    ) {
      return null;
    }
    return {
      kind: 'delivered',
      headSha,
      githubUrl: delivery.githubUrl,
      deliveredAt: delivery.deliveredAt,
    };
  }

  if (delivery.kind === 'pending_delivery') {
    if (
      typeof delivery.ownerCatId !== 'string' ||
      delivery.ownerCatId.trim().length === 0 ||
      typeof delivery.reason !== 'string' ||
      delivery.reason.trim().length === 0 ||
      typeof delivery.createdAt !== 'number' ||
      !Number.isFinite(delivery.createdAt)
    ) {
      return null;
    }
    return {
      kind: 'pending_delivery',
      headSha,
      ownerCatId: delivery.ownerCatId,
      reason: delivery.reason,
      createdAt: delivery.createdAt,
    };
  }

  return null;
}

function applyHeadObserved(
  state: ExternalReviewAggregate,
  event: ExternalReviewAggregateEvent,
): ExternalReviewApplyResult {
  const headSha = readHeadSha(event.payload);
  if (!headSha) return { ok: false, reason: 'invalid_payload' };
  const currentGeneration = currentHeadGeneration(state);
  const explicitGeneration =
    event.payload.headGeneration === undefined ? undefined : readPositiveInteger(event.payload.headGeneration);
  if (event.payload.headGeneration !== undefined && explicitGeneration === undefined) {
    return { ok: false, reason: 'invalid_payload' };
  }
  if (
    state.currentHeadSha === headSha &&
    (explicitGeneration === undefined || explicitGeneration === currentGeneration)
  ) {
    return state.headGeneration === currentGeneration
      ? { ok: true, value: state }
      : { ok: true, value: { ...state, headGeneration: currentGeneration } };
  }
  const nextGeneration = explicitGeneration ?? currentGeneration + 1;
  if (nextGeneration <= currentGeneration) return { ok: false, reason: 'stale_head' };
  return {
    ok: true,
    value: {
      ...state,
      lifecycle: 'awaiting_ci',
      currentHeadSha: headSha,
      headGeneration: nextGeneration,
      currentHeadObservedAt: event.at,
      ci: null,
      cloud: null,
      wake: null,
      delivery: null,
    },
  };
}

function applyCiObserved(
  state: ExternalReviewAggregate,
  event: ExternalReviewAggregateEvent,
): ExternalReviewApplyResult {
  const headSha = readHeadSha(event.payload);
  if (!headSha || !isCiStatus(event.payload.status)) return { ok: false, reason: 'invalid_payload' };
  const generation = eventHeadGeneration(state, event.payload);
  if (generation === null) return { ok: false, reason: 'invalid_payload' };
  if (headSha !== state.currentHeadSha || generation !== currentHeadGeneration(state)) {
    return { ok: false, reason: 'stale_head' };
  }

  const status = event.payload.status;
  const needsCloud = status === 'pass' && state.cloudPolicy === 'required' && !currentFactMatches(state, state.cloud);
  return {
    ok: true,
    value: {
      ...state,
      lifecycle: status === 'pass' && needsCloud ? 'awaiting_cloud_review' : 'awaiting_ci',
      ci: { headSha, headGeneration: generation, status, observedAt: event.at },
    },
  };
}

function applyCloudObserved(
  state: ExternalReviewAggregate,
  event: ExternalReviewAggregateEvent,
): ExternalReviewApplyResult {
  const headSha = readHeadSha(event.payload);
  if (!headSha || !isCloudStatus(event.payload.status)) return { ok: false, reason: 'invalid_payload' };
  const generation = eventHeadGeneration(state, event.payload);
  if (generation === null) return { ok: false, reason: 'invalid_payload' };
  if (headSha !== state.currentHeadSha || generation !== currentHeadGeneration(state)) {
    return { ok: false, reason: 'stale_head' };
  }

  const status = event.payload.status;
  const lifecycle =
    status === 'blocking'
      ? 'awaiting_author'
      : status === 'running' || status === 'failed_or_timeout'
        ? 'awaiting_cloud_review'
        : currentFactMatches(state, state.ci) && state.ci?.status === 'pass'
          ? state.lifecycle
          : 'awaiting_ci';
  return {
    ok: true,
    value: {
      ...state,
      lifecycle,
      cloud: {
        headSha,
        headGeneration: generation,
        status,
        ...(readPositiveInteger(event.payload.triggerCommentId) !== undefined
          ? { triggerCommentId: readPositiveInteger(event.payload.triggerCommentId) }
          : {}),
        ...(readPositiveInteger(event.payload.reviewId) !== undefined
          ? { reviewId: readPositiveInteger(event.payload.reviewId) }
          : {}),
        observedAt: event.at,
      },
    },
  };
}

function applyReviewReady(
  state: ExternalReviewAggregate,
  event: ExternalReviewAggregateEvent,
): ExternalReviewApplyResult {
  const headSha = readHeadSha(event.payload);
  if (!headSha) return { ok: false, reason: 'invalid_payload' };
  const generation = eventHeadGeneration(state, event.payload);
  if (generation === null) return { ok: false, reason: 'invalid_payload' };
  if (headSha !== state.currentHeadSha || generation !== currentHeadGeneration(state)) {
    return { ok: false, reason: 'stale_head' };
  }
  const decision = decideExternalReviewReadiness(state);
  if (decision.kind !== 'ready') return { ok: false, reason: 'head_not_ready' };
  return {
    ok: true,
    value: {
      ...state,
      lifecycle: 'rereview_required',
      wake: { headSha, headGeneration: generation, status: 'pending', requestedAt: event.at },
    },
  };
}

function applyWakeDelivered(
  state: ExternalReviewAggregate,
  event: ExternalReviewAggregateEvent,
): ExternalReviewApplyResult {
  const headSha = readHeadSha(event.payload);
  const messageId = event.payload.messageId;
  if (!headSha || typeof messageId !== 'string' || messageId.length === 0) {
    return { ok: false, reason: 'invalid_payload' };
  }
  const generation = eventHeadGeneration(state, event.payload);
  if (generation === null) return { ok: false, reason: 'invalid_payload' };
  if (headSha !== state.currentHeadSha || generation !== currentHeadGeneration(state)) {
    return { ok: false, reason: 'stale_head' };
  }
  const wake = state.wake;
  if (!wake || !currentFactMatches(state, wake)) return { ok: false, reason: 'wake_not_pending' };
  return {
    ok: true,
    value: {
      ...state,
      wake: { ...wake, status: 'delivered', messageId, deliveredAt: event.at },
    },
  };
}

function applyVerdictRecorded(
  state: ExternalReviewAggregate,
  event: ExternalReviewAggregateEvent,
): ExternalReviewApplyResult {
  const headSha = readHeadSha(event.payload);
  if (!headSha) return { ok: false, reason: 'invalid_payload' };
  const generation = eventHeadGeneration(state, event.payload);
  if (generation === null) return { ok: false, reason: 'invalid_payload' };
  if (headSha !== state.currentHeadSha || generation !== currentHeadGeneration(state)) {
    return { ok: false, reason: 'stale_head' };
  }
  if (!('delivery' in event.payload)) return { ok: false, reason: 'delivery_outcome_required' };
  const delivery = readDeliveryOutcome(event.payload.delivery);
  if (!delivery) return { ok: false, reason: 'invalid_delivery_outcome' };
  if (delivery.headSha !== headSha) return { ok: false, reason: 'delivery_head_mismatch' };
  if (state.delivery?.kind === 'delivered' && delivery.kind === 'pending_delivery') {
    return { ok: false, reason: 'delivery_regression' };
  }
  if (state.mode !== 'maintainer_review') return { ok: false, reason: 'observe_only' };
  if (
    state.lifecycle !== 'rereview_required' &&
    state.lifecycle !== 'pending_delivery' &&
    state.lifecycle !== 'delivered'
  ) {
    return { ok: false, reason: 'head_not_ready' };
  }

  return {
    ok: true,
    value: {
      ...state,
      lifecycle: delivery.kind === 'delivered' ? 'delivered' : 'pending_delivery',
      lastReviewedHeadSha: headSha,
      lastReviewedHeadGeneration: generation,
      lastDeliveredHeadSha: delivery.kind === 'delivered' ? headSha : state.lastDeliveredHeadSha,
      lastDeliveredHeadGeneration: delivery.kind === 'delivered' ? generation : state.lastDeliveredHeadGeneration,
      delivery,
    },
  };
}

export function applyExternalReviewEvent(
  state: ExternalReviewAggregate,
  event: ExternalReviewAggregateEvent,
): ExternalReviewApplyResult {
  switch (event.kind) {
    case 'case.head_observed':
      return applyHeadObserved(state, event);
    case 'case.ci_observed':
      return applyCiObserved(state, event);
    case 'case.cloud_review_observed':
      return applyCloudObserved(state, event);
    case 'case.review_ready':
      return applyReviewReady(state, event);
    case 'case.reviewer_wake_delivered':
      return applyWakeDelivered(state, event);
    case 'case.review_verdict_recorded':
      return applyVerdictRecorded(state, event);
    case 'pr.merged':
    case 'pr.closed':
    case 'case.declined':
      return { ok: true, value: { ...state, lifecycle: 'terminal', wake: null } };
    default:
      return { ok: false, reason: 'unsupported_event' };
  }
}
