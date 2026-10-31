import { isDeepStrictEqual } from 'node:util';
import type { ContentModificationRecord, WorkspaceContentAnnotation } from '@cat-cafe/shared';
import type { StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { WorkspaceContentReviewError } from '../../workspace-review/errors.js';
import { projectMessageAttachments } from '../../workspace-review/project-message/import.js';
import {
  isDeliveredProjectHuman,
  projectMessageAnnotationProjection,
} from '../../workspace-review/project-message/visibility.js';
import { requireModificationSourceMessage } from '../request-authority.js';
import type { ProjectMessageTakeoverDeps } from './types.js';
/** Frozen input and original opinion identities survive later project and ledger revisions. */
export async function validateProjectTakeoverRecord(
  deps: ProjectMessageTakeoverDeps,
  record: ContentModificationRecord,
  permission: 'read' | 'write' = 'write',
): Promise<WorkspaceContentAnnotation[]> {
  const source = record.payload.source;
  if (source.kind !== 'video-project' || record.progress.sourceKind !== 'human_message') denied();
  const message = await requireModificationSourceMessage(deps.messages, record);
  if (
    !isDeliveredProjectHuman(message, record.ownerUserId) ||
    !isDeepStrictEqual(audience(message), record.progress.sourceVisibility)
  )
    denied();
  const principal = { userId: record.ownerUserId, actor: { kind: 'human' as const, actorId: record.ownerUserId } };
  await deps.authority.authorizeSource({
    principal,
    threadId: record.payload.threadId,
    messageId: message.id,
    permission,
  });
  // Current Cat rights cannot be replaced by the server's internal Human principal during durable recovery.
  await deps.authority.authorizeSource({
    principal: { userId: record.ownerUserId, actor: { kind: 'cat', actorId: record.payload.targetCatId } },
    threadId: record.payload.threadId,
    messageId: message.id,
    permission,
  });
  const frozen = await deps.projects.load({
    principal,
    contentRef: source.contentRef,
    ownerRevision: source.input.ownerRevision,
  });
  const current = await deps.projects.load({ principal, contentRef: source.contentRef });
  if (frozen.blobDigest !== source.input.blobDigest || current.document.archivedAt) denied();
  const review = deps.store.ledgers.get(source.reviewId);
  if (
    !review ||
    review.ownerUserId !== record.ownerUserId ||
    review.contentRef !== source.contentRef ||
    review.source.kind !== 'video-project'
  )
    denied();
  const attachments = projectMessageAttachments(message);
  const annotations: WorkspaceContentAnnotation[] = [];
  for (const [index, id] of source.annotationIds.entries()) {
    const annotation = review.annotations.find((item) => item.id === id);
    const context = annotation?.projectMessage;
    const attachment = context && attachments.find((item) => item.id === context.source.attachmentId);
    const selection = attachment?.selections.find((item) => item.id === context?.source.selectionId);
    if (
      !annotation ||
      !context ||
      !attachment ||
      !selection ||
      context.source.messageId !== message.id ||
      context.source.messageRevision !== record.progress.sourceMessageRevision ||
      context.screeningId !== source.screeningId ||
      !isDeepStrictEqual(context.input, source.input) ||
      !isDeepStrictEqual(context.media, source.media) ||
      !isDeepStrictEqual(record.payload.intent.selections?.[index]?.selection, annotation.anchor) ||
      !isDeepStrictEqual(selection.target, context.selection.target) ||
      !isDeepStrictEqual(selection.mediaRange, context.selection.mediaRange) ||
      annotation.body !== (selection.comment ?? message.content).trim() ||
      !(await projectMessageAnnotationProjection(annotation, principal, deps.authority, permission))
    )
      denied();
    annotations.push(annotation);
  }
  await requireModificationSourceMessage(deps.messages, record);
  return annotations;
}
function audience(message: StoredMessage) {
  return message.visibility === 'whisper'
    ? { visibility: 'whisper' as const, whisperTo: [...new Set(message.whisperTo ?? [])] }
    : { visibility: 'public' as const };
}
function denied(): never {
  throw new WorkspaceContentReviewError('access_denied');
}
