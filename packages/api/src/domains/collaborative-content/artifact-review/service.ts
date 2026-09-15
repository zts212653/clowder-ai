import { createHash } from 'node:crypto';
import {
  type ArtifactReview,
  type ArtifactReviewReceipt,
  type ArtifactReviewView,
  artifactReviewCommandSchema,
  prepareArtifactReviewSchema,
  respondWithMediaVersionSchema,
  type TaskItem,
} from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { ArtifactReviewError } from './errors.js';
import { applyArtifactReviewAction } from './reducer.js';
import type { ArtifactReviewStore, ReviewMutation } from './store.js';
import { ArtifactVersionResponseService } from './version-response-service.js';

export interface ArtifactReviewServiceDeps {
  store: ArtifactReviewStore;
  media: PublishedMediaService;
  now?: () => string;
}

export class ArtifactReviewService {
  readonly versions: ArtifactVersionResponseService;
  private readonly now: () => string;
  constructor(private readonly deps: ArtifactReviewServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.versions = new ArtifactVersionResponseService({ ...deps, now: this.now });
  }

  async prepare(raw: unknown, principal: MediaReviewPrincipal): Promise<ArtifactReviewView> {
    const command = prepareArtifactReviewSchema.parse(raw);
    const task = await this.deps.media.access.authorize(command.taskId, principal, {
      expectedRevision: command.expectedTaskRevision,
      // Existing history may reopen; media.prepare below still requires active Task admission.
      allowClosed: true,
    });
    if (!task.ownerCatId) throw new ArtifactReviewError('owner_required');
    const linked = task.entrustedWork?.artifactRefs.includes(command.artifactRef);
    const closed = task.status === 'done' || task.entrustedWork?.closure.state !== 'open';
    if (!linked && !closed) throw new ArtifactReviewError('task_changed');
    const existing = this.findRetainedReview(task.id, command.artifactRef, principal.userId);
    if (existing) {
      const view = await this.read(existing.reviewId, principal);
      const sourceRevision = view.review.rounds.find(
        (round) => round.asset.sourcePublication.artifactRef === command.artifactRef,
      )?.asset.sourcePublication.revision;
      if (
        String(view.review.rounds.at(-1)?.asset.ownerRevision) !== command.expectedArtifactRevision &&
        sourceRevision !== command.expectedArtifactRevision
      )
        throw new ArtifactReviewError('asset_changed');
      return view;
    }
    if (!linked) throw new ArtifactReviewError('task_changed');
    if (command.artifactRef.startsWith('content:')) throw new ArtifactReviewError('not_found');
    const asset = await this.deps.media.prepare({ ...command, principal });
    const now = this.now();
    const review = this.deps.store.create(
      {
        version: 1,
        reviewId: reviewIdentity(task.id, asset.contentRef),
        revision: 1,
        title: task.title,
        contentRef: asset.contentRef,
        task: {
          taskId: task.id,
          threadId: task.threadId,
          ownerUserId: principal.userId,
          observedRevision: command.expectedTaskRevision,
        },
        rounds: [{ number: 1, asset, openedAt: now, state: 'draft', annotations: [], responses: [] }],
        createdAt: now,
        updatedAt: now,
      },
      { operationId: command.operationId, actor: principal.actor, now },
    );
    return this.read(review.reviewId, principal);
  }

  async read(reviewId: string, principal: MediaReviewPrincipal): Promise<ArtifactReviewView> {
    const review = this.requireReview(reviewId);
    await this.authorizeReview(review, principal);
    if (this.deps.store.pendingVersion(reviewId)) {
      try {
        await this.versions.recover(review, principal);
      } catch (error) {
        if (!(error instanceof MediaOwnerError) || this.deps.store.pendingVersion(reviewId)) throw error;
      }
    }
    return this.readCurrent(reviewId, principal);
  }

  /** Fresh authorized projection for read-only catalogs; never resumes an accepted write. */
  async readCurrent(reviewId: string, principal: MediaReviewPrincipal): Promise<ArtifactReviewView> {
    const review = this.requireReview(reviewId);
    const task = await this.authorizeReview(review, principal);
    const currentOwnerRevision = await this.deps.media.currentRevision(review.contentRef, principal);
    const authorityState = reviewAuthorityState(review, task, currentOwnerRevision);
    const pendingVersion = this.deps.store.pendingVersion(reviewId) !== null;
    const revision = task.entrustedWork?.revision;
    const delivery = this.deps.store.returns.latest(reviewId);
    if (!revision) throw new ArtifactReviewError('access_denied');
    return {
      review,
      pendingVersion,
      authority: {
        state: authorityState,
        taskRevision: revision,
        ownerCatId: task.ownerCatId,
        canWrite: authorityState === 'current' && !pendingVersion,
      },
      continuation: {
        taskId: task.id,
        expectedRevision: revision,
        artifactRef: `content:${review.contentRef}`,
        reviewEvidenceRef:
          review.rounds.at(-1)?.decision?.receiptRef ?? `content-review:${review.reviewId}:revision:${review.revision}`,
        ownerCatId: task.ownerCatId,
        ...(delivery
          ? {
              returnDelivery: {
                state: delivery.state,
                receiptRef: delivery.receiptRef,
                kind: delivery.kind,
                ...(delivery.messageId ? { messageId: delivery.messageId } : {}),
              },
            }
          : {}),
      },
    };
  }

  async act(
    raw: unknown,
    principal: MediaReviewPrincipal,
  ): Promise<{ view: ArtifactReviewView; receipt: ArtifactReviewReceipt }> {
    const command = artifactReviewCommandSchema.parse(raw);
    let review = this.requireReview(command.reviewId);
    await this.authorizeReview(review, principal);
    const input: ReviewMutation = {
      reviewId: command.reviewId,
      expectedRevision: command.expectedRevision,
      operationId: command.operationId,
      actor: principal.actor,
      now: this.now(),
      round: command.round,
      kind: command.action.kind,
      request: command,
    };
    const replay = this.deps.store.replay(input);
    if (replay) return { view: await this.read(command.reviewId, principal), receipt: replay.receipt };
    if (this.deps.store.pendingVersion(command.reviewId)) throw new ArtifactReviewError('version_pending');
    const task = await this.deps.media.access.authorize(review.task.taskId, principal, {
      expectedRevision: command.expectedTaskRevision,
    });
    const currentOwnerRevision = await this.deps.media.currentRevision(review.contentRef, principal);
    const state = reviewAuthorityState(review, task, currentOwnerRevision);
    if (state === 'asset_changed') throw new ArtifactReviewError('asset_changed');
    const renewing = command.action.kind === 'request_judgment' && isCurrentArtifactLinked(task, review);
    if (state !== 'current' && !renewing) throw new ArtifactReviewError('task_changed');
    if (command.action.kind === 'request_judgment' && !isCurrentArtifactLinked(task, review))
      throw new ArtifactReviewError('task_changed');
    review = this.requireReview(command.reviewId);
    const latestTask = await this.authorizeReview(review, principal);
    if (
      latestTask.entrustedWork?.revision !== command.expectedTaskRevision ||
      latestTask.ownerCatId !== task.ownerCatId ||
      latestTask.status === 'done'
    ) {
      throw new ArtifactReviewError('task_changed');
    }
    if (principal.actor.kind === 'human' && latestTask.ownerCatId)
      input.returnTarget = {
        targetCatId: latestTask.ownerCatId,
        expectedTaskRevision: command.expectedTaskRevision,
      };
    const committed = this.deps.store.mutate(input, (current, receiptRef) => {
      const predecessor = structuredClone(current);
      if (renewing && state !== 'current') {
        predecessor.task.observedRevision = command.expectedTaskRevision;
        const round = predecessor.rounds.at(-1);
        if (round?.state === 'awaiting_human') round.attentionRetiredReason = 'task_changed';
      }
      return applyArtifactReviewAction(predecessor, {
        action: command.action,
        actor: principal.actor,
        round: command.round,
        ownerCatId: task.ownerCatId,
        now: input.now,
        receiptRef,
      });
    });
    return { view: await this.read(command.reviewId, principal), receipt: committed.receipt };
  }

  async respond(
    raw: unknown,
    principal: MediaReviewPrincipal,
  ): Promise<{ view: ArtifactReviewView; receipt: ArtifactReviewReceipt }> {
    const command = respondWithMediaVersionSchema.parse(raw);
    const review = this.requireReview(command.reviewId);
    const task = await this.authorizeReview(review, principal);
    if (!isLineageLinked(task, review)) throw new ArtifactReviewError('task_changed');
    const committed = await this.versions.respond(command, principal, review);
    return { view: await this.read(review.reviewId, principal), receipt: committed.receipt };
  }

  async history(reviewId: string, principal: MediaReviewPrincipal, afterRevision = 0, limit = 100) {
    await this.read(reviewId, principal);
    const entries = this.deps.store.history(reviewId, afterRevision, limit);
    return { entries, nextCursor: entries.length === limit ? (entries.at(-1)?.receipt.revision ?? null) : null };
  }

  async mediaBytes(reviewId: string, roundNumber: number, principal: MediaReviewPrincipal) {
    const view = await this.read(reviewId, principal);
    const round = view.review.rounds.find((item) => item.number === roundNumber);
    if (!round) throw new ArtifactReviewError('not_found');
    const bytes = await this.deps.media.bytes(view.review.contentRef, round.asset.ownerRevision, principal);
    return { bytes, mediaType: round.asset.mediaType, digest: round.asset.blobDigest };
  }

  async openMedia(reviewId: string, roundNumber: number, principal: MediaReviewPrincipal) {
    const view = await this.readCurrent(reviewId, principal);
    const round = view.review.rounds.find((item) => item.number === roundNumber);
    if (!round) throw new ArtifactReviewError('not_found');
    return this.deps.media.open(
      round.asset,
      {
        ownerUserId: view.review.task.ownerUserId,
        threadId: view.review.task.threadId,
        taskId: view.review.task.taskId,
      },
      principal,
    );
  }

  async listForTask(taskId: string, principal: MediaReviewPrincipal) {
    await this.deps.media.access.authorize(taskId, principal, { allowClosed: true });
    const results = [];
    for (const review of this.deps.store.listForTask(principal.userId, taskId)) {
      const view = await this.read(review.reviewId, principal);
      results.push({
        reviewId: review.reviewId,
        title: review.title,
        revision: view.review.revision,
        contentRef: review.contentRef,
        round: view.review.rounds.at(-1)?.number,
        state: view.review.rounds.at(-1)?.state,
      });
    }
    return results;
  }

  private findRetainedReview(taskId: string, artifactRef: string, ownerUserId: string) {
    if (artifactRef.startsWith('content:'))
      return this.deps.store.get(reviewIdentity(taskId, artifactRef.slice('content:'.length)));
    const candidates = this.deps.store
      .listForTask(ownerUserId, taskId)
      .filter((review) => reviewRetainsArtifact(review, artifactRef));
    if (candidates.length > 1) throw new ArtifactReviewError('task_changed');
    return candidates[0];
  }

  private requireReview(reviewId: string): ArtifactReview {
    const review = this.deps.store.get(reviewId);
    if (!review) throw new ArtifactReviewError('not_found');
    return review;
  }

  private async authorizeReview(review: ArtifactReview, principal: MediaReviewPrincipal): Promise<TaskItem> {
    const scope = { ownerUserId: review.task.ownerUserId, threadId: review.task.threadId, taskId: review.task.taskId };
    const task = await this.deps.media.access.authorizeScope(scope, principal);
    for (const round of review.rounds) await this.deps.media.assertVisible(round.asset, scope, principal);
    return task;
  }
}

export function reviewIdentity(taskId: string, contentRef: string): string {
  return `review-${createHash('sha256')
    .update(JSON.stringify([taskId, contentRef]))
    .digest('hex')}`;
}

export function reviewRetainsArtifact(review: ArtifactReview, artifactRef: string): boolean {
  return (
    artifactRef === `content:${review.contentRef}` ||
    review.rounds.some((round) => round.asset.sourcePublication.artifactRef === artifactRef)
  );
}

export function isCurrentArtifactLinked(task: TaskItem, review: ArtifactReview): boolean {
  const refs = task.entrustedWork?.artifactRefs;
  return (
    refs?.length === 1 &&
    (refs[0] === `content:${review.contentRef}` ||
      refs[0] === review.rounds.at(-1)?.asset.sourcePublication.artifactRef)
  );
}

function isLineageLinked(task: TaskItem, review: ArtifactReview): boolean {
  const refs = task.entrustedWork?.artifactRefs;
  return (
    isCurrentArtifactLinked(task, review) ||
    (refs?.length === 1 && refs[0] === review.rounds[0]?.asset.sourcePublication.artifactRef)
  );
}

function reviewAuthorityState(
  review: ArtifactReview,
  task: TaskItem,
  currentOwnerRevision: number,
): ArtifactReviewView['authority']['state'] {
  if (task.status === 'done' || task.entrustedWork?.closure.state !== 'open') return 'task_closed';
  const round = review.rounds.at(-1);
  if (
    !task.ownerCatId ||
    task.entrustedWork?.revision !== review.task.observedRevision ||
    !isLineageLinked(task, review)
  )
    return 'task_changed';
  if (round?.state === 'awaiting_human' && round.judgmentRequest?.requestedBy.actorId !== task.ownerCatId)
    return 'task_changed';
  return round?.asset.ownerRevision === currentOwnerRevision ? 'current' : 'asset_changed';
}
