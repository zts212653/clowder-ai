import { type CloudBridgeOutboundReceiptV1, isCloudBridgeOutboundReceiptV1 } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';
import { hasAssistantBody } from './assistant-message-renderability';
import type { CloudReplyIdentity } from './cloud-reply-state';

export function isNativeCloudTarget(target: string): boolean {
  return target === 'gpt-pro' || target === 'gpt-dot';
}

/** The persisted notice and its live system-info envelope carry the same typed fact. */
export function cloudReceiptOf(message: ChatMessage): CloudBridgeOutboundReceiptV1 | undefined {
  const payload = message.extra?.systemInfo?.payload;
  const receipt =
    message.source?.connector === 'cloud-bridge-status'
      ? message.source.meta?.cloudBridgeOutboundReceipt
      : payload?.type === 'cloud_bridge_status'
        ? payload.outboundReceipt
        : undefined;
  if (!isCloudBridgeOutboundReceiptV1(receipt) || !isNativeCloudTarget(receipt.targetCatId)) return undefined;
  if (message.source?.connector === 'cloud-bridge-status' && message.replyTo !== receipt.sourceMessageId)
    return undefined;
  return receipt;
}

export interface CloudDispatchReceipt {
  identity: CloudReplyIdentity;
  receipt?: CloudBridgeOutboundReceiptV1;
}

/** Follow the native dispatch ref, never timeline order, to identify the current attempt. */
export function cloudDispatchReceipt(
  source: ChatMessage,
  target: string,
  messages: readonly ChatMessage[],
): CloudDispatchReceipt | undefined {
  if (!isNativeCloudTarget(target) || source.extra?.recall || source.visibility === 'whisper') return undefined;
  const refs = source.lifecycle?.dispatchRefs?.filter((ref) => ref.targetId === target) ?? [];
  if (refs.length !== 1) return undefined;
  const frames = messages.filter((m) => m.id === refs[0].statusMessageId);
  if (frames.length !== 1) return undefined;
  const frame = frames[0]?.lifecycle;
  if (frame?.kind !== 'response' || frame.targetId !== target || !frame.inputMessageIds.includes(source.id))
    return undefined;
  const receipts = messages.flatMap((m) => {
    const receipt = cloudReceiptOf(m);
    return receipt?.sourceMessageId === source.id && receipt.targetCatId === target ? [receipt] : [];
  });
  const invocationId = frame.invocationId;
  const receipt = receipts.find((r) => r.dispatchInvocationId === invocationId);
  return {
    identity: {
      sourceMessageId: source.id,
      targetCatId: target,
      dispatchInvocationId: invocationId,
      ...(receipt?.hostMessageId ? { hostMessageId: receipt.hostMessageId } : {}),
    },
    ...(receipt ? { receipt } : {}),
  };
}

/** Only redundant completed cloud frames or typed notices can leave the reading surface. */
export function cloudCarrierDispatch(
  message: ChatMessage,
  messages: readonly ChatMessage[],
): CloudDispatchReceipt | undefined {
  const receipt = cloudReceiptOf(message);
  const frame = message.lifecycle;
  const empty =
    message.type === 'assistant' &&
    message.from?.kind === 'agent' &&
    frame?.kind === 'response' &&
    message.catId === frame.targetId &&
    message.from.catId === frame.targetId &&
    frame.status === 'completed' &&
    frame.inputMessageIds.length === 1 &&
    !hasAssistantBody(message);
  if (!receipt && !empty) return undefined;
  const sourceId = receipt?.sourceMessageId ?? (frame?.kind === 'response' ? frame.inputMessageIds[0] : undefined);
  const target = receipt?.targetCatId ?? (frame?.kind === 'response' ? frame.targetId : undefined);
  const source = messages.find((m) => m.id === sourceId);
  if (!source || !target) return undefined;
  const dispatch = cloudDispatchReceipt(source, target, messages);
  const attemptId = receipt?.dispatchInvocationId ?? (frame?.kind === 'response' ? frame.invocationId : undefined);
  if (dispatch?.identity.dispatchInvocationId !== attemptId) return undefined;
  if (empty && source.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === target)?.statusMessageId !== message.id)
    return undefined;
  return dispatch;
}

export function cloudDispatchAudit(dispatch: CloudDispatchReceipt, historical: boolean): string {
  const { receipt, identity } = dispatch;
  return [
    ...(historical ? ['这条消息已有回信；当前发送批次仍待核对。'] : []),
    ...(receipt
      ? [
          `原始投递：${{ sent: '已确认投递', failed: '确认未投递', unknown: '投递结果未知' }[receipt.status]}`,
          ...(receipt.transport === 'host' && receipt.status === 'unknown' ? ['本次浏览器 Host 回执未确认'] : []),
          `传输 ${receipt.transport} · ${receipt.idempotency.disposition} · 来源 ${receipt.sourceSender.id}`,
          ...(receipt.sourceSender.invocationId ? [`来源调用 ${receipt.sourceSender.invocationId}`] : []),
          ...(receipt.hostMessageId ? [`Host ${receipt.hostMessageId}`] : []),
        ]
      : []),
    `发送调用 ${identity.dispatchInvocationId}`,
  ].join('\n');
}
