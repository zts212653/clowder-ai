import type {
  CommunityEvent,
  CommunityObjectProjection,
  ExternalCloudReviewStatus,
  ExternalReviewAggregate,
} from '@cat-cafe/shared';
import { prSubjectKey } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { CiPollResult } from '../../../infrastructure/email/ci-cd-contract.js';
import {
  externalCaseHeadObserved,
  externalCasePendingDeliveryAgeSeconds,
} from '../../../infrastructure/telemetry/instruments.js';
import type { ICommunityEventLog } from '../CommunityEventLog.js';
import type { ICommunityObjectStore } from '../CommunityObjectStore.js';
import type { ICommunityRepoConfigStore } from '../CommunityRepoConfigStore.js';
import { decideExternalReviewReadiness, type ExternalReviewReadinessDecision } from './external-review-aggregate.js';

interface ExternalReviewProjectorPort {
  apply(event: CommunityEvent): Promise<void>;
  rebuild(subjectKey: string): Promise<void>;
}

export interface ExternalReviewTrackingTarget {
  readonly threadId: string;
  readonly catId: string;
  readonly userId: string;
}

export interface ExternalCloudObservation {
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly status: ExternalCloudReviewStatus;
  readonly triggerCommentId?: number;
  readonly reviewId?: number;
}

type ExternalReviewWaitReason = Extract<ExternalReviewReadinessDecision, { kind: 'wait' }>['reason'];

export type ExternalReviewCoordinatorResult =
  | { readonly kind: 'not_tracked' }
  | {
      readonly kind: 'state_only';
      readonly reason:
        | ExternalReviewWaitReason
        | 'wake_already_delivered_for_head'
        | 'projection_unavailable'
        | 'explicit_wait_required';
    };

export interface ExternalReviewCoordinatorOptions {
  readonly repoConfigStore: Pick<ICommunityRepoConfigStore, 'getByRepo'>;
  readonly eventLog: ICommunityEventLog;
  readonly projector: ExternalReviewProjectorPort;
  readonly objectStore: Pick<ICommunityObjectStore, 'get'>;
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  readonly now?: () => number;
}

function makeEvent(
  sourceEventId: string,
  subjectKey: string,
  kind: CommunityEvent['kind'],
  payload: Record<string, unknown>,
  at: number,
): CommunityEvent {
  return { sourceEventId, subjectKey, kind, classification: 'informational', payload, at };
}

export class ExternalReviewCoordinator {
  private readonly now: () => number;
  private readonly projectedSourceEventIds = new Set<string>();

  constructor(private readonly opts: ExternalReviewCoordinatorOptions) {
    this.now = opts.now ?? Date.now;
  }

  async recordCi(poll: CiPollResult, tracking: ExternalReviewTrackingTarget): Promise<ExternalReviewCoordinatorResult> {
    const initialized = await this.initialize(poll.repoFullName, poll.prNumber, poll.headSha, tracking);
    if (!initialized) return { kind: 'not_tracked' };

    const status = poll.aggregateBucket;
    await this.appendAndApply(
      makeEvent(
        `f168:ci:${initialized.subjectKey}:g${initialized.headGeneration}:${poll.headSha}:${status}`,
        initialized.subjectKey,
        'case.ci_observed',
        { headSha: poll.headSha, headGeneration: initialized.headGeneration, status },
        this.now(),
      ),
    );
    return this.maybeWake(initialized.subjectKey);
  }

  async recordCloud(
    observation: ExternalCloudObservation,
    tracking: ExternalReviewTrackingTarget,
  ): Promise<ExternalReviewCoordinatorResult> {
    const initialized = await this.initialize(
      observation.repoFullName,
      observation.prNumber,
      observation.headSha,
      tracking,
    );
    if (!initialized) return { kind: 'not_tracked' };

    const current = await this.readAggregate(initialized.subjectKey);
    if (
      observation.status === 'running' &&
      current?.cloud?.headSha === observation.headSha &&
      current.cloud.headGeneration === initialized.headGeneration &&
      current.cloud.status !== 'running' &&
      current.cloud.status !== 'not_requested'
    ) {
      return this.maybeWake(initialized.subjectKey);
    }

    const correlation = observation.reviewId ?? observation.triggerCommentId ?? 'none';
    await this.appendAndApply(
      makeEvent(
        `f168:cloud:${initialized.subjectKey}:g${initialized.headGeneration}:${observation.headSha}:${observation.status}:${correlation}`,
        initialized.subjectKey,
        'case.cloud_review_observed',
        {
          headSha: observation.headSha,
          headGeneration: initialized.headGeneration,
          status: observation.status,
          ...(observation.triggerCommentId ? { triggerCommentId: observation.triggerCommentId } : {}),
          ...(observation.reviewId ? { reviewId: observation.reviewId } : {}),
        },
        this.now(),
      ),
    );
    return this.maybeWake(initialized.subjectKey);
  }

  private async initialize(
    repoFullName: string,
    prNumber: number,
    headSha: string,
    tracking: ExternalReviewTrackingTarget,
  ): Promise<{ subjectKey: string; headGeneration: number } | null> {
    const config = await this.opts.repoConfigStore.getByRepo(repoFullName);
    if (!config) return null;
    const subjectKey = prSubjectKey(repoFullName, prNumber);
    await this.appendAndApply(
      makeEvent(
        `f168:external-review-assigned:${subjectKey}:${config.updatedAt}`,
        subjectKey,
        'case.external_review_assigned',
        {
          mode: config.reviewMode,
          cloudPolicy: config.cloudReviewPolicy,
          reviewerCatId: tracking.catId,
          reviewerThreadId: tracking.threadId,
        },
        this.now(),
      ),
    );
    const current = await this.readAggregate(subjectKey);
    const currentGeneration =
      typeof current?.headGeneration === 'number' && current.headGeneration > 0
        ? current.headGeneration
        : current?.currentHeadSha
          ? 1
          : 0;
    if (current?.currentHeadSha === headSha && current?.headGeneration === currentGeneration) {
      return { subjectKey, headGeneration: currentGeneration };
    }

    const headGeneration = current?.currentHeadSha === headSha ? currentGeneration : currentGeneration + 1;
    await this.appendAndApply(
      makeEvent(
        `f168:head:${subjectKey}:g${headGeneration}:${headSha}`,
        subjectKey,
        'case.head_observed',
        { headSha, headGeneration },
        this.now(),
      ),
    );
    const projected = await this.readAggregate(subjectKey);
    return {
      subjectKey,
      headGeneration:
        projected?.currentHeadSha === headSha && typeof projected.headGeneration === 'number'
          ? projected.headGeneration
          : headGeneration,
    };
  }

  private async appendAndApply(event: CommunityEvent): Promise<boolean> {
    const { appended } = await this.opts.eventLog.append(event);
    if (appended) {
      await this.opts.projector.apply(event);
      this.rememberProjected(event.sourceEventId);
    } else if (!this.projectedSourceEventIds.has(event.sourceEventId)) {
      await this.opts.projector.rebuild(event.subjectKey);
      this.rememberProjected(event.sourceEventId);
      this.opts.log.warn(
        { subjectKey: event.subjectKey, sourceEventId: event.sourceEventId },
        '[F168] duplicate canonical event repaired projection by rebuild',
      );
    }
    if (appended && event.kind === 'case.head_observed') externalCaseHeadObserved.add(1);
    return appended;
  }

  private rememberProjected(sourceEventId: string): void {
    this.projectedSourceEventIds.add(sourceEventId);
    if (this.projectedSourceEventIds.size <= 2_048) return;
    const oldest = this.projectedSourceEventIds.values().next().value;
    if (typeof oldest === 'string') this.projectedSourceEventIds.delete(oldest);
  }

  private async readAggregate(subjectKey: string): Promise<ExternalReviewAggregate | null> {
    let projection = await this.opts.objectStore.get(subjectKey);
    if (!projection) {
      await this.opts.projector.rebuild(subjectKey);
      projection = await this.opts.objectStore.get(subjectKey);
    }
    return (projection as CommunityObjectProjection | null)?.externalReview ?? null;
  }

  private async maybeWake(subjectKey: string): Promise<ExternalReviewCoordinatorResult> {
    let aggregate = await this.readAggregate(subjectKey);
    if (!aggregate) return { kind: 'state_only', reason: 'projection_unavailable' };
    if (aggregate.delivery?.kind === 'pending_delivery') {
      externalCasePendingDeliveryAgeSeconds.record(Math.max(0, this.now() - aggregate.delivery.createdAt) / 1000);
    }
    if (
      aggregate.wake?.headSha === aggregate.currentHeadSha &&
      aggregate.wake.headGeneration === aggregate.headGeneration &&
      aggregate.wake.status === 'delivered'
    ) {
      return { kind: 'state_only', reason: 'wake_already_delivered_for_head' };
    }

    if (
      !aggregate.wake ||
      aggregate.wake.headSha !== aggregate.currentHeadSha ||
      aggregate.wake.headGeneration !== aggregate.headGeneration
    ) {
      const decision = decideExternalReviewReadiness(aggregate);
      if (decision.kind === 'wait') return { kind: 'state_only', reason: decision.reason };
      await this.appendAndApply(
        makeEvent(
          `f168:review-ready:${subjectKey}:g${aggregate.headGeneration}:${decision.headSha}`,
          subjectKey,
          'case.review_ready',
          { headSha: decision.headSha, headGeneration: aggregate.headGeneration },
          this.now(),
        ),
      );
      aggregate = await this.readAggregate(subjectKey);
    }

    if (!aggregate?.wake || aggregate.wake.status !== 'pending') {
      return { kind: 'state_only', reason: 'projection_unavailable' };
    }
    const deliveryReadiness = decideExternalReviewReadiness({ ...aggregate, wake: null });
    if (deliveryReadiness.kind === 'wait') return { kind: 'state_only', reason: deliveryReadiness.reason };
    // F280: readiness remains durable case truth. Only an explicit typed wait
    // may project it into connector delivery/invocation.
    return { kind: 'state_only', reason: 'explicit_wait_required' };
  }
}
