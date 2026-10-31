import { isDeepStrictEqual } from 'node:util';
import {
  type ArtifactReviewView,
  type ContentModificationRequest,
  contentModificationOutcome,
  contentModificationRequestContractSchema,
  type ImmutableMedia,
  type MediaContextAttachment,
} from '@cat-cafe/shared';
import type { StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import type { MediaReviewPrincipal } from '../../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../../video-studio/content-owner/published-media-service.js';
import { isTaskPublicationScope } from '../../../video-studio/content-owner/types.js';
import { assertMediaAnchor } from '../../artifact-review/anchors.js';
import type { ArtifactReviewService } from '../../artifact-review/service.js';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';
import type { WorkspaceContentReviewService } from '../../workspace-review/service.js';
import type { ModificationContentPort } from '../service.js';
import { ModificationTextError } from '../text/text-store.js';

export interface MediaMessageTakeoverDeps {
  content: ModificationContentPort;
  reviews: ArtifactReviewService;
  media: PublishedMediaService;
  files: WorkspaceContentReviewService;
  ledgers: WorkspaceContentReviewService;
  store: ArtifactReviewStore;
  tasks: Pick<ITaskStore, 'get'>;
}
type CatPrincipal = MediaReviewPrincipal & { actor: { kind: 'cat'; actorId: string }; threadId: string };

/** Only canonical owner reads validate a media reference. Display image bytes never participate. */
export async function resolveMediaMessagePayload(
  deps: MediaMessageTakeoverDeps,
  attachments: MediaContextAttachment[],
  message: StoredMessage,
  operationId: string,
  principal: CatPrincipal,
): Promise<ContentModificationRequest> {
  const first = matchingMediaAttachments(attachments);
  const owner = { userId: principal.userId, actor: { kind: 'human' as const, actorId: principal.userId } };
  let taskContext: ContentModificationRequest['taskContext'] = first.taskContext;
  if (first.source.kind === 'artifact-review') {
    const view = await deps.reviews.readCurrent(first.source.reviewId, owner);
    if (
      view.review.revision !== first.source.expectedReviewRevision ||
      view.review.rounds.at(-1)?.number !== first.source.round
    )
      throw new ModificationTextError('source_changed');
    const actual = contextForReview(view, principal);
    if (taskContext && !isDeepStrictEqual(taskContext, actual)) throw new ModificationTextError('task_changed');
    taskContext = actual;
  } else if (!taskContext) taskContext = await existingMediaContext(deps, first, owner, principal);
  const selections = attachments.flatMap((item) => item.selections);
  const payload = contentModificationRequestContractSchema.parse({
    operationId,
    targetCatId: principal.actor.actorId,
    threadId: principal.threadId,
    source: first.source,
    intent: { body: message.content, ...(selections.length ? { selections } : {}) },
    ...(taskContext ? { taskContext } : {}),
  });
  try {
    contentModificationOutcome(payload.intent);
  } catch {
    throw new ModificationTextError('invalid_patch');
  }
  await deps.content.inspect(payload, owner, false);
  const { media, mime } = await sourceMedia(deps, first, owner);
  if (mime !== first.mediaType) throw new ModificationTextError('source_changed');
  for (const selection of selections) assertMediaAnchor(selection.selection, media);
  return payload;
}

function matchingMediaAttachments(attachments: MediaContextAttachment[]) {
  const first = attachments[0];
  if (!first) throw new ModificationTextError('invalid_patch');
  if (attachments.length > 1 && attachments.some((item) => item.selections.length === 0))
    throw new ModificationTextError('invalid_patch');
  for (const item of attachments) {
    if (
      !isDeepStrictEqual(item.source, first.source) ||
      item.mediaType !== first.mediaType ||
      !isDeepStrictEqual(item.taskContext, first.taskContext)
    )
      throw new ModificationTextError('invalid_patch');
  }
  return first;
}

async function publicationTaskContext(
  deps: MediaMessageTakeoverDeps,
  source: MediaContextAttachment['source'],
  owner: MediaReviewPrincipal,
  principal: CatPrincipal,
) {
  if (source.kind !== 'publication') return undefined;
  const { scope } = await deps.media.origin(source.contentRef, owner);
  const originalTaskId = isTaskPublicationScope(scope) ? scope.taskId : undefined;
  const existing = deps.store.directory.forPublication(principal.userId, source.contentRef);
  const retained = existing.filter(
    (review) =>
      (!originalTaskId || review.task.taskId === originalTaskId) &&
      review.rounds.at(-1)?.asset.ownerRevision === source.ownerRevision &&
      review.rounds.at(-1)?.ledgerRef === source.ledgerRef,
  );
  if (!existing.length && !isTaskPublicationScope(scope)) return undefined;
  const review = retained[0];
  if (retained.length !== 1 || !review) throw new ModificationTextError('task_changed');
  return contextForReview(await deps.reviews.readCurrent(review.reviewId, owner), principal);
}

function contextForReview(view: ArtifactReviewView, principal: CatPrincipal) {
  const round = view.review.rounds.at(-1);
  if (
    !round ||
    !view.authority.canWrite ||
    view.authority.ownerCatId !== principal.actor.actorId ||
    view.review.task.threadId !== principal.threadId
  )
    throw new ModificationTextError('task_changed');
  return {
    kind: 'media' as const,
    taskId: view.review.task.taskId,
    expectedTaskRevision: view.authority.taskRevision,
    reviewId: view.review.reviewId,
    expectedReviewRevision: view.review.revision,
    round: round.number,
  };
}

async function existingMediaContext(
  deps: MediaMessageTakeoverDeps,
  attachment: MediaContextAttachment,
  owner: MediaReviewPrincipal,
  principal: CatPrincipal,
) {
  const contexts = new Map<string, ReturnType<typeof contextForReview>>();
  const original = await publicationTaskContext(deps, attachment.source, owner, principal);
  if (original) contexts.set(original.taskId, original);
  for (const record of deps.store.requests.forSource(principal.userId, attachment.source)) {
    if (
      record.progress.prepared?.kind !== 'media' ||
      !record.progress.review ||
      !record.progress.task ||
      record.payload.targetCatId !== principal.actor.actorId ||
      record.payload.threadId !== principal.threadId
    )
      continue;
    const task = await deps.tasks.get(record.progress.task.taskId);
    if (!task?.entrustedWork || task.status === 'done' || task.entrustedWork.closure.state !== 'open') continue;
    const view = await deps.reviews.readCurrent(record.progress.review.reviewId, owner);
    contexts.set(task.id, contextForReview(view, principal));
  }
  if (contexts.size > 1) throw new ModificationTextError('task_changed');
  return contexts.values().next().value;
}

async function sourceMedia(
  deps: MediaMessageTakeoverDeps,
  attachment: MediaContextAttachment,
  owner: MediaReviewPrincipal,
): Promise<{ media: ImmutableMedia; mime: string }> {
  const source = attachment.source;
  if (source.kind === 'artifact-review') {
    const view = await deps.reviews.readCurrent(source.reviewId, owner);
    const asset = view.review.rounds.find((round) => round.number === source.round)?.asset;
    if (!asset) throw new ModificationTextError('source_changed');
    return { media: asset.media, mime: asset.mediaType };
  }
  if (source.kind === 'publication') {
    const asset = await deps.media.read(source.contentRef, source.ownerRevision, owner);
    return { media: asset.media, mime: asset.mediaType };
  }
  const view = await (source.kind === 'workspace' ? deps.files : deps.ledgers).read({
    principal: owner,
    reviewId: source.reviewId,
  });
  const original = view.review.source;
  if (original.kind !== 'media' && original.kind !== 'evolution') throw new ModificationTextError('source_changed');
  return { media: original.media, mime: original.mime };
}
