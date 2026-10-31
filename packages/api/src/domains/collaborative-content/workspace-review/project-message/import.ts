import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type ProjectScreeningContextAttachment, projectScreeningContextAttachmentSchema } from '@cat-cafe/shared';
import { cursorFor } from '../../../cats/services/stores/cursor.js';
import {
  deriveGrowingSourceMessageRevision,
  type StoredMessage,
} from '../../../cats/services/stores/ports/MessageStore.js';
import type { VideoProjectPrincipal } from '../../../video-studio/project/access.js';
import type { VideoProjectScreeningService } from '../../../video-studio/project/screening-service.js';
import type { VideoProjectReadPort } from '../../../video-studio/project/types.js';
import { WorkspaceContentReviewError } from '../errors.js';
import type { WorkspaceContentReviewStore, WorkspaceReviewMutation } from '../store.js';
import { VideoProjectReviewService } from '../video-project-review-service.js';
import { videoProjectLedgerSource } from '../video-project-review-source.js';
import { validateWorkspaceReviewBody, workspaceAnnotationId } from '../workspace-review-anchors.js';
import { appendWorkspaceSourceHistory } from '../workspace-review-mutations.js';
import type { VideoProjectMessageAuthority } from './types.js';
import { validateProjectMessageSelection } from './validation.js';
import { isDeliveredProjectHuman } from './visibility.js';

export type ImportProjectMessageInput = {
  principal: VideoProjectPrincipal;
  contentRef: string;
  threadId: string;
  messageId: string;
  messageRevision: string;
  attachmentId: string;
  selectionId: string;
};
export function projectMessageImportOperation(
  source: Pick<ImportProjectMessageInput, 'messageId' | 'messageRevision' | 'attachmentId' | 'selectionId'>,
): string {
  return `project-message-${createHash('sha256')
    .update(JSON.stringify([source.messageId, source.messageRevision, source.attachmentId, source.selectionId]))
    .digest('hex')}`;
}

/** Original sent Human messages enter one canonical ledger, without another chat send or project-head refresh. */
export class VideoProjectMessageImporter {
  readonly reviews: VideoProjectReviewService;
  constructor(
    private readonly deps: {
      store: WorkspaceContentReviewStore;
      projects: VideoProjectReadPort;
      screenings: Pick<VideoProjectScreeningService, 'descriptor'>;
      authority: VideoProjectMessageAuthority;
      now?: () => string;
    },
  ) {
    this.reviews = new VideoProjectReviewService({ ...deps, messageAuthority: deps.authority });
  }

  async import(input: ImportProjectMessageInput) {
    await this.deps.projects.authorize({ ...input, permission: 'write' });
    const message = await this.readSource(input);
    const attachment = projectMessageAttachments(message).find((item) => item.id === input.attachmentId);
    const selection = attachment?.selections.find((item) => item.id === input.selectionId);
    if (!attachment || !selection || attachment.contentRef !== input.contentRef) invalid();
    const { screening } = await this.deps.screenings.descriptor({ ...input, screeningId: attachment.screeningId });
    const frozen = await this.deps.projects.load({ ...input, ownerRevision: screening.input.ownerRevision });
    const validated = validateProjectMessageSelection(attachment, selection, screening, frozen);
    const operationId = projectMessageImportOperation(input);
    const prepared = await this.reviews.prepare({
      ...input,
      ownerRevision: screening.input.ownerRevision,
      operationId: `prepare-${operationId}`,
    });
    const review = this.deps.store.get(prepared.review.reviewId);
    if (!review) invalid();
    const context = {
      source: {
        threadId: message.threadId,
        messageId: message.id,
        messageRevision: input.messageRevision,
        attachmentId: attachment.id,
        selectionId: selection.id,
        visibility: message.visibility ?? 'public',
        whisperTo: [...(message.whisperTo ?? [])],
      },
      screeningId: screening.id,
      input: screening.input,
      media: validated.media,
      selection: validated.selection,
    };
    const body = validateWorkspaceReviewBody(selection.comment ?? message.content);
    const recorded = this.deps.store.operationReceipt(review.reviewId, operationId);
    const mutation: WorkspaceReviewMutation = {
      reviewId: review.reviewId,
      expectedRevision: recorded ? recorded.revision - 1 : review.revision,
      operationId,
      actor: { kind: 'human', actorId: message.userId },
      now: this.deps.now?.() ?? new Date().toISOString(),
      kind: 'import:project-message',
      request: { body, anchor: validated.anchor, context },
    };
    // Revalidate after async owner reads. A recalled/edited source must not race its deferred import.
    const confirmed = await this.readSource(input);
    if (!isDeepStrictEqual(messageAudience(message), messageAudience(confirmed)))
      throw new WorkspaceContentReviewError('source_changed');
    const replay = this.deps.store.replay(mutation);
    const result =
      replay ??
      this.deps.store.mutate(mutation, (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: mutation.now,
        sourceHistory: appendWorkspaceSourceHistory(current, videoProjectLedgerSource(frozen)),
        annotations: [
          ...current.annotations,
          {
            id: workspaceAnnotationId(current.reviewId, operationId),
            operationId,
            anchor: validated.anchor,
            body,
            author: mutation.actor,
            createdAt: mutation.now,
            updatedAt: mutation.now,
            state: 'open',
            replies: [],
            projectMessage: context,
            projectHistory: [
              { kind: 'created', actor: mutation.actor, at: mutation.now, operationId, targets: [validated.anchor] },
            ],
          },
        ],
      }));
    return {
      ...result,
      review: (await this.reviews.read({ principal: input.principal, reviewId: review.reviewId })).review,
    };
  }

  /** A failed page stays pending; successful earlier rows replay idempotently on restart. */
  async synchronize(input: { principal: VideoProjectPrincipal; contentRef: string; threadId: string; limit?: number }) {
    if (input.principal.actor.kind !== 'human' || input.principal.actor.actorId !== input.principal.userId)
      throw new WorkspaceContentReviewError('access_denied');
    await this.deps.projects.authorize({ ...input, permission: 'write' });
    if ((await this.deps.projects.load(input)).document.archivedAt)
      throw new WorkspaceContentReviewError('source_changed');
    await this.deps.authority.authorizeSource({ ...input, permission: 'write' });
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid();
    const previous = this.deps.store.projectMessageImports.get(
      input.principal.userId,
      input.contentRef,
      input.threadId,
    );
    const page = await this.deps.authority.messages.getByThreadAfter(
      input.threadId,
      previous,
      limit,
      input.principal.userId,
    );
    let imported = 0;
    for (const message of page) imported += await this.importPageMessage(input, message);
    const last = page.at(-1);
    let cursor = last ? cursorFor(last) : previous;
    if (cursor && cursor !== previous)
      cursor = this.deps.store.projectMessageImports.advance(
        input.principal.userId,
        input.contentRef,
        input.threadId,
        previous,
        cursor,
      );
    return { imported, scanned: page.length, cursor, hasMore: page.length === limit };
  }

  private async importPageMessage(
    input: { principal: VideoProjectPrincipal; contentRef: string; threadId: string },
    message: StoredMessage,
  ) {
    if (!isDeliveredProjectHuman(message, input.principal.userId)) return 0;
    const selections = projectMessageAttachments(message)
      .filter((item) => item.contentRef === input.contentRef)
      .flatMap((attachment) =>
        attachment.selections.map((selection) => ({ attachmentId: attachment.id, selectionId: selection.id })),
      );
    for (const selection of selections)
      await this.import({
        ...input,
        ...selection,
        messageId: message.id,
        messageRevision: deriveGrowingSourceMessageRevision(message),
      });
    return selections.length;
  }

  private async readSource(input: ImportProjectMessageInput): Promise<StoredMessage> {
    await this.deps.authority.authorizeSource({ ...input, permission: 'write' });
    const message = await this.deps.authority.messages.getById(input.messageId);
    if (!message || !isDeliveredProjectHuman(message, input.principal.userId) || message.threadId !== input.threadId)
      invalid();
    if (deriveGrowingSourceMessageRevision(message) !== input.messageRevision)
      throw new WorkspaceContentReviewError('source_changed');
    if (input.principal.actor.kind === 'cat' && !message.mentions.some((id) => id === input.principal.actor.actorId))
      throw new WorkspaceContentReviewError('access_denied');
    if (
      input.principal.actor.kind === 'cat' &&
      message.visibility === 'whisper' &&
      !message.whisperTo?.some((id) => id === input.principal.actor.actorId)
    )
      throw new WorkspaceContentReviewError('access_denied');
    return structuredClone(message);
  }
}

export function projectMessageAttachments(message: StoredMessage): ProjectScreeningContextAttachment[] {
  const attachments = (message.contentBlocks ?? []).flatMap((block) => {
    if (block.type !== 'context_attachment' || block.attachment.kind !== 'project-screening') return [];
    const parsed = projectScreeningContextAttachmentSchema.safeParse(block.attachment);
    if (!parsed.success) invalid();
    return [parsed.data];
  });
  if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) invalid();
  return attachments;
}
function messageAudience(message: StoredMessage) {
  return { visibility: message.visibility ?? 'public', whisperTo: message.whisperTo ?? [] };
}
function invalid(): never {
  throw new WorkspaceContentReviewError('invalid_action');
}
