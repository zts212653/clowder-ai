import type {
  CommunityEvent,
  ExternalReviewAggregate,
  PendingExternalReviewVerdict,
  ReviewDeliveryOutcome,
} from '@cat-cafe/shared';
import { prSubjectKey } from '@cat-cafe/shared';
import {
  externalCaseUserNudgeRequired,
  externalCaseVerdictRecorded,
} from '../../../infrastructure/telemetry/instruments.js';
import { canonicalizeActionTerminalPredicate } from '../../ball-custody/ActionTerminalPredicateCatalog.js';
import {
  decideExternalReviewReadiness,
  externalReviewVerdictAuthorizationFailure,
  isReadyForVerdict,
} from './external-review-aggregate.js';
import {
  type ExternalPendingVerdictSettlementResult,
  type ExternalReviewVerdict,
  ExternalReviewVerdictError,
  type ExternalReviewVerdictRecordInput,
  type ExternalReviewVerdictRecordResult,
  type ExternalReviewVerdictServiceOptions,
  loadCanonicalReviewDelivery,
  materializeExternalReviewDelivery,
  PENDING_VERIFICATION_REASONS,
  recordPendingExternalReviewVerdict,
  verdictFingerprint,
} from './external-review-verdict-submission.js';

export type {
  ExternalPendingVerdictSettlementResult,
  ExternalReviewDeliveryInput,
  ExternalReviewVerdict,
  ExternalReviewVerdictErrorCode,
  ExternalReviewVerdictRecordInput,
  ExternalReviewVerdictRecordResult,
  ExternalReviewVerdictServiceOptions,
} from './external-review-verdict-submission.js';
export { ExternalReviewVerdictError, isGitHubReviewDeliveryProof } from './external-review-verdict-submission.js';

type PreflightedActionLease = Readonly<{ leaseId: string; generation: number; reason: string }>;

export class ExternalReviewVerdictService {
  private readonly now: () => number;

  constructor(private readonly opts: ExternalReviewVerdictServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  async record(input: ExternalReviewVerdictRecordInput): Promise<ExternalReviewVerdictRecordResult> {
    const subjectKey = prSubjectKey(input.repoFullName, input.prNumber);
    const { aggregate, currentHeadSha, headGeneration, verificationReason } = await this.loadAggregate(
      input,
      subjectKey,
    );
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
    const delivery = materializeExternalReviewDelivery(input, currentHeadSha, recordedAt);
    const submissionFingerprint = verdictFingerprint(input, headGeneration);
    if (aggregate.pendingVerdict && aggregate.pendingVerdict.fingerprint !== submissionFingerprint) {
      throw new ExternalReviewVerdictError(
        'verdict_conflict',
        'A different verdict submission already awaits canonical verification for this HEAD generation',
      );
    }
    if (verificationReason) {
      return recordPendingExternalReviewVerdict({
        eventLog: this.opts.eventLog,
        projector: this.opts.projector,
        objectStore: this.opts.objectStore,
        subjectKey,
        aggregate,
        currentHeadSha,
        headGeneration,
        submission: input,
        delivery,
        actionLease: actionLease ? { leaseId: actionLease.leaseId, generation: actionLease.generation } : null,
        verificationReason,
        submissionFingerprint,
        recordedAt,
      });
    }

    return this.recordCanonicalVerdict({
      subjectKey,
      currentHeadSha,
      headGeneration,
      verdict: input.verdict,
      summary: input.summary.trim(),
      userNudgeRequired: input.userNudgeRequired === true,
      delivery,
      principal: input.principal,
      actionLease,
      submissionFingerprint,
      recordedAt,
    });
  }

  async settlePending(subjectKey: string): Promise<ExternalPendingVerdictSettlementResult> {
    const aggregate = (await this.opts.objectStore.get(subjectKey))?.externalReview;
    const pending = aggregate?.pendingVerdict;
    if (!aggregate || !pending) return { kind: 'none' };
    if (
      pending.headSha !== aggregate.currentHeadSha ||
      pending.headGeneration !== aggregate.headGeneration ||
      aggregate.lifecycle === 'terminal'
    ) {
      return { kind: 'waiting', reason: 'stale_or_terminal_projection' };
    }
    if (
      aggregate.reviewerCatId !== pending.principal.catId ||
      aggregate.reviewerThreadId !== pending.principal.threadId
    ) {
      return { kind: 'waiting', reason: 'wrong_principal' };
    }
    if (!isReadyForVerdict(aggregate)) {
      const readiness = decideExternalReviewReadiness(aggregate);
      return { kind: 'waiting', reason: readiness.kind === 'wait' ? readiness.reason : 'head_not_ready' };
    }

    const completionPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: subjectKey,
      predicate: { kind: 'review_delivered', headSha: pending.headSha },
    });
    let actionLease: PreflightedActionLease | null;
    try {
      actionLease = await this.preflightActionLease(
        aggregate,
        pending.actionLeaseRef ?? undefined,
        pending.principal.catId,
        completionPredicate.digest,
      );
    } catch (error) {
      if (
        error instanceof ExternalReviewVerdictError &&
        (error.code === 'action_lease_required' ||
          error.code === 'action_lease_mismatch' ||
          error.code === 'stale_action_lease')
      ) {
        return { kind: 'waiting', reason: error.code };
      }
      throw error;
    }
    if (actionLease?.reason === 'verified_success' && pending.delivery.kind === 'pending_delivery') {
      throw new ExternalReviewVerdictError(
        'delivery_regression',
        'A custody-verified current-HEAD verdict cannot return to pending_delivery',
      );
    }

    const result = await this.recordCanonicalVerdict({
      subjectKey,
      currentHeadSha: pending.headSha,
      headGeneration: pending.headGeneration,
      verdict: pending.verdict,
      summary: pending.summary,
      userNudgeRequired: pending.userNudgeRequired,
      delivery: pending.delivery,
      principal: pending.principal,
      actionLease,
      submissionFingerprint: pending.fingerprint,
      recordedAt: this.now(),
    });
    return { kind: 'settled', result };
  }

  private async recordCanonicalVerdict(input: {
    subjectKey: string;
    currentHeadSha: string;
    headGeneration: number;
    verdict: ExternalReviewVerdict;
    summary: string;
    userNudgeRequired: boolean;
    delivery: ReviewDeliveryOutcome;
    principal: { readonly catId: string; readonly threadId: string };
    actionLease: PreflightedActionLease | null;
    submissionFingerprint: string;
    recordedAt: number;
  }): Promise<ExternalReviewVerdictRecordResult> {
    const {
      subjectKey,
      currentHeadSha,
      headGeneration,
      verdict,
      summary,
      userNudgeRequired,
      delivery,
      principal,
      actionLease,
      submissionFingerprint,
      recordedAt,
    } = input;
    if (delivery.kind === 'delivered' && actionLease) {
      const completion = await this.opts.completeActionLease({
        leaseId: actionLease.leaseId,
        generation: actionLease.generation,
        catId: principal.catId,
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
      sourceEventId: `f168:review-verdict:${subjectKey}:g${headGeneration}:${submissionFingerprint}`,
      subjectKey,
      kind: 'case.review_verdict_recorded',
      classification: 'informational',
      payload: {
        headSha: currentHeadSha,
        headGeneration,
        verdict,
        summary,
        userNudgeRequired,
        delivery,
      },
      at: recordedAt,
    };
    const { appended } = await this.opts.eventLog.append(event);
    if (appended) {
      await this.opts.projector.apply(event);
      externalCaseVerdictRecorded.add(1);
      if (userNudgeRequired) {
        (this.opts.recordUserNudgeRequired ?? (() => externalCaseUserNudgeRequired.add(1)))();
      }
    }

    const canonicalDelivery = await loadCanonicalReviewDelivery({
      objectStore: this.opts.objectStore,
      projector: this.opts.projector,
      subjectKey,
      delivery,
    });
    return {
      subjectKey,
      headSha: currentHeadSha,
      verdict,
      delivery: canonicalDelivery,
      lifecycle: canonicalDelivery.kind === 'delivered' ? 'delivered' : 'pending_delivery',
    };
  }

  private async loadAggregate(
    input: ExternalReviewVerdictRecordInput,
    subjectKey: string,
  ): Promise<{
    aggregate: ExternalReviewAggregate;
    currentHeadSha: string;
    headGeneration: number;
    verificationReason: PendingExternalReviewVerdict['verificationReason'] | null;
  }> {
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
    const authorizationFailure = externalReviewVerdictAuthorizationFailure(aggregate, input.principal);
    if (authorizationFailure) {
      throw new ExternalReviewVerdictError(authorizationFailure.code, authorizationFailure.message);
    }
    const headGeneration =
      typeof aggregate.headGeneration === 'number' && aggregate.headGeneration > 0 ? aggregate.headGeneration : 1;
    if (isReadyForVerdict(aggregate)) {
      return { aggregate, currentHeadSha, headGeneration, verificationReason: null };
    }
    const readiness = decideExternalReviewReadiness(aggregate);
    if (
      readiness.kind === 'wait' &&
      PENDING_VERIFICATION_REASONS.has(readiness.reason as PendingExternalReviewVerdict['verificationReason'])
    ) {
      return {
        aggregate,
        currentHeadSha,
        headGeneration,
        verificationReason: readiness.reason as PendingExternalReviewVerdict['verificationReason'],
      };
    }
    throw new ExternalReviewVerdictError('head_not_ready', 'Current HEAD has not reached reviewer-ready state');
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
