import type { Readable } from 'node:stream';
import type {
  EvolutionMediaLocator,
  PublicationReviewContext,
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
  assertPublicationAnchorEvidence,
  type PublicationReviewPort,
  type PublicationReviewTarget,
  readPublicationReview,
  resolvePublicationReviewSource,
} from './publication-review-source.js';
import { type WorkspaceContentReviewStore, type WorkspaceReviewMutation } from './store.js';
import { readVideoProjectReview, type VideoProjectReviewPort } from './video-project-review-source.js';
import { applyWorkspaceReviewAction } from './workspace-review-actions.js';
import {
  assertWorkspaceReviewHuman,
  validateWorkspaceReviewBody,
  validateWorkspaceReviewId,
  workspaceAnnotationId,
} from './workspace-review-anchors.js';
import { appendWorkspaceSourceHistory, createWorkspaceReviewMutation } from './workspace-review-mutations.js';
import { openWorkspaceReviewMedia } from './workspace-review-open-media.js';
import {
  type MessageTakeoverReviewPreparation,
  prepareCanonicalWorkspaceReview,
  prepareWorkspaceReviewFromMessage,
} from './workspace-review-preparation.js';
import { readWorkspaceFileReview } from './workspace-review-read.js';
import { readRetainedWorkspaceReview, readRetainedWorkspaceRevision } from './workspace-review-retained-source.js';
import {
  resolveWorkspaceAnnotationTarget,
  resolveWorkspaceCurrentSource,
  type WorkspaceAnnotationTarget,
} from './workspace-review-source.js';
import type { WorkspaceReviewPrincipal } from './workspace-review-types.js';

export type { WorkspaceReviewPrincipal } from './workspace-review-types.js';

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
      readonly projects?: VideoProjectReviewPort;
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
    if ('publication' in input) {
      const contexts = await this.resolvePublication(input.publication, input.principal);
      if (contexts.some((context) => !context.ledgerRef))
        throw new WorkspaceContentReviewError('existing_contexts', contexts);
    }
    const created = prepareCanonicalWorkspaceReview(
      this.options.store,
      resolved,
      {
        principal: input.principal,
        operationId: input.operationId,
        request:
          'publication' in input
            ? { publication: input.publication }
            : 'evolution' in input
              ? { evolution: input.evolution }
              : { locator: input.locator },
      },
      this.now(),
    );
    return this.read({ principal: input.principal, reviewId: created.reviewId });
  }

  /** Called only by the authenticated original-Human takeover resolver, never a public route. */
  async ensureTextReviewFromMessageTakeover(input: MessageTakeoverReviewPreparation): Promise<WorkspaceContentReview> {
    return prepareWorkspaceReviewFromMessage(this.options, input, this.now);
  }

  async read(input: {
    readonly principal: WorkspaceReviewPrincipal;
    readonly reviewId: string;
  }): Promise<WorkspaceContentReviewView> {
    const review = this.requireOwnerReview(input.principal, input.reviewId);
    if (review.source.kind === 'publication')
      return readPublicationReview(this.options.publications, review, input.principal);
    if (review.source.kind === 'evolution') return readEvolutionReview(this.options.evolution, review, input.principal);
    if (review.source.kind === 'video-project')
      return readVideoProjectReview(this.options.projects, review, input.principal);
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
    const ownerReview = this.requireOwnerReview(input.principal, input.reviewId);
    if (ownerReview.source.kind === 'video-project') throw new WorkspaceContentReviewError('unsupported_content');
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
    if ('anchor' in anchor && anchor.anchor.kind === 'video-range' && anchor.anchor.storyEvidence) {
      const source = view.review.source;
      if (source.kind !== 'publication') throw new WorkspaceContentReviewError('invalid_action');
      await assertPublicationAnchorEvidence(
        this.options.publications,
        source.publication,
        anchor.anchor,
        input.principal,
      );
    }
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
    const ownerReview = this.requireOwnerReview(input.principal, input.reviewId);
    if (ownerReview.source.kind === 'video-project') throw new WorkspaceContentReviewError('unsupported_content');
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
    return openWorkspaceReviewMedia(this.options, view, input);
  }

  private requireOwnerReview(principal: WorkspaceReviewPrincipal, reviewId: string): WorkspaceContentReview {
    assertWorkspaceReviewHuman(principal);
    const review = this.options.store.get(reviewId);
    if (!review) throw new WorkspaceContentReviewError('not_found');
    if (review.collaborationScope || review.ownerUserId !== principal.userId)
      throw new WorkspaceContentReviewError('access_denied');
    return review;
  }
}
