import { basename } from 'node:path';
import type { ArtifactReviewAction, ContentModificationRequest, ReviewedMediaAsset } from '@cat-cafe/shared';
import { contentModificationOutcome } from '@cat-cafe/shared';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { ArtifactReviewError } from '../artifact-review/errors.js';
import { commitReviewAction } from '../artifact-review/linked-review-action.js';
import { applyArtifactReviewAction } from '../artifact-review/reducer.js';
import { createReviewCandidate } from '../artifact-review/review-candidate.js';
import type { ArtifactReviewService } from '../artifact-review/service.js';
import type { ArtifactReviewStore, ReviewMutation } from '../artifact-review/store.js';
import type { WorkspaceContentReviewService } from '../workspace-review/service.js';
import { assertModificationSupersession, cancelledModificationReplacement } from './control/supersession.js';
import {
  derivedModificationIntent,
  inspectEvolutionModification,
  prepareEvolutionModification,
} from './evolution-binding.js';
import type { ModificationFileLineage } from './file-lineage.js';
import {
  type ContentModificationProgress,
  type ContentModificationRecord,
  modificationOperationKeys,
} from './journal.js';
import { inspectLegacyModification } from './legacy-review-binding.js';
import type { ModificationContentPort } from './service.js';

type MediaPrepared = Extract<NonNullable<ContentModificationProgress['prepared']>, { kind: 'media' }>;

export class ModificationMediaBinding implements ModificationContentPort {
  constructor(
    private readonly deps: {
      media: PublishedMediaService;
      reviews: ArtifactReviewService;
      store: ArtifactReviewStore;
      ledgers: WorkspaceContentReviewService;
      files: WorkspaceContentReviewService;
      fileLineage: ModificationFileLineage;
    },
  ) {}

  async inspect(payload: ContentModificationRequest, principal: MediaReviewPrincipal, resuming: boolean) {
    if (principal.actor.kind !== 'human') throw new ArtifactReviewError('human_required');
    const source = payload.source;
    if (source.kind === 'artifact-review') {
      const { view } = await inspectLegacyModification(
        this.deps.reviews,
        this.deps.store,
        payload,
        principal,
        resuming,
      );
      return { title: view.review.title, completionRule: 'published-result-ready' as const };
    }
    if (source.kind === 'evolution')
      return inspectEvolutionModification(this.deps.ledgers, source, principal, resuming);
    if (source.kind === 'workspace') {
      await this.deps.files.describeSource({ principal, reviewId: source.reviewId, locator: source.locator });
      const view = await this.deps.files.read({ principal, reviewId: source.reviewId });
      if (view.review.source.kind !== 'media' || view.sourceState === 'unavailable')
        throw new ArtifactReviewError('access_denied');
      if (
        !resuming &&
        (!view.canWrite ||
          view.review.revision !== source.expectedReviewRevision ||
          view.review.source.revision !== source.expectedSourceRevision)
      )
        throw new ArtifactReviewError('asset_changed');
      return { title: basename(view.review.source.locator.path), completionRule: 'file-writeback-applied' as const };
    }
    const view = await this.deps.ledgers.read({ principal, reviewId: source.ledgerRef });
    if (
      view.review.source.kind !== 'publication' ||
      view.review.source.publication.contentRef !== source.contentRef ||
      view.review.source.publication.ownerRevision !== source.ownerRevision
    )
      throw new ArtifactReviewError('asset_changed');
    if (!resuming && (!view.canWrite || view.review.revision !== source.expectedLedgerRevision))
      throw new ArtifactReviewError('revision_conflict');
    const title = await this.publicationTitle(source.contentRef, principal);
    if (await this.deps.fileLineage.forPayload(payload, principal))
      return { title, completionRule: 'file-writeback-applied' as const };
    return { title, completionRule: 'published-result-ready' as const };
  }

  async validatePrepared(record: ContentModificationRecord, principal: MediaReviewPrincipal): Promise<void> {
    const prepared = record.progress.prepared;
    if (!prepared || prepared.kind !== 'media') throw new ArtifactReviewError('invalid_action');
    await this.deps.media.read(prepared.contentRef, prepared.ownerRevision, principal);
    // Existing committed requests may already have returned a newer version. Never rerun their modification.
    if (
      !record.progress.review &&
      (await this.deps.media.currentRevision(prepared.contentRef, principal)) !== prepared.ownerRevision
    )
      throw new ArtifactReviewError('asset_changed');
  }

  async prepare(record: ContentModificationRecord, principal: MediaReviewPrincipal): Promise<MediaPrepared> {
    if (principal.actor.kind !== 'human' || principal.userId !== record.ownerUserId)
      throw new ArtifactReviewError('human_required');
    const source = record.payload.source;
    if (source.kind === 'artifact-review') {
      const { round } = await inspectLegacyModification(
        this.deps.reviews,
        this.deps.store,
        record.payload,
        principal,
        false,
      );
      return {
        kind: 'media',
        contentRef: round.asset.contentRef,
        ownerRevision: round.asset.ownerRevision,
        legacyReview: { reviewId: source.reviewId, round: source.round },
      };
    }
    let asset: ReviewedMediaAsset;
    if (source.kind === 'publication') {
      const ledger = await this.deps.ledgers.read({ principal, reviewId: source.ledgerRef });
      if (
        ledger.review.source.kind !== 'publication' ||
        !ledger.canWrite ||
        ledger.review.revision !== source.expectedLedgerRevision ||
        ledger.review.source.publication.contentRef !== source.contentRef ||
        ledger.review.source.publication.ownerRevision !== source.ownerRevision
      )
        throw new ArtifactReviewError('asset_changed');
      asset = await this.deps.media.read(source.contentRef, source.ownerRevision, principal);
    } else if (source.kind === 'evolution')
      asset = await prepareEvolutionModification(this.deps.ledgers, this.deps.media, record, source, principal);
    else asset = await this.prepareWorkspace(record, principal, source);
    const ledger = await this.deps.ledgers.prepare({
      principal,
      publication: asset,
      operationId: modificationOperationKeys(record.requestId).snapshot,
    });
    return {
      kind: 'media',
      contentRef: asset.contentRef,
      ownerRevision: asset.ownerRevision,
      ledgerRef: ledger.review.reviewId,
    };
  }

  /** Fresh owner reads happen before this returns; the closure commits synchronously inside the journal transaction. */
  async prepareCommit(
    record: ContentModificationRecord,
    principal: MediaReviewPrincipal,
  ): Promise<() => NonNullable<ContentModificationProgress['review']>> {
    const prepared = record.progress.prepared,
      taskRef = record.progress.task;
    if (principal.actor.kind !== 'human' || !prepared || prepared.kind !== 'media' || !taskRef)
      throw new ArtifactReviewError('invalid_action');
    const task = await this.deps.media.access.authorize(taskRef.taskId, principal, {
      expectedRevision: taskRef.revision,
    });
    if (task.ownerCatId !== record.payload.targetCatId || task.threadId !== record.payload.threadId)
      throw new ArtifactReviewError('task_changed');
    const asset = await this.deps.media.read(prepared.contentRef, prepared.ownerRevision, principal);
    if ((await this.deps.media.currentRevision(prepared.contentRef, principal)) !== prepared.ownerRevision)
      throw new ArtifactReviewError('asset_changed');
    await this.deps.media.assertTaskAsset(
      asset,
      { ownerUserId: record.ownerUserId, threadId: task.threadId, taskId: task.id },
      principal,
    );
    let expectedLedgerRevision: number | undefined;
    if (prepared.legacyReview) {
      const { round } = await inspectLegacyModification(
        this.deps.reviews,
        this.deps.store,
        record.payload,
        principal,
        false,
      );
      if (
        round.asset.contentRef !== prepared.contentRef ||
        round.asset.ownerRevision !== prepared.ownerRevision ||
        record.payload.taskContext?.kind === 'text' ||
        prepared.legacyReview.reviewId !== record.payload.taskContext?.reviewId ||
        prepared.legacyReview.round !== round.number
      )
        throw new ArtifactReviewError('asset_changed');
    } else {
      if (!prepared.ledgerRef) throw new ArtifactReviewError('invalid_action');
      const ledger = await this.deps.ledgers.read({ principal, reviewId: prepared.ledgerRef });
      expectedLedgerRevision =
        record.payload.source.kind === 'publication' ? record.payload.source.expectedLedgerRevision : 1;
      if (!ledger.canWrite || ledger.review.revision !== expectedLedgerRevision)
        throw new ArtifactReviewError('revision_conflict');
    }
    const context = record.payload.taskContext;
    if (context?.kind === 'text') throw new ArtifactReviewError('invalid_action');
    const supersedes = context ? await this.assertTaskContext(context, prepared, task.id, principal) : null;
    const now = new Date().toISOString(),
      operationId = modificationOperationKeys(record.requestId).request;
    const candidate = createReviewCandidate({
      task,
      asset,
      ownerUserId: record.ownerUserId,
      taskRevision: taskRef.revision,
      now,
      linkedLedger: true,
    });
    const actor = principal.actor;
    const intent = await derivedModificationIntent(this.deps.ledgers, record, asset, principal);
    const action = this.action(record, asset, intent);
    const input: ReviewMutation = {
      reviewId: context?.reviewId ?? candidate.reviewId,
      expectedRevision: context?.expectedReviewRevision ?? 1,
      operationId,
      actor,
      now,
      round: context?.round ?? 1,
      kind: supersedes ? 'supersede_request' : action.kind,
      request: { requestId: record.requestId, action, ...(supersedes ? { supersedes } : {}) },
      returnTarget: {
        targetCatId: record.payload.targetCatId,
        expectedTaskRevision: taskRef.revision,
        requestId: record.requestId,
      },
    };
    return () => {
      if (!context) this.deps.store.create(candidate, { operationId: `${operationId}:bind`, actor, now });
      const result = commitReviewAction(
        this.deps.store,
        input,
        (review, receiptRef) => {
          if (supersedes) assertModificationSupersession(this.deps.store, review, input.round, supersedes);
          return applyArtifactReviewAction(review, {
            action,
            actor,
            round: input.round,
            ownerCatId: task.ownerCatId,
            now,
            receiptRef,
          });
        },
        expectedLedgerRevision,
      );
      return { reviewId: result.review.reviewId, round: input.round, receiptRef: result.receipt.receiptRef };
    };
  }

  private action(
    record: ContentModificationRecord,
    asset: ReviewedMediaAsset,
    intent: ContentModificationRequest['intent'],
  ): ArtifactReviewAction {
    if (intent.selection?.kind === 'text_quote') throw new ArtifactReviewError('invalid_action');
    const annotationId = `modify-${record.requestId.slice('f309-modification-'.length)}`;
    if (intent.imageEdit)
      return { kind: 'request_image_edit', annotationId, edit: intent.imageEdit, note: intent.body };
    return {
      kind: 'request_media_edit',
      mediaType: asset.mediaType,
      annotationId,
      body: contentModificationOutcome(intent),
      ...(intent.selection ? { anchor: intent.selection } : {}),
    };
  }

  private async assertTaskContext(
    context: Exclude<NonNullable<ContentModificationRequest['taskContext']>, { kind: 'text' }>,
    prepared: MediaPrepared,
    taskId: string,
    principal: MediaReviewPrincipal,
  ) {
    const current = await this.deps.reviews.read(context.reviewId, principal);
    const latest = current.review.rounds.at(-1);
    if (
      current.review.contentRef !== prepared.contentRef ||
      current.review.revision !== context.expectedReviewRevision ||
      current.review.task.taskId !== taskId ||
      current.review.rounds.at(-1)?.number !== context.round ||
      current.review.rounds.at(-1)?.ledgerRef !== prepared.ledgerRef ||
      !current.authority.canWrite
    )
      throw new ArtifactReviewError('task_changed');
    if (!latest) throw new ArtifactReviewError('invalid_action');
    const supersedes = cancelledModificationReplacement(this.deps.store, current.review, latest.number);
    if (!['draft', 'awaiting_human'].includes(latest.state) && !supersedes)
      throw new ArtifactReviewError('invalid_action');
    return supersedes;
  }

  private async publicationTitle(contentRef: string, principal: MediaReviewPrincipal): Promise<string> {
    const description = await this.deps.media.describe(contentRef, undefined, principal);
    return description.origin.title;
  }

  private async prepareWorkspace(
    record: ContentModificationRecord,
    principal: MediaReviewPrincipal,
    source: Extract<ContentModificationRequest['source'], { kind: 'workspace' }>,
  ): Promise<ReviewedMediaAsset> {
    if (principal.actor.kind !== 'human') throw new ArtifactReviewError('human_required');
    const descriptor = await this.deps.files.describeSource({
      principal,
      reviewId: source.reviewId,
      locator: source.locator,
    });
    const input = {
      principal,
      operationId: modificationOperationKeys(record.requestId).snapshot,
      source: {
        kind: 'workspace-snapshot' as const,
        threadId: record.payload.threadId,
        locator: descriptor.locator,
        expectedSourceRevision: source.expectedSourceRevision,
      },
    };
    const restored = await this.deps.media.findPreparedSource(input);
    const retained = restored
      ? await this.deps.files.retainedRevision({
          principal,
          reviewId: source.reviewId,
          revision: source.expectedReviewRevision,
        })
      : await this.deps.files.retainRevision({
          principal,
          reviewId: source.reviewId,
          expectedRevision: source.expectedReviewRevision,
        });
    if (retained.source.kind !== 'media' || retained.source.revision !== source.expectedSourceRevision)
      throw new ArtifactReviewError('asset_changed');
    return restored ?? this.deps.media.prepare(input);
  }
}
