import { createHash } from 'node:crypto';
import type { CommunityEvent, ExternalReviewAggregate, ReviewDeliveryOutcome } from '@cat-cafe/shared';
import { prSubjectKey } from '@cat-cafe/shared';
import {
  externalCaseUserNudgeRequired,
  externalCaseVerdictRecorded,
} from '../../../infrastructure/telemetry/instruments.js';
import { canonicalizeActionTerminalPredicate } from '../../ball-custody/ActionTerminalPredicateCatalog.js';
import type { ICommunityEventLog } from '../CommunityEventLog.js';
import type { ICommunityObjectStore } from '../CommunityObjectStore.js';
import type { ICommunityRepoConfigStore } from '../CommunityRepoConfigStore.js';

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
  /** Explicit provenance: the operator had to remind the assigned reviewer for this generation. */
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
  readonly lifecycle: 'pending_delivery' | 'delivered';
}

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

interface ExternalReviewVerdictProjectorPort {
  apply(event: CommunityEvent): Promise<void>;
  rebuild(subjectKey: string): Promise<void>;
}

interface ActionLeasePreflightResult {
  readonly ok: boolean;
  readonly reason: string;
}

interface PreflightedActionLease {
  readonly leaseId: string;
  readonly generation: number;
  readonly reason: string;
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
  ) => Promise<ActionLeasePreflightResult>;
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

function isReadyForVerdict(state: ExternalReviewAggregate): boolean {
  return (
    state.lifecycle === 'rereview_required' || state.lifecycle === 'pending_delivery' || state.lifecycle === 'delivered'
  );
}

function isSameDelivery(left: ReviewDeliveryOutcome | null, right: ReviewDeliveryOutcome): boolean {
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

function fingerprint(input: ExternalReviewVerdictRecordInput, headGeneration: number): string {
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

export class ExternalReviewVerdictService {
  private readonly now: () => number;

  constructor(private readonly opts: ExternalReviewVerdictServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  async record(input: ExternalReviewVerdictRecordInput): Promise<ExternalReviewVerdictRecordResult> {
    const subjectKey = prSubjectKey(input.repoFullName, input.prNumber);
    const { aggregate, currentHeadSha, headGeneration } = await this.loadReadyAggregate(input, subjectKey);
    if (aggregate.delivery?.kind === 'delivered' && input.delivery.kind === 'pending_delivery') {
      throw new ExternalReviewVerdictError(
        'delivery_regression',
        'A delivered current-HEAD verdict cannot return to pending_delivery',
      );
    }
    const completionPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: subjectKey,
      predicate: { kind: 'review_delivered', headSha: currentHeadSha },
    });
    const actionLease = await this.preflightActionLease(
      aggregate,
      input.actionLeaseRef,
      input.principal.catId,
      completionPredicate.digest,
    );
    if (actionLease?.reason === 'verified_success' && input.delivery.kind === 'pending_delivery') {
      throw new ExternalReviewVerdictError(
        'delivery_regression',
        'A custody-verified current-HEAD verdict cannot return to pending_delivery',
      );
    }

    const recordedAt = this.now();
    const delivery = this.materializeDelivery(input, currentHeadSha, recordedAt);
    if (delivery.kind === 'delivered' && actionLease) {
      const completion = await this.opts.completeActionLease({
        leaseId: actionLease.leaseId,
        generation: actionLease.generation,
        catId: input.principal.catId,
        evidenceRefs: [`github:${delivery.githubUrl}`],
        now: recordedAt,
      });
      if (completion.outcome !== 'committed') {
        throw new ExternalReviewVerdictError(
          'stale_action_lease',
          `Action lease completion was not committed: ${completion.outcome}`,
        );
      }
    }

    const event: CommunityEvent = {
      sourceEventId: `f168:review-verdict:${subjectKey}:g${headGeneration}:${fingerprint(input, headGeneration)}`,
      subjectKey,
      kind: 'case.review_verdict_recorded',
      classification: 'informational',
      payload: {
        headSha: currentHeadSha,
        headGeneration,
        verdict: input.verdict,
        summary: input.summary.trim(),
        userNudgeRequired: input.userNudgeRequired === true,
        delivery,
      },
      at: recordedAt,
    };
    const { appended } = await this.opts.eventLog.append(event);
    if (appended) {
      await this.opts.projector.apply(event);
      externalCaseVerdictRecorded.add(1);
      if (input.userNudgeRequired === true) {
        (this.opts.recordUserNudgeRequired ?? (() => externalCaseUserNudgeRequired.add(1)))();
      }
    }

    const canonicalDelivery = await this.loadCanonicalDelivery(subjectKey, delivery);
    return {
      subjectKey,
      headSha: currentHeadSha,
      verdict: input.verdict,
      delivery: canonicalDelivery,
      lifecycle: canonicalDelivery.kind === 'delivered' ? 'delivered' : 'pending_delivery',
    };
  }

  private async loadReadyAggregate(
    input: ExternalReviewVerdictRecordInput,
    subjectKey: string,
  ): Promise<{ aggregate: ExternalReviewAggregate; currentHeadSha: string; headGeneration: number }> {
    const config = await this.opts.repoConfigStore.getByRepo(input.repoFullName);
    if (!config) throw new ExternalReviewVerdictError('not_configured', 'Repository has no external-review policy');
    if (config.reviewMode !== 'maintainer_review') {
      throw new ExternalReviewVerdictError('observe_only', 'Repository policy is observe_only');
    }

    const currentHeadSha = await this.opts.fetchCurrentHead(input.repoFullName, input.prNumber);
    if (!currentHeadSha || currentHeadSha !== input.reviewedHeadSha) {
      throw new ExternalReviewVerdictError('stale_head', 'reviewedHeadSha does not match the current GitHub HEAD');
    }

    const projection = await this.opts.objectStore.get(subjectKey);
    const aggregate = projection?.externalReview;
    if (!aggregate || aggregate.currentHeadSha !== currentHeadSha) {
      throw new ExternalReviewVerdictError(
        'projection_unavailable',
        'Current external-review projection is unavailable',
      );
    }
    if (aggregate.mode !== 'maintainer_review') {
      throw new ExternalReviewVerdictError('observe_only', 'Projected repository policy is observe_only');
    }
    if (aggregate.lifecycle === 'terminal') {
      throw new ExternalReviewVerdictError('subject_terminal', 'External PR is already terminal');
    }
    if (!isReadyForVerdict(aggregate)) {
      throw new ExternalReviewVerdictError('head_not_ready', 'Current HEAD has not reached reviewer-ready state');
    }
    if (aggregate.reviewerCatId !== input.principal.catId || aggregate.reviewerThreadId !== input.principal.threadId) {
      throw new ExternalReviewVerdictError('wrong_principal', 'Callback principal is not the assigned reviewer');
    }
    const headGeneration =
      typeof aggregate.headGeneration === 'number' && aggregate.headGeneration > 0 ? aggregate.headGeneration : 1;
    return { aggregate, currentHeadSha, headGeneration };
  }

  private async loadCanonicalDelivery(
    subjectKey: string,
    delivery: ReviewDeliveryOutcome,
  ): Promise<ReviewDeliveryOutcome> {
    let canonical = (await this.opts.objectStore.get(subjectKey))?.externalReview;
    if (!canonical || !isSameDelivery(canonical.delivery, delivery)) {
      await this.opts.projector.rebuild(subjectKey);
      canonical = (await this.opts.objectStore.get(subjectKey))?.externalReview;
    }
    if (!canonical?.delivery || !isSameDelivery(canonical.delivery, delivery)) {
      throw new ExternalReviewVerdictError('projection_unavailable', 'Verdict event was not projected');
    }
    return canonical.delivery;
  }

  private materializeDelivery(
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

  private async preflightActionLease(
    aggregate: ExternalReviewAggregate,
    provided: ExternalReviewVerdictRecordInput['actionLeaseRef'],
    catId: string,
    terminalPredicateDigest: string,
  ): Promise<PreflightedActionLease | null> {
    const expected = aggregate.actionLeaseRef;
    if (expected) {
      if (!provided) {
        throw new ExternalReviewVerdictError(
          'action_lease_required',
          'Current review responsibility has an action lease',
        );
      }
      if (provided.leaseId !== expected.leaseId || provided.generation !== expected.generation) {
        throw new ExternalReviewVerdictError('action_lease_mismatch', 'Provided action lease does not match the case');
      }
    }
    const effective = expected ?? provided;
    if (!effective) return null;
    const result = await this.opts.preflightLease(
      effective.leaseId,
      effective.generation,
      catId,
      terminalPredicateDigest,
    );
    if (!result.ok) {
      throw new ExternalReviewVerdictError('stale_action_lease', `Action lease is not active: ${result.reason}`);
    }
    return { ...effective, reason: result.reason };
  }
}
