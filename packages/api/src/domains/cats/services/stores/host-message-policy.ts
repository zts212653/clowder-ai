import {
  approvalDecisionReceiptV1Schema,
  contentModificationFollowUpCarrierV1Schema,
  contentModificationPublicationCarrierV1Schema,
  contentModificationReceiptV1Schema,
  contentModificationRequestCarrierV1Schema,
  contentTextWritebackCompletionCarrierV1Schema,
} from '@cat-cafe/shared';

interface HostMessageCandidate {
  readonly from?: { readonly kind: string; readonly service?: string };
  readonly userId?: unknown;
  readonly catId?: unknown;
  readonly extra?: unknown;
  readonly source?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Resolve the typed Host identity for records that intentionally enter authorized Cat cognition. */
export function catConsumableHostSpeaker(message: HostMessageCandidate): string | undefined {
  if (message.catId !== null) return undefined;
  const extra = record(message.extra);
  if (
    (message.from ? message.from.kind === 'system' : message.userId === 'system') &&
    extra?.systemKind === 'content_modification_receipt' &&
    contentModificationReceiptV1Schema.safeParse(extra.contentModificationReceiptV1).success
  ) {
    return 'Host 作品修改回执';
  }
  const source = record(message.source);
  if (
    message.from?.kind === 'system' &&
    message.from.service === 'approval-hub' &&
    source?.connector === 'approval-hub' &&
    approvalDecisionReceiptV1Schema.safeParse(record(source.meta)?.approvalDecisionReceipt).success
  )
    return 'Host 审批结果回执';
  if (
    source?.connector === 'content-review' &&
    source.label === 'Host 文档写回完成：原任务核证续办' &&
    contentTextWritebackCompletionCarrierV1Schema.safeParse(source.meta).success
  )
    return 'Host 文档写回完成：原任务核证续办';
  if (
    source?.connector === 'content-review' &&
    source.label === 'Host 作品修改请求：原任务续办' &&
    contentModificationRequestCarrierV1Schema.safeParse(source.meta).success
  ) {
    return 'Host 作品修改请求：原任务续办';
  }
  if (
    source?.connector === 'content-review' &&
    source.label === '作品生成完成：原任务续办' &&
    contentModificationPublicationCarrierV1Schema.safeParse(source.meta).success
  )
    return 'Host 作品生成完成：原任务续办';
  if (
    source?.connector === 'content-modification-result' &&
    source.label === 'Host 作品修改结果续办' &&
    contentModificationFollowUpCarrierV1Schema.safeParse(source.meta).success
  ) {
    return 'Host 作品修改结果续办';
  }
  return undefined;
}

export function isCatConsumableHostMessage(message: HostMessageCandidate): boolean {
  return catConsumableHostSpeaker(message) !== undefined;
}

/** Generic system badges remain browser-only and must not enter Cat cognition or freshness. */
export function isDisplayOnlySystemMessage(message: HostMessageCandidate): boolean {
  return (
    (message.from ? message.from.kind === 'system' : message.userId === 'system') &&
    !isCatConsumableHostMessage(message)
  );
}
