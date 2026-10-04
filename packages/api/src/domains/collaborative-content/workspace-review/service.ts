import { Readable } from 'node:stream';
import type {
  EvolutionMediaLocator,
  PublicationReviewContext,
  WorkspaceContentActor,
  WorkspaceContentReview,
  WorkspaceContentReviewAction,
  WorkspaceContentReviewView,
} from '@cat-cafe/shared';
import {
  type OpenWorkspaceMediaV1,
  type WorkspaceContentLocatorV1,
  type WorkspaceContentSourceService,
} from '../../workspace/workspace-content-source.js';
import { WorkspaceContentReviewError } from './errors.js';
import {
  type EvolutionMediaReadPort,
  readEvolutionReview,
  resolveEvolutionReviewSource,
} from './evolution-review-source.js';
import {
  type PublicationReviewPort,
  type PublicationReviewTarget,
  readPublicationReview,
  resolvePublicationReviewSource,
} from './publication-review-source.js';
import { type WorkspaceContentReviewStore, type WorkspaceReviewMutation } from './store.js';
import { applyWorkspaceReviewAction } from './workspace-review-actions.js';
import {
  assertWorkspaceReviewHuman,
  validateWorkspaceReviewBody,
  validateWorkspaceReviewId,
  workspaceAnnotationId,
  workspaceReviewIdentity,
} from './workspace-review-anchors.js';
import { appendWorkspaceSourceHistory, createWorkspaceReviewMutation } from './workspace-review-mutations.js';
import { readWorkspaceFileReview } from './workspace-review-read.js';
import { readRetainedWorkspaceReview, readRetainedWorkspaceRevision } from './workspace-review-retained-source.js';
import {
  resolveWorkspaceAnnotationTarget,
  resolveWorkspaceCurrentSource,
  type WorkspaceAnnotationTarget,
} from './workspace-review-source.js';

export interface WorkspaceReviewPrincipal {
  readonly userId: string;
  readonly actor: WorkspaceContentActor;
}

/** F309's task-free collaboration aggregate for F063 files and F138 publication versions. */
export class WorkspaceContentReviewService {
  private readonly now: () => string;

  constructor(
    private readonly options: {
      readonly store: WorkspaceContentReviewStore;
      readonly source: WorkspaceContentSourceService;
      readonly publications?: PublicationReviewPort;
      readonly publicationContexts?: (
        target: PublicationReviewTarget,
        principal: WorkspaceReviewPrincipal,
      ) => Promise<PublicationReviewContext[]>;
      readonly evolution?: EvolutionMediaReadPort;
      readonly now?: () => string;
    },
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async prepare(
    input: {
      readonly principal: WorkspaceReviewPrincipal;
      readonly operationId: string;
    } & (
      | { readonly locator: WorkspaceContentLocatorV1 }
      | { readonly publication: PublicationReviewTarget }
      | { readonly evolution: EvolutionMediaLocator }
    ),
  ): Promise<WorkspaceContentReviewView> {
    assertWorkspaceReviewHuman(input.principal);
    const resolved =
      'publication' in input
        ? await resolvePublicationReviewSource(this.options.publications, input.publication, input.principal)
        : 'evolution' in input
          ? await resolveEvolutionReviewSource(this.options.evolution, input.evolution, input.principal)
          : await resolveWorkspaceCurrentSource(this.options.source, {
              userId: input.principal.userId,
              locator: input.locator,
            });
    const { contentRef, source } = resolved;
    if ('publication' in input) {
      const contexts = await this.resolvePublication(input.publication, input.principal);
      if (contexts.some((context) => !context.ledgerRef))
        throw new WorkspaceContentReviewError('existing_contexts', contexts);
    }
    const existing = this.options.store.getByContent(input.principal.userId, contentRef);
    const now = this.now();
    if (existing) {
      validateWorkspaceReviewId(input.operationId);
      return this.read({ principal: input.principal, reviewId: existing.reviewId });
    }
    const review: WorkspaceContentReview = {
      version: 1,
      reviewId: workspaceReviewIdentity(input.principal.userId, contentRef),
      ownerUserId: input.principal.userId,
      contentRef,
      source,
      sourceHistory: [source],
      revision: 1,
      annotations: [],
      createdAt: now,
      updatedAt: now,
    };
    const created = this.options.store.create(review, {
      operationId: validateWorkspaceReviewId(input.operationId),
      actor: input.principal.actor,
      now,
      kind: 'prepare',
      request:
        'publication' in input
          ? { publication: input.publication }
          : 'evolution' in input
            ? { evolution: input.evolution }
            : { locator: input.locator },
    });
    return this.read({ principal: input.principal, reviewId: created.reviewId });
  }

  async read(input: {
    readonly principal: WorkspaceReviewPrincipal;
    readonly reviewId: string;
  }): Promise<WorkspaceContentReviewView> {
    const review = this.requireOwnerReview(input.principal, input.reviewId);
    if (review.source.kind === 'publication')
      return readPublicationReview(this.options.publications, review, input.principal);
    if (review.source.kind === 'evolution') return readEvolutionReview(this.options.evolution, review, input.principal);
    return readWorkspaceFileReview(this.options.source, review, input.principal);
  }

  async resolvePublication(
    target: PublicationReviewTarget,
    principal: WorkspaceReviewPrincipal,
  ): Promise<PublicationReviewContext[]> {
    assertWorkspaceReviewHuman(principal);
    await resolvePublicationReviewSource(this.options.publications, target, principal);
    return this.options.publicationContexts?.(target, principal) ?? [];
  }

  async operationReceipt(input: { principal: WorkspaceReviewPrincipal; reviewId: string; operationId: string }) {
    const view = await this.read(input);
    if (view.sourceState === 'unavailable') throw new WorkspaceContentReviewError('access_denied');
    return this.options.store.operationReceipt(input.reviewId, validateWorkspaceReviewId(input.operationId));
  }

  async annotate(input: {
    readonly principal: WorkspaceReviewPrincipal;
    readonly reviewId: string;
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly body: string;
    readonly target: WorkspaceAnnotationTarget;
  }) {
    this.requireOwnerReview(input.principal, input.reviewId);
    const mutation = createWorkspaceReviewMutation(input, 'annotate', this.now());
    const replay = this.options.store.replay(mutation);
    if (replay) return { ...replay, replayed: true };
    const view = await this.read({ principal: input.principal, reviewId: input.reviewId });
    if (!view.canWrite) throw new WorkspaceContentReviewError('source_changed');
    if (view.review.revision !== input.expectedRevision) throw new WorkspaceContentReviewError('revision_conflict');
    const now = this.now();
    const anchor = await resolveWorkspaceAnnotationTarget(this.options.source, {
      userId: input.principal.userId,
      review: view.review,
      target: input.target,
    });
    const result = this.options.store.mutate(mutation, (review) => ({
      ...review,
      revision: review.revision + 1,
      updatedAt: now,
      annotations: [
        ...review.annotations,
        {
          id: workspaceAnnotationId(review.reviewId, input.operationId),
          operationId: input.operationId,
          anchor,
          body: validateWorkspaceReviewBody(input.body),
          author: input.principal.actor,
          createdAt: now,
          updatedAt: now,
          state: 'open',
          replies: [],
        },
      ],
    }));
    return { ...result, replayed: false };
  }

  async act(input: {
    readonly principal: WorkspaceReviewPrincipal;
    readonly reviewId: string;
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly action: WorkspaceContentReviewAction;
  }) {
    this.requireOwnerReview(input.principal, input.reviewId);
    const mutation: WorkspaceReviewMutation = {
      reviewId: input.reviewId,
      expectedRevision: input.expectedRevision,
      operationId: validateWorkspaceReviewId(input.operationId),
      actor: input.principal.actor,
      now: this.now(),
      kind: `action:${input.action.kind}`,
      request: { action: input.action },
    };
    const replay = this.options.store.replay(mutation);
    if (replay) return { ...replay, replayed: true };
    const view = await this.read({ principal: input.principal, reviewId: input.reviewId });
    const source = view.currentSource;
    const permitted = input.action.kind === 'reply' ? (view.canReply ?? view.canWrite) : view.canWrite;
    if (!permitted || !source) throw new WorkspaceContentReviewError('source_changed');
    if (view.review.revision !== input.expectedRevision) throw new WorkspaceContentReviewError('revision_conflict');
    const result = this.options.store.mutate(mutation, (review) => ({
      ...applyWorkspaceReviewAction({
        review,
        source,
        actor: input.principal.actor,
        action: input.action,
        now: mutation.now,
      }),
      revision: review.revision + 1,
      updatedAt: mutation.now,
    }));
    return { ...result, replayed: false };
  }

  async refresh(input: {
    readonly principal: WorkspaceReviewPrincipal;
    readonly reviewId: string;
    readonly expectedRevision: number;
    readonly operationId: string;
    /**
     * Only move the review onto this exact source revision (e.g. the one the person just accepted).
     * If the file has since become something else, stay put so that drift is still shown and confirmed.
     */
    readonly expectedSourceRevision?: string;
  }): Promise<WorkspaceContentReviewView> {
    const review = this.requireOwnerReview(input.principal, input.reviewId);
    if (review.source.kind !== 'text' && review.source.kind !== 'media')
      throw new WorkspaceContentReviewError('invalid_action');
    const mutation = createWorkspaceReviewMutation(input, 'refresh', this.now());
    const replay = this.options.store.replay(mutation);
    if (replay) return this.read({ principal: input.principal, reviewId: replay.review.reviewId });
    const current = await resolveWorkspaceCurrentSource(this.options.source, {
      userId: input.principal.userId,
      locator: review.source.locator,
    });
    const currentSource = current.source;
    if (current.contentRef !== review.contentRef || currentSource.kind !== review.source.kind)
      throw new WorkspaceContentReviewError('source_unavailable');
    if (review.revision !== input.expectedRevision) throw new WorkspaceContentReviewError('revision_conflict');
    const fencedAway =
      input.expectedSourceRevision !== undefined && currentSource.revision !== input.expectedSourceRevision;
    if (fencedAway || review.source.revision === currentSource.revision) {
      this.options.store.recordNoop(mutation);
      return this.read({ principal: input.principal, reviewId: review.reviewId });
    }
    const now = this.now();
    this.options.store.mutate(mutation, (current) => ({
      ...current,
      source: currentSource,
      sourceHistory: appendWorkspaceSourceHistory(current, currentSource),
      revision: current.revision + 1,
      updatedAt: now,
    }));
    return this.read({ principal: input.principal, reviewId: review.reviewId });
  }

  async retainRevision(input: {
    principal: WorkspaceReviewPrincipal;
    reviewId: string;
    expectedRevision: number;
  }): Promise<WorkspaceContentReview> {
    this.requireOwnerReview(input.principal, input.reviewId);
    const retained = this.options.store.retained.get(input.reviewId, input.expectedRevision);
    if (retained) return readRetainedWorkspaceReview(this.options, input.principal, retained);
    const view = await this.read(input);
    if (!view.canWrite || view.review.revision !== input.expectedRevision)
      throw new WorkspaceContentReviewError('revision_conflict');
    return this.options.store.retained.retain(input.reviewId, input.expectedRevision);
  }

  async describeSource(input: {
    principal: WorkspaceReviewPrincipal;
    reviewId: string;
    locator: WorkspaceContentLocatorV1;
  }) {
    const review = this.requireOwnerReview(input.principal, input.reviewId);
    if (review.source.kind !== 'text' && review.source.kind !== 'media')
      throw new WorkspaceContentReviewError('invalid_action');
    const source = await this.options.source.describe({
      principal: { userId: input.principal.userId },
      locator: input.locator,
    });
    if (source.contentRef !== review.contentRef) throw new WorkspaceContentReviewError('source_changed');
    return source;
  }

  async retainedRevision(
    input: {
      principal: WorkspaceReviewPrincipal;
      reviewId: string;
      revision: number;
    },
    authorizeTask?: () => Promise<void>,
  ): Promise<WorkspaceContentReview> {
    return readRetainedWorkspaceRevision(this.options, input, authorizeTask);
  }

  async openMedia(input: {
    readonly principal: WorkspaceReviewPrincipal;
    readonly reviewId: string;
    readonly expectedSourceRevision: string;
  }): Promise<OpenWorkspaceMediaV1 | { mime: string; byteLength: number; stream: Readable }> {
    const view = await this.read({ principal: input.principal, reviewId: input.reviewId });
    if (view.sourceState !== 'current' || !view.canWrite) throw new WorkspaceContentReviewError('source_changed');
    if (view.review.source.kind === 'evolution') {
      if (view.review.source.revision !== input.expectedSourceRevision || !this.options.evolution)
        throw new WorkspaceContentReviewError('source_changed');
      const original = await this.options.evolution.read(view.review.source.locator, input.principal);
      return { mime: original.mime, byteLength: original.bytes.length, stream: Readable.from([original.bytes]) };
    }
    if (view.review.source.kind !== 'media' || view.review.source.revision !== input.expectedSourceRevision)
      throw new WorkspaceContentReviewError('source_changed');
    const media = await this.options.source.openMedia({
      principal: { userId: input.principal.userId },
      locator: view.review.source.locator,
      expectedRevision: input.expectedSourceRevision,
    });
    if (media.contentRef !== view.review.contentRef) {
      throw new WorkspaceContentReviewError('source_unavailable');
    }
    return media;
  }

  private requireOwnerReview(principal: WorkspaceReviewPrincipal, reviewId: string): WorkspaceContentReview {
    assertWorkspaceReviewHuman(principal);
    const review = this.options.store.get(reviewId);
    if (!review) throw new WorkspaceContentReviewError('not_found');
    if (review.ownerUserId !== principal.userId) throw new WorkspaceContentReviewError('access_denied');
    return review;
  }
}
