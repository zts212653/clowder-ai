import type {
  VideoProjectReviewAction,
  VideoProjectReviewSource,
  VideoProjectReviewTarget,
  WorkspaceContentAnnotation,
  WorkspaceContentReview,
  WorkspaceContentReviewView,
} from '@cat-cafe/shared';
import { videoProjectReviewActionSchema } from '@cat-cafe/shared';
import type { VideoProjectPrincipal } from '../../video-studio/project/access.js';
import type { VideoProjectReadPort as VideoProjectReviewPort } from '../../video-studio/project/types.js';
import { WorkspaceContentReviewError } from './errors.js';
import { ProjectAudienceConflict, projectAudienceKey, retryProjectAudience } from './project-message/audience.js';
import type { ProjectReviewMutationInput as MutationInput } from './project-message/audience-mutation.js';
import { assertProjectAudienceCurrent, projectAudienceMutation } from './project-message/audience-mutation.js';
import type { VideoProjectMessageAuthority } from './project-message/types.js';
import { projectMessageAnnotationProjection } from './project-message/visibility.js';
import { validateProjectReviewResult } from './result-proof/receipt.js';
import type { WorkspaceContentReviewStore, WorkspaceReviewMutationResult } from './store.js';
import { applyProjectReviewAction } from './video-project-review-actions.js';
import { projectReviewAnchor, validateProjectAnchor } from './video-project-review-anchors.js';
import { readVideoProjectReview, videoProjectLedgerSource } from './video-project-review-source.js';
import {
  validateWorkspaceReviewBody,
  validateWorkspaceReviewId,
  workspaceAnnotationId,
  workspaceReviewIdentity,
} from './workspace-review-anchors.js';
import { appendWorkspaceSourceHistory } from './workspace-review-mutations.js';

/** Project-specific trusted Human/Cat entry point sharing F309's one injected ledger. */
export class VideoProjectReviewService {
  private readonly now: () => string;
  constructor(
    private readonly options: {
      store: WorkspaceContentReviewStore;
      projects: VideoProjectReviewPort;
      now?: () => string;
      messageAuthority?: VideoProjectMessageAuthority;
    },
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async prepare(input: {
    principal: VideoProjectPrincipal;
    contentRef: string;
    ownerRevision?: number;
    operationId: string;
  }): Promise<WorkspaceContentReviewView> {
    this.assertPrincipal(input.principal);
    validateWorkspaceReviewId(input.operationId);
    const snapshot = await this.options.projects.load(input);
    const existing = this.options.store.getByContent(input.principal.userId, snapshot.contentRef);
    if (existing) return this.read({ principal: input.principal, reviewId: existing.reviewId });
    await this.options.projects.authorize({ ...input, permission: 'write' });
    if (snapshot.document.archivedAt) throw new WorkspaceContentReviewError('source_changed');
    const source = videoProjectLedgerSource(snapshot);
    const now = this.now();
    const review = this.options.store.create(
      {
        version: 1,
        reviewId: workspaceReviewIdentity(input.principal.userId, snapshot.contentRef),
        ownerUserId: input.principal.userId,
        contentRef: snapshot.contentRef,
        source,
        sourceHistory: [source],
        revision: 1,
        annotations: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        operationId: input.operationId,
        actor: input.principal.actor,
        kind: 'prepare:video-project',
        now,
        request: { contentRef: snapshot.contentRef, ownerRevision: snapshot.ownerRevision },
      },
    );
    return this.read({ principal: input.principal, reviewId: review.reviewId });
  }

  async read(input: { principal: VideoProjectPrincipal; reviewId: string }): Promise<WorkspaceContentReviewView> {
    return retryProjectAudience(input.principal, async () => {
      const review = await this.requireReview(input.principal, input.reviewId, 'read');
      return this.projectView(review, input.principal);
    });
  }

  async operationReceipt(input: { principal: VideoProjectPrincipal; reviewId: string; operationId: string }) {
    const review = await this.requireReview(input.principal, input.reviewId, 'read');
    const annotation = review.annotations.find(
      (item) =>
        item.operationId === input.operationId ||
        (input.operationId.startsWith('prepare-project-message-') &&
          `prepare-${item.operationId}` === input.operationId) ||
        item.projectHistory?.some((event) => event.operationId === input.operationId),
    );
    if (annotation && !(await this.projectAnnotation(annotation, input.principal))) return null;
    const receipt = this.options.store.operationReceipt(input.reviewId, validateWorkspaceReviewId(input.operationId));
    if (!receipt || input.principal.actor.kind === 'human') return receipt;
    const audience = projectAudienceKey(input.principal);
    // Unknown auxiliary/private operations have no public annotation witness. A previously scoped refresh is ours only.
    if (
      !annotation &&
      (input.operationId.startsWith('prepare-project-message-') || receipt.revision !== 1) &&
      !this.options.store.projectAudiences.hasReceipt(receipt, audience)
    )
      return null;
    const view = await this.read(input);
    return this.options.store.projectAudiences.receipt(
      receipt,
      audience,
      receipt.revision === 1 ? 1 : view.review.revision,
    );
  }

  async annotate(input: MutationInput & { body: string; target: VideoProjectReviewTarget }) {
    return retryProjectAudience(input.principal, () => this.annotateOnce(input));
  }

  private async annotateOnce(input: MutationInput & { body: string; target: VideoProjectReviewTarget }) {
    const review = await this.requireReview(input.principal, input.reviewId, 'write');
    const mutation = await this.mutation(
      input,
      'annotate:video-project',
      { body: input.body, target: input.target },
      review,
    );
    const replay = this.options.store.replay(mutation);
    if (replay) return this.projectMutation(replay, input.principal);
    if (input.expectedRevision !== mutation.audienceRevision) throw new ProjectAudienceConflict();
    const view = mutation.view;
    if (!view.canWrite) throw new WorkspaceContentReviewError('source_changed');
    const snapshot = await this.options.projects.load({
      principal: input.principal,
      contentRef: review.contentRef,
      ownerRevision: view.review.source.kind === 'video-project' ? view.review.source.ownerRevision : undefined,
    });
    const anchor = projectReviewAnchor(snapshot, input.target);
    const body = validateWorkspaceReviewBody(input.body);
    await assertProjectAudienceCurrent(input, () => this.projectView(review, input.principal), this.options.projects);
    return this.projectMutation(
      this.options.store.mutate(mutation, (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: mutation.now,
        annotations: [
          ...current.annotations,
          {
            id: workspaceAnnotationId(current.reviewId, input.operationId),
            operationId: input.operationId,
            anchor,
            body,
            author: input.principal.actor,
            createdAt: mutation.now,
            updatedAt: mutation.now,
            state: 'open',
            replies: [],
            projectHistory: [
              {
                kind: 'created',
                actor: input.principal.actor,
                at: mutation.now,
                operationId: input.operationId,
                targets: [anchor],
              },
            ],
          },
        ],
      })),
      input.principal,
    );
  }

  async act(input: MutationInput & { action: VideoProjectReviewAction }) {
    return retryProjectAudience(input.principal, () => this.actOnce(input));
  }

  private async actOnce(input: MutationInput & { action: VideoProjectReviewAction }) {
    const review = await this.requireReview(input.principal, input.reviewId, 'write');
    const parsed = videoProjectReviewActionSchema.safeParse(input.action);
    if (!parsed.success) throw new WorkspaceContentReviewError('invalid_action');
    const action = parsed.data;
    const selected = review.annotations.find((item) => item.id === action.annotationId);
    if (selected && !(await this.projectAnnotation(selected, input.principal, 'write')))
      throw new WorkspaceContentReviewError('access_denied');
    const mutation = await this.mutation(input, `project:${action.kind}`, { action }, review);
    const replay = this.options.store.replay(mutation);
    if (replay) return this.projectMutation(replay, input.principal);
    if (input.expectedRevision !== mutation.audienceRevision) throw new ProjectAudienceConflict();
    const head = await this.options.projects.load({ principal: input.principal, contentRef: review.contentRef });
    if (head.document.archivedAt) throw new WorkspaceContentReviewError('source_changed');
    const annotation = review.annotations.find((item) => item.id === action.annotationId);
    if (!annotation) throw new WorkspaceContentReviewError('not_found');
    const metadata: VideoProjectReviewSource[] = [];
    if (action.kind === 'located') {
      for (const target of action.targets) {
        await validateProjectAnchor(this.options.projects, input.principal, review.contentRef, target);
        metadata.push(
          videoProjectLedgerSource(
            await this.options.projects.load({
              principal: input.principal,
              contentRef: review.contentRef,
              ownerRevision: target.baseOwnerRevision,
            }),
          ),
        );
      }
    } else if (action.kind === 'addressed') {
      const source = await validateProjectReviewResult(
        this.options.projects,
        review,
        annotation,
        action.result,
        input.principal,
      );
      if (source) metadata.push(source);
    }
    if (!(await this.projectAnnotation(annotation, input.principal, 'write')))
      throw new WorkspaceContentReviewError('access_denied');
    await assertProjectAudienceCurrent(
      { ...input, annotationId: action.annotationId },
      () => this.projectView(review, input.principal),
      this.options.projects,
    );
    // The F138 receipt is confirmed before this separate F309 transaction; there is no fake atomic commit across owners.
    return this.projectMutation(
      this.options.store.mutate(mutation, (current) => {
        let next = {
          ...current,
          revision: current.revision + 1,
          updatedAt: mutation.now,
          annotations: current.annotations.map((item) =>
            item.id === action.annotationId
              ? applyProjectReviewAction(item, action, input.principal.actor, mutation.now, input.operationId)
              : item,
          ),
        };
        for (const source of metadata) next = { ...next, sourceHistory: appendWorkspaceSourceHistory(next, source) };
        return next;
      }),
      input.principal,
    );
  }

  async refresh(input: MutationInput & { expectedOwnerRevision: number }): Promise<WorkspaceContentReviewView> {
    return retryProjectAudience(input.principal, () => this.refreshOnce(input));
  }

  private async refreshOnce(
    input: MutationInput & { expectedOwnerRevision: number },
  ): Promise<WorkspaceContentReviewView> {
    const review = await this.requireReview(input.principal, input.reviewId, 'write');
    const mutation = await this.mutation(
      input,
      'refresh:video-project',
      {
        expectedOwnerRevision: input.expectedOwnerRevision,
      },
      review,
    );
    const replay = this.options.store.replay(mutation);
    if (replay) return this.read({ principal: input.principal, reviewId: input.reviewId });
    if (input.expectedRevision !== mutation.audienceRevision) throw new ProjectAudienceConflict();
    const snapshot = await this.options.projects.load({ principal: input.principal, contentRef: review.contentRef });
    if (snapshot.document.archivedAt) throw new WorkspaceContentReviewError('source_changed');
    if (snapshot.ownerRevision !== input.expectedOwnerRevision) throw new WorkspaceContentReviewError('source_changed');
    const source = videoProjectLedgerSource(snapshot);
    await assertProjectAudienceCurrent(input, () => this.projectView(review, input.principal), this.options.projects);
    if (
      review.source.kind === 'video-project' &&
      review.source.ownerRevision === source.ownerRevision &&
      review.source.revision === source.revision
    )
      this.options.store.recordNoop(mutation);
    else
      this.options.store.mutate(mutation, (current) => ({
        ...current,
        source,
        sourceHistory: appendWorkspaceSourceHistory(current, source),
        revision: current.revision + 1,
        updatedAt: mutation.now,
      }));
    return this.read({ principal: input.principal, reviewId: input.reviewId });
  }

  private async mutation(input: MutationInput, kind: string, request: unknown, review: WorkspaceContentReview) {
    const view = await this.projectView(review, input.principal);
    return projectAudienceMutation(this.options.store, input, kind, request, review, view, this.now());
  }

  private projectAnnotation(
    annotation: WorkspaceContentAnnotation,
    principal: VideoProjectPrincipal,
    permission: 'read' | 'write' = 'read',
  ) {
    return projectMessageAnnotationProjection(annotation, principal, this.options.messageAuthority, permission);
  }

  private async projectView(review: WorkspaceContentReview, principal: VideoProjectPrincipal) {
    const view = await readVideoProjectReview(this.options.projects, review, principal, (annotation) =>
      this.projectAnnotation(annotation, principal),
    );
    return principal.actor.kind === 'human'
      ? view
      : {
          ...view,
          review: this.options.store.projectAudiences.observe(review, view.review, projectAudienceKey(principal)),
        };
  }

  private async projectMutation(result: WorkspaceReviewMutationResult, principal: VideoProjectPrincipal) {
    const view = await this.read({ principal, reviewId: result.review.reviewId });
    const receipt = await this.operationReceipt({
      principal,
      reviewId: result.review.reviewId,
      operationId: result.receipt.operationId,
    });
    if (!receipt) throw new WorkspaceContentReviewError('access_denied');
    return { ...result, receipt: { ...receipt, replayed: result.replayed }, review: view.review };
  }

  private assertPrincipal(principal: VideoProjectPrincipal) {
    if (principal.actor.kind === 'human' ? principal.actor.actorId !== principal.userId : !principal.invocationId)
      throw new WorkspaceContentReviewError('access_denied');
  }

  private async requireReview(
    principal: VideoProjectPrincipal,
    reviewId: string,
    permission: 'read' | 'write',
  ): Promise<WorkspaceContentReview> {
    this.assertPrincipal(principal);
    const review = this.options.store.get(validateWorkspaceReviewId(reviewId));
    if (!review) throw new WorkspaceContentReviewError('not_found');
    if (review.ownerUserId !== principal.userId) throw new WorkspaceContentReviewError('access_denied');
    if (review.source.kind !== 'video-project') throw new WorkspaceContentReviewError('unsupported_content');
    await this.options.projects.authorize({ principal, contentRef: review.contentRef, permission });
    return review;
  }
}
