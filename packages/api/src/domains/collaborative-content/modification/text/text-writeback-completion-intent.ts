import type { ConnectorSource, ContentModificationProgress } from '@cat-cafe/shared';
import { contentTextWritebackCompletionCarrierV1Schema } from '@cat-cafe/shared';

/** Delivery custody in the existing return outbox, distinct from the Human and F063 receipts. */
export interface TextWritebackCompletionIntent {
  kind: 'text_writeback_completion';
  receiptRef: string;
  requestId: string;
  closureRequestId: string;
  sourceMessageId: string;
  ownerUserId: string;
  threadId: string;
  taskId: string;
  targetCatId: string;
  observedTaskRevision: number;
  expectedSignal: string;
  candidateRef: string;
  humanReceiptRef: string;
  writebackReceiptRef: string;
  writtenRevision: string;
  audience: NonNullable<ContentModificationProgress['sourceVisibility']>;
  createdAt: string;
  state: 'pending' | 'queued' | 'retired';
  messageId?: string;
  retirementReason?: string;
}

/** Delivery state and a revision observation cannot rewrite the immutable effect/owner binding. */
export function textCompletionBinding(value: TextWritebackCompletionIntent) {
  const {
    state: _state,
    messageId: _message,
    retirementReason: _reason,
    observedTaskRevision: _revision,
    ...immutable
  } = value;
  return immutable;
}

export function textWritebackCompletionProjection(intent: TextWritebackCompletionIntent) {
  const carrier = contentTextWritebackCompletionCarrierV1Schema.parse({
    v: 1,
    kind: intent.kind,
    returnRef: intent.receiptRef,
    requestId: intent.requestId,
    closureRequestId: intent.closureRequestId,
    sourceMessageId: intent.sourceMessageId,
    taskId: intent.taskId,
    targetCatId: intent.targetCatId,
    observedTaskRevision: intent.observedTaskRevision,
    expectedSignal: intent.expectedSignal,
    candidateRef: intent.candidateRef,
    humanReceiptRef: intent.humanReceiptRef,
    writebackReceiptRef: intent.writebackReceiptRef,
    writtenRevision: intent.writtenRevision,
  });
  const projection = {
    content: [
      '[Host 文档写回完成：原任务核证续办]',
      '同一 Human 明确接受的文件写回已完成。这不是新请求，也不证明整个 Task 已完成。',
      JSON.stringify(carrier),
      '先用 cat_cafe_read_entrusted_work 读取当前 Task/revision，用 cat_cafe_read_content_modification 的 overview 完整分页读取 canonical acceptances 和 public F063 receipt。',
      '核对本次 request、candidate、humanReceiptRef、writebackReceiptRef、writtenRevision，以及 closureRequestId 所绑定原 Task 的 closure.expectedSignal；合法后续请求可以不同于首次请求。observedTaskRevision 只供追溯，不能代替当前 Task revision 或关闭授权。',
      '只有原任务全部完成条件真实满足后，才调用 cat_cafe_close_entrusted_work，使用当前 revision 并附真实 human/F063 evidenceRefs。尚未满足就继续原任务，不得复制新 Task。',
      '不得再接受候选、重发 Human、再次写回文件或把本回流当作自动 done。',
    ].join('\n'),
    source: {
      connector: 'content-review',
      label: 'Host 文档写回完成：原任务核证续办',
      icon: 'cat-cafe',
      meta: carrier,
    } satisfies ConnectorSource,
  };
  return { ...projection, ...intent.audience };
}
