import { isDeepStrictEqual } from 'node:util';
import {
  type ContentModificationRecord,
  type ContentModificationTakeover,
  contentModificationRequestContractSchema,
} from '@cat-cafe/shared';
import {
  deriveGrowingSourceMessageRevision,
  type StoredMessage,
} from '../../../cats/services/stores/ports/MessageStore.js';
import { WorkspaceContentReviewError } from '../../workspace-review/errors.js';
import { projectMessageAttachments } from '../../workspace-review/project-message/import.js';
import {
  isDeliveredProjectHuman,
  projectMessageAnnotationProjection,
} from '../../workspace-review/project-message/visibility.js';
import type { ResolvedMessageTakeover } from '../message/types.js';
import { ModificationTextError } from '../text/text-store.js';
import { validateProjectTakeoverRecord } from './record.js';
import type { ProjectCatPrincipal, ProjectMessageTakeoverDeps } from './types.js';

/** Explicit callback takeover must name a real running child that consumed this exact Human source. */
export async function resolveProjectMessageTakeover(
  deps: ProjectMessageTakeoverDeps,
  input: ContentModificationTakeover,
  principal: ProjectCatPrincipal,
  existing?: ContentModificationRecord,
): Promise<ResolvedMessageTakeover> {
  await assertProjectTakeoverChild(deps, input.sourceMessageId, principal);
  const stored = await deps.messages.getById(input.sourceMessageId);
  assertOriginalSource(stored, principal);
  const message = structuredClone(stored);
  await deps.authority.authorizeSource({
    principal,
    threadId: principal.threadId,
    messageId: message.id,
    permission: 'write',
  });
  const revision = deriveGrowingSourceMessageRevision(message) as `sha256:${string}`;
  if (existing) {
    if (
      existing.payload.source.kind !== 'video-project' ||
      existing.payload.targetCatId !== principal.actor.actorId ||
      existing.payload.threadId !== principal.threadId ||
      existing.progress.sourceMessageRevision !== revision
    )
      denied();
    await validateProjectTakeoverRecord(deps, existing);
    await assertProjectTakeoverChild(deps, input.sourceMessageId, principal);
    return { payload: existing.payload, sourceMessageRevision: revision, sourceVisibility: audience(message) };
  }
  const attachments = projectMessageAttachments(message);
  const first = attachments[0];
  if (
    !first ||
    attachments.some(
      (item) =>
        item.contentRef !== first.contentRef ||
        item.screeningId !== first.screeningId ||
        !isDeepStrictEqual(item.input, first.input) ||
        !isDeepStrictEqual(item.media, first.media),
    )
  )
    throw new ModificationTextError('invalid_patch');
  const retained = deps.store.ledgers.getByContent(principal.userId, first.contentRef);
  if (
    retained?.annotations.some(
      (item) =>
        item.projectMessage?.source.messageId === message.id && item.projectMessage.source.messageRevision !== revision,
    )
  )
    denied();
  const owner = { userId: principal.userId, actor: { kind: 'human' as const, actorId: principal.userId } };
  await importOriginalSelections(deps, attachments, owner, message, revision);
  const review = deps.store.ledgers.getByContent(principal.userId, first.contentRef);
  if (!review || review.source.kind !== 'video-project') denied();
  const annotations = review.annotations.filter(
    (item) =>
      item.projectMessage?.source.messageId === message.id && item.projectMessage.source.messageRevision === revision,
  );
  if (annotations.length !== attachments.reduce((count, item) => count + item.selections.length, 0)) denied();
  for (const annotation of annotations)
    if (!(await projectMessageAnnotationProjection(annotation, principal, deps.authority, 'write'))) denied();
  const selections = annotations.map((annotation) => ({
    id: annotation.id,
    selection: annotation.anchor,
    instruction: annotation.body,
  }));
  const payload = contentModificationRequestContractSchema.parse({
    operationId: input.operationId,
    targetCatId: principal.actor.actorId,
    threadId: message.threadId,
    source: {
      kind: 'video-project',
      contentRef: first.contentRef,
      reviewId: review.reviewId,
      expectedReviewRevision: review.revision,
      screeningId: first.screeningId,
      input: first.input,
      media: first.media,
      annotationIds: annotations.map((item) => item.id),
    },
    intent: { body: message.content, selection: selections[0]?.selection, selections },
  });
  const current = await deps.messages.getById(message.id);
  if (
    !current ||
    deriveGrowingSourceMessageRevision(current) !== revision ||
    !isDeepStrictEqual(audience(current), audience(message))
  )
    denied();
  await deps.authority.authorizeSource({
    principal,
    threadId: principal.threadId,
    messageId: message.id,
    permission: 'write',
  });
  await assertProjectTakeoverChild(deps, input.sourceMessageId, principal);
  return { payload, sourceMessageRevision: revision, sourceVisibility: audience(message) };
}

function audience(message: StoredMessage) {
  return message.visibility === 'whisper'
    ? { visibility: 'whisper' as const, whisperTo: [...new Set(message.whisperTo ?? [])] }
    : { visibility: 'public' as const };
}
function denied(): never {
  throw new WorkspaceContentReviewError('access_denied');
}

async function assertProjectTakeoverChild(
  deps: ProjectMessageTakeoverDeps,
  messageId: string,
  principal: ProjectCatPrincipal,
) {
  const child = principal.invocationId ? await deps.turns.get(principal.invocationId) : null;
  if (
    !child ||
    child.status !== 'running' ||
    child.userId !== principal.userId ||
    child.catId !== principal.actor.actorId ||
    child.threadId !== principal.threadId ||
    ![child.causal?.triggerMessageId, ...(child.causal?.coveredMessageIds ?? [])].includes(messageId)
  )
    denied();
}

function assertOriginalSource(
  stored: StoredMessage | null,
  principal: ProjectCatPrincipal,
): asserts stored is StoredMessage {
  if (
    !stored ||
    !isDeliveredProjectHuman(stored, principal.userId) ||
    stored.threadId !== principal.threadId ||
    !stored.mentions.some((cat) => cat === principal.actor.actorId) ||
    (stored.visibility === 'whisper' && !stored.whisperTo?.some((cat) => cat === principal.actor.actorId))
  )
    denied();
}

async function importOriginalSelections(
  deps: ProjectMessageTakeoverDeps,
  attachments: ReturnType<typeof projectMessageAttachments>,
  owner: { userId: string; actor: { kind: 'human'; actorId: string } },
  message: StoredMessage,
  revision: string,
) {
  for (const attachment of attachments)
    for (const selection of attachment.selections)
      await deps.importer.import({
        principal: owner,
        contentRef: attachment.contentRef,
        threadId: message.threadId,
        messageId: message.id,
        messageRevision: revision,
        attachmentId: attachment.id,
        selectionId: selection.id,
      });
}
