import { createHash } from 'node:crypto';
import type {
  CommunityEvent,
  ExternalReviewAggregate,
  PendingExternalReviewVerdict,
  ReviewDeliveryOutcome,
} from '@cat-cafe/shared';
import type { ICommunityEventLog } from '../CommunityEventLog.js';
import type { ICommunityObjectStore } from '../CommunityObjectStore.js';
import type { ICommunityRepoConfigStore } from '../CommunityRepoConfigStore.js';
import {
  currentVerdictSubmissionEpoch,
  decideExternalReviewReadiness,
  externalReviewVerdictAuthorizationFailure,
  PENDING_VERIFICATION_REASONS,
} from './external-review-aggregate.js';

export { PENDING_VERIFICATION_REASONS } from './external-review-aggregate.js';
export type ExternalReviewVerdict = 'approved' | 'changes_requested' | 'commented';

export type ExternalReviewDeliveryInput =
  | { readonly kind: 'delivered'; readonly githubUrl: string }
  | { readonly kind: 'pending_delivery'; readonly reason: string };

export interface ExternalReviewVerdictRecordInput {
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly reviewedHeadSha: string;
  readonly verdict: ExternalReviewVerdict;
  readonly summary: string;
  readonly userNudgeRequired?: boolean;
  readonly delivery: ExternalReviewDeliveryInput;
  readonly principal: { readonly catId: string; readonly threadId: string };
  readonly actionLeaseRef?: { readonly leaseId: string; readonly generation: number };
}

export interface ExternalReviewVerdictRecordResult {
  readonly subjectKey: string;
  readonly headSha: string;
  readonly verdict: ExternalReviewVerdict;
  readonly delivery: ReviewDeliveryOutcome;
  readonly lifecycle: 'pending_verification' | 'pending_delivery' | 'delivered';
  readonly verification?: {
    readonly status: 'pending';
    readonly reason: PendingExternalReviewVerdict['verificationReason'];
    readonly submittedAt: number;
  };
}

export type ExternalPendingVerdictSettlementResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'waiting'; readonly reason: string }
  | { readonly kind: 'settled'; readonly result: ExternalReviewVerdictRecordResult };

export type ExternalReviewVerdictErrorCode =
  | 'not_configured'
  | 'observe_only'
  | 'stale_head'
  | 'projection_unavailable'
  | 'wrong_principal'
  | 'subject_terminal'
  | 'head_not_ready'
  | 'invalid_delivery_proof'
  | 'invalid_pending_reason'
  | 'delivery_regression'
  | 'verdict_conflict'
  | 'action_lease_required'
  | 'action_lease_mismatch'
  | 'action_lease_preflight_unavailable'
  | 'stale_action_lease';

export class ExternalReviewVerdictError extends Error {
  constructor(
    readonly code: ExternalReviewVerdictErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExternalReviewVerdictError';
  }
}

export interface ExternalReviewVerdictProjectorPort {
  apply(event: CommunityEvent): Promise<void>;
  rebuild(subjectKey: string): Promise<void>;
}

export interface ExternalReviewVerdictServiceOptions {
  readonly repoConfigStore: Pick<ICommunityRepoConfigStore, 'getByRepo'>;
  readonly eventLog: ICommunityEventLog;
  readonly projector: ExternalReviewVerdictProjectorPort;
  readonly objectStore: Pick<ICommunityObjectStore, 'get'>;
  readonly fetchCurrentHead: (repoFullName: string, prNumber: number) => Promise<string>;
  readonly preflightLease: (
    leaseId: string,
    generation: number,
    catId: string,
    terminalPredicateDigest: string,
  ) => Promise<{ readonly ok: boolean; readonly reason: string }>;
  readonly completeActionLease: (input: {
    leaseId: string;
    generation: number;
    catId: string;
    evidenceRefs: string[];
    now: number;
  }) => Promise<{ outcome: string }>;
  readonly recordUserNudgeRequired?: () => void;
  readonly now?: () => number;
}

export function isSameDelivery(left: ReviewDeliveryOutcome | null, right: ReviewDeliveryOutcome): boolean {
  if (!left || left.kind !== right.kind || left.headSha !== right.headSha) return false;
  return left.kind === 'delivered'
    ? left.githubUrl === (right as Extract<ReviewDeliveryOutcome, { kind: 'delivered' }>).githubUrl
    : left.ownerCatId === (right as Extract<ReviewDeliveryOutcome, { kind: 'pending_delivery' }>).ownerCatId &&
        left.reason === (right as Extract<ReviewDeliveryOutcome, { kind: 'pending_delivery' }>).reason;
}

export function isGitHubReviewDeliveryProof(urlText: string, repoFullName: string, prNumber: number): boolean {
  try {
    const url = new URL(urlText);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return false;
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    const expected = `/${repoFullName.toLowerCase()}/pull/${prNumber}`;
    if (path !== expected && path !== `${expected}/files`) return false;
    return /^#(?:pullrequestreview-|discussion_r|issuecomment-|r)\d+$/.test(url.hash.toLowerCase());
  } catch {
    return false;
  }
}

export function verdictFingerprint(input: ExternalReviewVerdictRecordInput, headGeneration: number): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        headSha: input.reviewedHeadSha,
        headGeneration,
        verdict: input.verdict,
        summary: input.summary.trim(),
        userNudgeRequired: input.userNudgeRequired === true,
        delivery: input.delivery,
      }),
    )
    .digest('hex')
    .slice(0, 24);
}

export function materializeExternalReviewDelivery(
  input: ExternalReviewVerdictRecordInput,
  headSha: string,
  recordedAt: number,
): ReviewDeliveryOutcome {
  if (input.delivery.kind === 'delivered') {
    if (!isGitHubReviewDeliveryProof(input.delivery.githubUrl, input.repoFullName, input.prNumber)) {
      throw new ExternalReviewVerdictError(
        'invalid_delivery_proof',
        'githubUrl must be a review or comment URL for the same repository and PR',
      );
    }
    return { kind: 'delivered', headSha, githubUrl: input.delivery.githubUrl, deliveredAt: recordedAt };
  }

  const reason = input.delivery.reason.trim();
  if (!reason) {
    throw new ExternalReviewVerdictError('invalid_pending_reason', 'pending_delivery requires a non-empty reason');
  }
  return { kind: 'pending_delivery', headSha, ownerCatId: input.principal.catId, reason, createdAt: recordedAt };
}

export async function loadCanonicalReviewDelivery(input: {
  objectStore: Pick<ICommunityObjectStore, 'get'>;
  projector: Pick<ExternalReviewVerdictProjectorPort, 'rebuild'>;
  subjectKey: string;
  delivery: ReviewDeliveryOutcome;
}): Promise<ReviewDeliveryOutcome> {
  let canonical = (await input.objectStore.get(input.subjectKey))?.externalReview;
  if (!canonical || !isSameDelivery(canonical.delivery, input.delivery)) {
    await input.projector.rebuild(input.subjectKey);
    canonical = (await input.objectStore.get(input.subjectKey))?.externalReview;
  }
  if (!canonical?.delivery || !isSameDelivery(canonical.delivery, input.delivery)) {
    throw new ExternalReviewVerdictError('projection_unavailable', 'Verdict event was not projected');
  }
  return canonical.delivery;
}

interface PendingExternalReviewVerdictInput {
  eventLog: ICommunityEventLog;
  projector: ExternalReviewVerdictProjectorPort;
  objectStore: Pick<ICommunityObjectStore, 'get'>;
  subjectKey: string;
  aggregate: ExternalReviewAggregate;
  currentHeadSha: string;
  headGeneration: number;
  submission: ExternalReviewVerdictRecordInput;
  delivery: ReviewDeliveryOutcome;
  actionLease: { readonly leaseId: string; readonly generation: number } | null;
  verificationReason: PendingExternalReviewVerdict['verificationReason'];
  submissionFingerprint: string;
  recordedAt: number;
}

function assertCompatiblePending(existing: PendingExternalReviewVerdict | null, fingerprint: string): void {
  if (existing && existing.fingerprint !== fingerprint) {
    throw new ExternalReviewVerdictError(
      'verdict_conflict',
      'A different verdict submission already awaits canonical verification for this HEAD generation',
    );
  }
}

function makePendingVerdictEvent(
  input: PendingExternalReviewVerdictInput,
  aggregate: ExternalReviewAggregate,
  verificationReason: PendingExternalReviewVerdict['verificationReason'],
): CommunityEvent {
  const submittedAt = aggregate.pendingVerdict?.submittedAt ?? input.recordedAt;
  const submissionEpoch = currentVerdictSubmissionEpoch(aggregate);
  const epochDiscriminator = submissionEpoch === 0 ? '' : `:e${submissionEpoch}`;
  return {
    sourceEventId: `f168:review-verdict-submitted:${input.subjectKey}:g${input.headGeneration}${epochDiscriminator}:${input.submissionFingerprint}`,
    subjectKey: input.subjectKey,
    kind: 'case.review_verdict_submitted',
    classification: 'informational',
    payload: {
      fingerprint: input.submissionFingerprint,
      headSha: input.currentHeadSha,
      headGeneration: input.headGeneration,
      verdict: input.submission.verdict,
      summary: input.submission.summary.trim(),
      userNudgeRequired: input.submission.userNudgeRequired === true,
      delivery: input.delivery,
      principal: input.submission.principal,
      actionLeaseRef: input.actionLease,
      verificationReason,
    },
    at: submittedAt,
  };
}

function pendingVerdictResult(
  input: PendingExternalReviewVerdictInput,
  aggregate: ExternalReviewAggregate,
): ExternalReviewVerdictRecordResult {
  const existing = aggregate.pendingVerdict;
  return {
    subjectKey: input.subjectKey,
    headSha: input.currentHeadSha,
    verdict: input.submission.verdict,
    delivery: existing?.delivery ?? input.delivery,
    lifecycle: 'pending_verification',
    verification: {
      status: 'pending',
      reason: existing?.verificationReason ?? input.verificationReason,
      submittedAt: existing?.submittedAt ?? input.recordedAt,
    },
  };
}

async function readRebuiltAggregate(input: PendingExternalReviewVerdictInput): Promise<ExternalReviewAggregate> {
  let aggregate: ExternalReviewAggregate | null | undefined;
  try {
    await input.projector.rebuild(input.subjectKey);
    aggregate = (await input.objectStore.get(input.subjectKey))?.externalReview;
  } catch {
    throw new ExternalReviewVerdictError('projection_unavailable', 'Pending verdict projection rebuild failed');
  }
  if (
    !aggregate ||
    aggregate.currentHeadSha !== input.currentHeadSha ||
    aggregate.headGeneration !== input.headGeneration
  ) {
    throw new ExternalReviewVerdictError('projection_unavailable', 'Rebuilt projection did not match the current HEAD');
  }
  const authorizationFailure = externalReviewVerdictAuthorizationFailure(
    aggregate,
    input.submission.principal,
    input.actionLease,
  );
  if (authorizationFailure) {
    throw new ExternalReviewVerdictError(authorizationFailure.code, authorizationFailure.message);
  }
  return aggregate;
}

async function applyAndVerifyPending(
  input: PendingExternalReviewVerdictInput,
  event: CommunityEvent,
): Promise<ExternalReviewAggregate> {
  await input.projector.apply(event);
  const aggregate = (await input.objectStore.get(input.subjectKey))?.externalReview;
  if (aggregate?.pendingVerdict?.fingerprint !== input.submissionFingerprint) {
    throw new ExternalReviewVerdictError(
      'projection_unavailable',
      'Durable pending verdict event was not represented by the current projection',
    );
  }
  return aggregate;
}

function currentPendingVerificationReason(
  aggregate: ExternalReviewAggregate,
): PendingExternalReviewVerdict['verificationReason'] {
  const readiness = decideExternalReviewReadiness(aggregate);
  if (
    readiness.kind !== 'wait' ||
    !PENDING_VERIFICATION_REASONS.has(readiness.reason as PendingExternalReviewVerdict['verificationReason'])
  ) {
    throw new ExternalReviewVerdictError('head_not_ready', 'Current HEAD is not awaiting bounded verification');
  }
  return readiness.reason as PendingExternalReviewVerdict['verificationReason'];
}

export async function recordPendingExternalReviewVerdict(
  input: PendingExternalReviewVerdictInput,
): Promise<ExternalReviewVerdictRecordResult> {
  assertCompatiblePending(input.aggregate.pendingVerdict, input.submissionFingerprint);
  const originalEpoch = currentVerdictSubmissionEpoch(input.aggregate);
  const event = makePendingVerdictEvent(input, input.aggregate, input.verificationReason);
  const { appended } = await input.eventLog.append(event);
  if (appended) {
    return pendingVerdictResult(input, await applyAndVerifyPending(input, event));
  }
  if (input.aggregate.pendingVerdict) return pendingVerdictResult(input, input.aggregate);

  const rebuilt = await readRebuiltAggregate(input);
  assertCompatiblePending(rebuilt.pendingVerdict, input.submissionFingerprint);
  if (rebuilt.pendingVerdict) return pendingVerdictResult(input, rebuilt);

  const rebuiltEpoch = currentVerdictSubmissionEpoch(rebuilt);
  const verificationReason = currentPendingVerificationReason(rebuilt);
  if (rebuiltEpoch <= originalEpoch) {
    throw new ExternalReviewVerdictError(
      'projection_unavailable',
      'Duplicate pending verdict was not replayable and has no later invalidation boundary',
    );
  }

  const repairedEvent = makePendingVerdictEvent(input, rebuilt, verificationReason);
  const repairedAppend = await input.eventLog.append(repairedEvent);
  if (repairedAppend.appended) {
    return pendingVerdictResult(input, await applyAndVerifyPending(input, repairedEvent));
  }

  const converged = await readRebuiltAggregate(input);
  assertCompatiblePending(converged.pendingVerdict, input.submissionFingerprint);
  if (!converged.pendingVerdict) {
    throw new ExternalReviewVerdictError('projection_unavailable', 'Concurrent repair did not converge');
  }
  return pendingVerdictResult(input, converged);
}
