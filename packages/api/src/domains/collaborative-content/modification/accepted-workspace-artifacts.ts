import { basename } from 'node:path';
import {
  type ContentModificationReceiptV1,
  contentModificationReceiptV1Schema,
  isSourceCodeExtension,
  type ThreadArtifactDTO,
} from '@cat-cafe/shared';
import { messageFrom } from '../../cats/services/stores/message-from.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import { WorkspaceContentSourceError } from '../../workspace/workspace-content-source.js';
import type { WorkspaceWritebackService } from '../../workspace/writeback/service.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { assertModificationSourceAuthority } from './request-authority.js';

export interface AppliedWorkspaceReceiptMessage {
  readonly messageId: string;
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly replyTo: string;
  readonly receipt: ContentModificationReceiptV1;
}

export interface AcceptedWorkspaceArtifactReaderPort {
  read(input: {
    ownerUserId: string;
    threadId: string;
    receipts: readonly AppliedWorkspaceReceiptMessage[];
  }): Promise<ThreadArtifactDTO[]>;
}

/** The artifact route is registered before the existing F309 owner composition. */
export interface AcceptedWorkspaceArtifactReaderHolder {
  current?: AcceptedWorkspaceArtifactReaderPort;
}

/** Retain only visible, server-issued receipt coordinates while raw message pages retire. */
export function projectAppliedWorkspaceReceipts(messages: readonly StoredMessage[]): AppliedWorkspaceReceiptMessage[] {
  const projected: AppliedWorkspaceReceiptMessage[] = [];
  for (const message of messages) {
    if (
      messageFrom(message).kind !== 'system' ||
      message.extra?.systemKind !== 'content_modification_receipt' ||
      !message.replyTo
    )
      continue;
    const parsed = contentModificationReceiptV1Schema.safeParse(message.extra.contentModificationReceiptV1);
    if (!parsed.success || parsed.data.state !== 'applied' || parsed.data.sourceMessageId !== message.replyTo) continue;
    projected.push({
      messageId: message.id,
      ownerUserId: message.userId,
      threadId: message.threadId,
      replyTo: message.replyTo,
      receipt: parsed.data,
    });
  }
  return projected;
}

/** Read the original accepted file, never the isolated candidate or an uploads publication copy. */
export class AcceptedWorkspaceArtifactReader implements AcceptedWorkspaceArtifactReaderPort {
  constructor(
    private readonly deps: {
      store: Pick<ArtifactReviewStore, 'requests' | 'text' | 'acceptances'>;
      messages: Pick<IMessageStore, 'getById'>;
      writer: Pick<WorkspaceWritebackService, 'findApplied'>;
    },
  ) {}

  async read(input: Parameters<AcceptedWorkspaceArtifactReaderPort['read']>[0]): Promise<ThreadArtifactDTO[]> {
    const artifacts: ThreadArtifactDTO[] = [];
    for (const message of input.receipts) {
      try {
        const artifact = await this.readReceipt(input.ownerUserId, input.threadId, message);
        if (artifact) artifacts.push(artifact);
      } catch (error) {
        if (
          (error instanceof MediaOwnerError && error.code === 'access_denied') ||
          (error instanceof WorkspaceContentSourceError && ['access_denied', 'not_found'].includes(error.code))
        )
          continue;
        throw error;
      }
    }
    return artifacts;
  }

  private async readReceipt(
    ownerUserId: string,
    threadId: string,
    message: AppliedWorkspaceReceiptMessage,
  ): Promise<ThreadArtifactDTO | undefined> {
    const receipt = message.receipt;
    const record = this.deps.store.requests.get(receipt.requestId, ownerUserId);
    if (
      message.threadId !== threadId ||
      (message.ownerUserId !== ownerUserId && message.ownerUserId !== 'system') ||
      !record ||
      record.ownerUserId !== ownerUserId ||
      record.payload.threadId !== threadId ||
      record.payload.source.kind !== 'workspace' ||
      record.progress.sourceMessageId !== message.replyTo ||
      receipt.sourceMessageId !== message.replyTo ||
      receipt.targetCatId !== record.payload.targetCatId ||
      receipt.taskId !== record.progress.task?.taskId
    )
      return undefined;
    await assertModificationSourceAuthority(this.deps.messages, record);
    const accepted = this.deps.store.acceptances
      .list(record.requestId, ownerUserId)
      .find((item) => item.fileReceiptRef === receipt.receiptRef && item.candidateRef === receipt.candidateRef);
    const proposal = this.deps.store.text
      .proposals(record.requestId)
      .find((item) => item.proposalRef === receipt.candidateRef);
    if (
      !accepted ||
      !proposal ||
      accepted.ownerUserId !== ownerUserId ||
      accepted.requestId !== record.requestId ||
      proposal.authorCatId !== record.payload.targetCatId
    )
      return undefined;
    const written = await this.deps.writer.findApplied(receipt.receiptRef, { userId: ownerUserId });
    if (
      !written ||
      written.requestId !== record.requestId ||
      written.candidateRef !== proposal.proposalRef ||
      written.acceptOperationId !== accepted.acceptOperationId ||
      written.writtenRevision !== proposal.resultRevision ||
      written.baseRevision !== accepted.baseRevision ||
      written.appliedAt !== receipt.observedAt ||
      written.locator.worktreeId !== accepted.locator.worktreeId ||
      written.locator.path !== accepted.locator.path ||
      written.locator.worktreeId !== record.payload.source.locator.worktreeId ||
      written.locator.path !== record.payload.source.locator.path
    )
      return undefined;
    const name = basename(written.targetPath);
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    return {
      type: isSourceCodeExtension(extension) ? 'code' : 'file',
      name,
      ref: written.targetPath,
      fileLedgerRef: written.targetPath,
      catId: proposal.authorCatId,
      sourceMessageId: message.messageId,
      createdAt: receipt.observedAt,
    };
  }
}
