import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createCatId, MediaContextAttachmentSchema } from '@cat-cafe/shared';
import {
  deriveGrowingSourceMessageRevision,
  type IMessageStore,
  isDelivered,
} from '../../cats/services/stores/ports/MessageStore.js';
import { resolveVisibleReplyParent } from '../../cats/services/stores/visibility.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { publicationLedgerId } from '../artifact-review/canonical-ledger.js';
import { ArtifactReviewError } from '../artifact-review/errors.js';
import type { ArtifactReviewInspection } from '../artifact-review/inspection.js';
import { leafRecords, pageRecords } from '../inspection-records.js';
import { publicationLedgerSource } from './publication-review-source.js';
import type { WorkspaceContentReviewStore } from './store.js';
import { resolveWorkspaceReviewVisualMarks } from './workspace-review-annotation-resolution.js';

export interface PublicationReviewReadDeps {
  readonly media: Pick<PublishedMediaService, 'read' | 'currentRevision'>;
  readonly ledgers: Pick<WorkspaceContentReviewStore, 'get'>;
  readonly messages: Pick<IMessageStore, 'getById'>;
}

/** Read the existing publication ledger in a visible Human message, without Task admission or writes. */
export async function inspectPublicationMessageReview(
  deps: PublicationReviewReadDeps,
  input: ArtifactReviewInspection,
  principal: MediaReviewPrincipal,
) {
  if (!input.sourceMessageId || input.round || input.view === 'history' || input.afterHistoryRevision)
    throw new ArtifactReviewError('invalid_action');
  const original = await readQuestion(deps, input, principal);
  const source = original.attachment.source;
  if (source.kind !== 'publication') throw new ArtifactReviewError('invalid_action');
  const review = deps.ledgers.get(input.reviewId);
  if (!review || review.ownerUserId !== principal.userId || review.collaborationScope)
    throw new ArtifactReviewError('access_denied');
  if (
    source.ledgerRef !== review.reviewId ||
    source.expectedLedgerRevision !== review.revision ||
    (input.expectedRevision && input.expectedRevision !== review.revision) ||
    (input.cursor > 0 && (!input.expectedRevision || !input.expectedSourceSnapshot)) ||
    (input.expectedSourceSnapshot && input.expectedSourceSnapshot !== original.snapshot)
  )
    throw new ArtifactReviewError('revision_conflict');
  // The real cat remains the principal. The media owner rechecks the source thread/message and immutable version.
  const asset = await deps.media.read(source.contentRef, source.ownerRevision, principal);
  if (
    review.reviewId !== publicationLedgerId(principal.userId, asset) ||
    review.contentRef !== `${asset.contentRef}#version:${asset.ownerRevision}` ||
    original.attachment.mediaType !== asset.mediaType ||
    !isDeepStrictEqual(review.source, publicationLedgerSource(asset))
  )
    throw new ArtifactReviewError('asset_changed');
  const currentOwnerRevision = await deps.media.currentRevision(source.contentRef, principal);
  const current = await readQuestion(deps, input, principal);
  if (current.snapshot !== original.snapshot || deps.ledgers.get(review.reviewId)?.revision !== review.revision)
    throw new ArtifactReviewError('revision_conflict');
  const value =
    input.view === 'marks'
      ? (review.visualMarks ?? [])
      : input.view === 'annotations'
        ? review.annotations
        : {
            title: original.attachment.title,
            source: review.source,
            sourceMessageId: input.sourceMessageId,
            attachmentId: original.attachment.id,
            selections: original.attachment.selections,
            annotationCount: review.annotations.length,
            visualMarkCount: review.visualMarks?.filter((mark) => mark.state === 'active').length ?? 0,
            visualMarkResolutions: resolveWorkspaceReviewVisualMarks(review, review.source),
          };
  const records = leafRecords(value);
  if (input.cursor > records.length) throw new ArtifactReviewError('invalid_action');
  return pageRecords(
    {
      reviewId: review.reviewId,
      revision: review.revision,
      sourceMessageId: input.sourceMessageId,
      attachmentId: original.attachment.id,
      sourceSnapshot: original.snapshot,
      source,
      section: input.view,
      authority: { state: currentOwnerRevision === asset.ownerRevision ? 'current' : 'historical', canWrite: false },
      trust: 'untrusted_review_data' as const,
      records: [] as ReturnType<typeof leafRecords>,
      nextCursor: null as number | null,
    },
    records,
    input.cursor,
    input.maxChars,
  );
}

async function readQuestion(
  deps: PublicationReviewReadDeps,
  input: ArtifactReviewInspection,
  principal: MediaReviewPrincipal,
) {
  if (principal.actor.kind !== 'cat' || !principal.threadId || !input.sourceMessageId)
    throw new ArtifactReviewError('access_denied');
  const visible = await resolveVisibleReplyParent(deps.messages, input.sourceMessageId, {
    threadId: principal.threadId,
    viewer: { type: 'cat', catId: createCatId(principal.actor.actorId) },
  });
  const message = visible ? structuredClone(visible) : null;
  if (
    !message ||
    message.threadId !== principal.threadId ||
    message.userId !== principal.userId ||
    message.catId !== null ||
    message.source !== undefined ||
    message.sourceParseFailure ||
    message.recall ||
    message.deletedAt !== undefined ||
    message._tombstone ||
    !isDelivered(message)
  )
    throw new ArtifactReviewError('access_denied');
  const attachments = (message.contentBlocks ?? []).flatMap((block) => {
    if (block.type !== 'context_attachment' || block.attachment.kind !== 'media') return [];
    const parsed = MediaContextAttachmentSchema.safeParse(block.attachment);
    if (!parsed.success) throw new ArtifactReviewError('invalid_action');
    return [parsed.data];
  });
  const selected = input.attachmentId ? attachments.filter((item) => item.id === input.attachmentId) : attachments;
  if (selected.length > 1) throw new ArtifactReviewError('invalid_action');
  const attachment = selected[0];
  if (!attachment || attachment.source.kind !== 'publication' || attachment.source.ledgerRef !== input.reviewId)
    throw new ArtifactReviewError('access_denied');
  const snapshot = `sha256:${createHash('sha256')
    .update(
      JSON.stringify([
        message.id,
        deriveGrowingSourceMessageRevision(message),
        message.visibility ?? 'public',
        message.whisperTo ?? [],
        message.revealedAt ?? null,
        attachment.id,
      ]),
    )
    .digest('hex')}`;
  return { attachment, snapshot };
}
