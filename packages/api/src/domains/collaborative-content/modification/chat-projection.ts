import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ContentModificationAcceptance,
  type ContentModificationReceiptV1,
  type ContentModificationRecord,
  type ContentModificationRejection,
  type ContentTextProposal,
  type ContentWritebackReceipt,
  contentModificationFollowUpCarrierV1Schema,
  contentModificationReceiptV1Schema,
  createCatId,
} from '@cat-cafe/shared';
import type { PersistedQueueDeliveryPort } from '../../cats/services/agents/invocation/PersistedQueueDelivery.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { WorkspaceWritebackService, WorkspaceWritebackView } from '../../workspace/writeback/service.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import type { ModificationReceiptEvent } from './media-message/media-chat-events.js';

type ReceiptState = ContentModificationReceiptV1['state'];
type ReceiptFollowUp = ContentModificationReceiptV1['followUp'];

interface ProjectionTask {
  readonly id: string;
  readonly userId?: string;
  readonly threadId: string;
  readonly ownerCatId: string | null;
  readonly status: string;
  readonly entrustedWork?: { readonly closure: { readonly state: string } };
}

type ReceiptEvent = ModificationReceiptEvent;

export interface ContentModificationChatProjectionResult {
  readonly message: StoredMessage;
  readonly receipt: ContentModificationReceiptV1;
  readonly idempotent: boolean;
}

/**
 * Durable, content-free chat projection of candidate and human-decision truth.
 * The message is a Host system record; it never impersonates the Human or Cat and never owns file effects.
 */
export class ContentModificationChatProjection {
  constructor(
    private readonly deps: {
      messages: Pick<IMessageStore, 'appendIdempotent' | 'getByIdempotencyKey'>;
      tasks: { get(taskId: string): ProjectionTask | null | Promise<ProjectionTask | null> };
      delivery?: PersistedQueueDeliveryPort;
      store?: Pick<ArtifactReviewStore, 'requests' | 'text' | 'acceptances'>;
      writer?: Pick<WorkspaceWritebackService, 'find'>;
      mediaEvents?: (record: ContentModificationRecord) => Promise<ReceiptEvent[]>;
      authorizeMediaReceipt?: (record: ContentModificationRecord) => Promise<unknown>;
      recoverPublication?: (record: ContentModificationRecord) => Promise<void>;
      recoverTextCompletion?: (
        record: ContentModificationRecord,
        acceptance: ContentModificationAcceptance,
      ) => Promise<void>;
      onSaved: (ownerUserId: string, threadId: string, messageId: string) => void | Promise<void>;
      onError: (error: unknown) => void;
    },
  ) {}

  /** Repairs a crash between canonical candidate/decision persistence and the idempotent chat append. */
  async recover(limit = 1000): Promise<void> {
    if (!this.deps.store || !this.deps.writer) return;
    const projections: { observedAt: number; project: () => Promise<unknown> }[] = [];
    for (const record of this.deps.store.requests.recentForProjection(limit)) {
      try {
        await this.deps.recoverPublication?.(record);
      } catch (error) {
        this.deps.onError(error);
      }
      for (const event of await this.readMediaEvents(record)) {
        projections.push({ observedAt: event.observedAt, project: () => this.attempt(record, event) });
      }
      for (const proposal of this.deps.store.text.proposals(record.requestId)) {
        projections.push({
          observedAt: proposal.createdAt,
          project: () => this.projectCandidate(record, proposal),
        });
      }
      for (const rejection of this.deps.store.acceptances.rejections(record.requestId, record.ownerUserId)) {
        projections.push({
          observedAt: rejection.rejectedAt,
          project: () => this.projectRejection(record, rejection),
        });
      }
      for (const acceptance of this.deps.store.acceptances.list(record.requestId, record.ownerUserId)) {
        try {
          const receipt = await this.deps.writer.find(acceptance.fileReceiptRef, { userId: record.ownerUserId });
          if (receipt && receipt.state !== 'intent' && receipt.state !== 'prepared') {
            const visible = publicWritebackReceipt(receipt);
            projections.push({
              observedAt: visible.appliedAt ?? acceptance.acceptedAt,
              project: () => this.projectWriteback(record, acceptance, visible),
            });
            if (record.progress.prepared?.kind === 'text' && visible.state === 'applied')
              await this.deps.recoverTextCompletion?.(record, acceptance);
          }
        } catch (error) {
          this.deps.onError(error);
        }
      }
    }
    projections.sort((left, right) => left.observedAt - right.observedAt);
    for (const projection of projections) await projection.project();
  }

  async projectMedia(record: ContentModificationRecord) {
    for (const event of await this.readMediaEvents(record)) await this.attempt(record, event);
  }

  private async readMediaEvents(record: ContentModificationRecord): Promise<ReceiptEvent[]> {
    try {
      return (await this.deps.mediaEvents?.(record)) ?? [];
    } catch (error) {
      this.deps.onError(error);
      return [];
    }
  }

  projectCandidate(record: ContentModificationRecord, proposal: ContentTextProposal) {
    return this.attempt(record, {
      state: 'candidate',
      candidateRef: proposal.proposalRef,
      receiptRef: proposal.receiptRef,
      observedAt: proposal.createdAt,
    });
  }

  projectRejection(record: ContentModificationRecord, rejection: ContentModificationRejection) {
    return this.attempt(record, {
      state: 'rejected',
      candidateRef: rejection.candidateRef,
      receiptRef: rejection.receiptRef,
      observedAt: rejection.rejectedAt,
    });
  }

  projectWriteback(
    record: ContentModificationRecord,
    acceptance: ContentModificationAcceptance,
    receipt: ContentWritebackReceipt,
  ) {
    if (receipt.state === 'intent' || receipt.state === 'prepared') return Promise.resolve(undefined);
    return this.attempt(record, {
      state: receipt.state,
      candidateRef: receipt.candidateRef,
      receiptRef: receipt.receiptRef,
      observedAt: receipt.appliedAt ?? acceptance.acceptedAt,
    });
  }

  private async attempt(
    record: ContentModificationRecord,
    event: ReceiptEvent,
  ): Promise<ContentModificationChatProjectionResult | undefined> {
    try {
      return await this.project(record, event);
    } catch (error) {
      this.deps.onError(error);
      return undefined;
    }
  }

  private async project(
    record: ContentModificationRecord,
    event: ReceiptEvent,
  ): Promise<ContentModificationChatProjectionResult> {
    const sourceMessageId = record.progress.sourceMessageId;
    const taskId = record.progress.task?.taskId;
    if (!sourceMessageId || !taskId) throw new Error('Content modification receipt requires bound source and Task');
    const idempotencyKey = receiptMessageIdempotencyKey(record.ownerUserId, event);
    const prior =
      (await this.deps.messages.getByIdempotencyKey(record.ownerUserId, record.payload.threadId, idempotencyKey)) ??
      (await this.deps.messages.getByIdempotencyKey('system', record.payload.threadId, idempotencyKey));
    if (prior) return this.readPrior(record, event, prior);

    if (record.progress.prepared?.kind === 'media') await this.deps.authorizeMediaReceipt?.(record);
    const followUp = await this.followUp(record, event);
    const receipt = contentModificationReceiptV1Schema.parse({
      v: 1,
      requestId: record.requestId,
      sourceMessageId,
      targetCatId: record.payload.targetCatId,
      taskId,
      state: event.state,
      ...(event.candidateRef ? { candidateRef: event.candidateRef } : {}),
      receiptRef: event.receiptRef,
      observedAt: event.observedAt,
      followUp,
    });
    if (record.progress.prepared?.kind === 'media') await this.deps.authorizeMediaReceipt?.(record);
    const appended = await this.deps.messages.appendIdempotent({
      userId: record.ownerUserId,
      from: { kind: 'system', service: 'content-modification' },
      content: receiptContent(receipt),
      mentions: [],
      timestamp: event.observedAt,
      threadId: record.payload.threadId,
      idempotencyKey,
      replyTo: sourceMessageId,
      ...(record.progress.sourceVisibility?.visibility === 'whisper'
        ? {
            visibility: 'whisper' as const,
            whisperTo: record.progress.sourceVisibility.whisperTo.map((catId) => createCatId(catId)),
          }
        : {}),
      extra: {
        systemKind: 'content_modification_receipt',
        contentModificationReceiptV1: receipt,
      },
    });
    const result = this.readPrior(record, event, appended.message, appended.idempotent);
    if (!appended.idempotent) await this.deps.onSaved(record.ownerUserId, record.payload.threadId, appended.message.id);
    return result;
  }

  private readPrior(
    record: ContentModificationRecord,
    event: ReceiptEvent,
    message: StoredMessage,
    idempotent = true,
  ): ContentModificationChatProjectionResult {
    const parsed = contentModificationReceiptV1Schema.safeParse(message.extra?.contentModificationReceiptV1);
    // Pre-MessageFrom rows retain their original system owner and canonical
    // legacy sender projection. Their idempotency key already binds the Human.
    const legacySystemReceipt =
      message.userId === 'system' && message.from?.kind === 'system' && message.from.service === 'system';
    if (
      (!legacySystemReceipt && message.userId !== record.ownerUserId) ||
      message.from?.kind !== 'system' ||
      message.threadId !== record.payload.threadId ||
      message.catId !== null ||
      message.replyTo !== record.progress.sourceMessageId ||
      message.extra?.systemKind !== 'content_modification_receipt' ||
      message.mentions.length !== 0 ||
      message.extra?.targetCats !== undefined ||
      (message.visibility ?? 'public') !== (record.progress.sourceVisibility?.visibility ?? 'public') ||
      !isDeepStrictEqual(
        message.whisperTo ?? [],
        record.progress.sourceVisibility?.visibility === 'whisper' ? record.progress.sourceVisibility.whisperTo : [],
      ) ||
      !parsed.success ||
      parsed.data.requestId !== record.requestId ||
      parsed.data.sourceMessageId !== record.progress.sourceMessageId ||
      parsed.data.taskId !== record.progress.task?.taskId ||
      parsed.data.targetCatId !== record.payload.targetCatId ||
      parsed.data.state !== event.state ||
      parsed.data.receiptRef !== event.receiptRef ||
      parsed.data.candidateRef !== event.candidateRef
    )
      throw new Error('Content modification receipt idempotency conflict');
    return { message, receipt: parsed.data, idempotent };
  }

  private async followUp(record: ContentModificationRecord, event: ReceiptEvent): Promise<ReceiptFollowUp> {
    if (event.state !== 'conflict' && event.state !== 'unknown') {
      return { kind: 'none', reason: 'not_applicable' };
    }
    const taskId = record.progress.task?.taskId;
    if (!taskId) return { kind: 'unverified' };
    const task = await this.deps.tasks.get(taskId);
    if (!task || task.id !== taskId || task.userId !== record.ownerUserId || task.threadId !== record.payload.threadId)
      return { kind: 'unverified' };
    if (task.ownerCatId !== record.payload.targetCatId) return { kind: 'none', reason: 'owner_changed' };
    if (task.status === 'done' || task.entrustedWork?.closure.state !== 'open')
      return { kind: 'none', reason: 'task_closed' };

    if (!this.deps.delivery) return { kind: 'unverified' };

    const carrier = contentModificationFollowUpCarrierV1Schema.parse({
      v: 1,
      requestId: record.requestId,
      sourceMessageId: record.progress.sourceMessageId,
      targetCatId: record.payload.targetCatId,
      taskId,
      ...(event.candidateRef ? { candidateRef: event.candidateRef } : {}),
      receiptRef: event.receiptRef,
      state: event.state,
    });
    const audience = record.progress.sourceVisibility;

    const result = await this.deps.delivery.deliver({
      ownerAuthProvenance: 'strict',
      ownerUserId: record.ownerUserId,
      threadId: record.payload.threadId,
      targetCatId: record.payload.targetCatId,
      idempotencyKey: followUpCarrierIdempotencyKey(event.receiptRef),
      content: followUpContent(record, event),
      sourceCategory: 'producer_return',
      ...(audience?.visibility === 'whisper'
        ? { visibility: audience.visibility, whisperTo: audience.whisperTo }
        : { visibility: 'public' as const }),
      source: {
        connector: 'content-modification-result',
        label: 'Host 作品修改结果续办',
        icon: '📝',
        meta: carrier,
      },
    });
    if (result.state === 'unavailable' || result.state === 'conflict' || !result.message) return { kind: 'unverified' };
    if (result.state !== 'started' && result.state !== 'already_processing') return { kind: 'unverified' };
    return { kind: 'cat_woken', executionRef: `message:${result.message.id}#queue-custody` };
  }
}

function receiptMessageIdempotencyKey(ownerUserId: string, event: ReceiptEvent): string {
  return `f309-chat-receipt:${createHash('sha256')
    .update(JSON.stringify(['f309-chat-receipt-v1', ownerUserId, event.receiptRef, event.state]))
    .digest('hex')}`;
}

function followUpCarrierIdempotencyKey(receiptRef: string): string {
  return `f309-result-follow-up:${createHash('sha256').update(receiptRef).digest('hex')}`;
}

function receiptContent(receipt: ContentModificationReceiptV1): string {
  const label: Record<ReceiptState, string> = {
    candidate: '候选修改已返回，可打开对照后决定。原文件尚未因此改变。',
    rejected: '这份候选已不采用。原文件未因此改变。',
    approved: '这份媒体版本已通过审阅。',
    changes_requested: '这份媒体版本已收到修改要求。',
    applied: '这份候选已采用并写回原文件。',
    conflict: '采用时发现原文件已改变；候选已保留，没有覆盖原文件。',
    unknown: '写回结果暂时无法确认；候选与回执已保留。',
  };
  return [
    '[Host 作品修改回执]',
    label[receipt.state],
    `requestId: ${receipt.requestId}`,
    ...(receipt.candidateRef ? [`candidateRef: ${receipt.candidateRef}`] : []),
    `receiptRef: ${receipt.receiptRef}`,
    '这是系统投影，不是新的修改授权；打开后以当前请求详情为准。',
  ].join('\n');
}

function followUpContent(record: ContentModificationRecord, event: ReceiptEvent): string {
  return [
    '[Host 作品修改结果续办]',
    `requestId: ${record.requestId}`,
    ...(event.candidateRef ? [`candidateRef: ${event.candidateRef}`] : []),
    `receiptRef: ${event.receiptRef}`,
    `state: ${event.state}`,
    '用户对既有候选的写回结果需要核对。请读取当前请求与回执；这不是新的修改授权，不得自动重试写回。',
  ].join('\n');
}

function publicWritebackReceipt(receipt: WorkspaceWritebackView): ContentWritebackReceipt {
  const { targetPath: _path, proof: _proof, fingerprint: _fingerprint, ...visible } = receipt;
  return visible;
}
