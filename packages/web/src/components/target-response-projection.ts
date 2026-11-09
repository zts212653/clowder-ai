import { isTargetResponseRecord, isTargetResponseTerminal, type TargetResponseStatus } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';
import { hasAssistantBody } from './assistant-message-renderability';
import { pluginDeliveryReceipt } from './message-dispatch-projection';
import { pluginReplyFor } from './plugin-reply-state';

export interface TargetReplyView {
  readonly targetId: string;
  readonly backend: 'member' | 'plugin';
  readonly status: TargetResponseStatus;
  readonly hasBody: boolean;
  readonly terminal: boolean;
  readonly resultMessageId?: string;
  readonly showFrame: boolean;
}

/** Adapters supply evidence; visibility and terminal effects have one target-level contract. */
export function projectTargetReply(
  message: ChatMessage,
  timeline: readonly ChatMessage[],
): TargetReplyView | undefined {
  const member = message.lifecycle;
  if (member?.kind === 'response') {
    const body = hasAssistantBody(message);
    return {
      targetId: member.targetId,
      backend: 'member',
      status: member.status,
      hasBody: body,
      terminal: isTargetResponseTerminal(member.status),
      resultMessageId: message.id,
      showFrame: !body,
    };
  }
  const result = message.extra?.targetResponseResult;
  if (message.from?.kind === 'plugin' && result) {
    const carrier = timeline.find((row) => row.id === result.carrierMessageId);
    const authority = carrier?.extra?.targetResponse;
    if (
      isTargetResponseRecord(authority) &&
      authority.targetId === message.from.instanceId &&
      authority.execution.id === result.deliveryId &&
      authority.inputMessageId === message.replyTo
    ) {
      const body = hasAssistantBody(message);
      return {
        targetId: authority.targetId,
        backend: 'plugin',
        status: result.status,
        hasBody: body,
        terminal: isTargetResponseTerminal(result.status),
        resultMessageId: message.id,
        showFrame: !body,
      };
    }
  }
  const receipt = pluginDeliveryReceipt(message);
  if (!receipt) return undefined;
  const sources = timeline.filter((row) => row.id === receipt.inputMessageId);
  const source = sources.length === 1 ? sources[0] : undefined;
  if (
    !source ||
    source.visibility === 'whisper' ||
    source.extra?.recall ||
    source.lifecycle?.dispatchRefs?.filter((ref) => ref.targetId === receipt.targetId).length !== 1 ||
    !source.lifecycle?.dispatchRefs?.some(
      (ref) => ref.targetId === receipt.targetId && ref.statusMessageId === message.id,
    )
  )
    return undefined;
  const stored = message.extra?.targetResponse;
  const state =
    isTargetResponseRecord(stored) && stored.targetId === receipt.targetId && stored.inputMessageId === source.id
      ? stored
      : undefined;
  const reply = pluginReplyFor(source.id, receipt.targetId, timeline);
  const status =
    state?.status ?? (receipt.phase === 'sending' ? 'delivering' : receipt.accepted ? 'waiting' : 'unconfirmed');
  const terminal = isTargetResponseTerminal(status);
  return {
    targetId: receipt.targetId,
    backend: 'plugin',
    status,
    hasBody: Boolean(reply),
    terminal,
    ...(state?.resultMessageId
      ? { resultMessageId: state.resultMessageId }
      : reply
        ? { resultMessageId: reply.id }
        : {}),
    // Old receipts did not own a response lifecycle. They are read as transport facts only.
    showFrame: Boolean(state) && !reply && !(terminal && state?.resultMessageId),
  };
}

export function targetReplyNotice(status: TargetResponseStatus): string {
  switch (status) {
    case 'delivering':
      return '正在投递…';
    case 'waiting':
      return '已接收，等待回复…';
    case 'processing':
      return '正在回复…';
    case 'unconfirmed':
      return '投递结果未确认，请检查连接。';
    case 'completed':
      return '已完成，没有返回可显示内容。';
    case 'failed':
      return '回复失败。';
    case 'canceled':
      return '已停止回复。';
    case 'interrupted':
      return '回复已中断。';
  }
}
