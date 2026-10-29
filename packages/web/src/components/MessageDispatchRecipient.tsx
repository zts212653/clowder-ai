'use client';

import { useMessageNavigation } from '@/components/thread-chat/MessageNavigationContext';
import {
  dispatchReadText,
  dispatchReceiptDisplay,
  dispatchReceiptLabel,
  isUnconfirmedAppend,
} from '@/lib/dispatch-receipt-display';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import { hasAssistantBody } from './assistant-message-renderability';
import { CatAvatar } from './CatAvatar';
import { cloudDispatchAudit, cloudDispatchReceipt } from './cloud-dispatch-receipt';
import type { MessageDispatchAvatarProjection } from './message-dispatch-projection';
import { QueueTargetRetryButton } from './QueueTargetRetryButton';
import { useShellPresentation } from './shell/shell-presentation';
import { useCloudReply } from './useCloudReply';

interface RecipientProps {
  projection: MessageDispatchAvatarProjection;
  message: ChatMessage;
  timelineMessages: readonly ChatMessage[];
  pending: readonly QueueEntry[];
  getCatLabel: (catId: string) => string;
  agentSource: boolean;
  whisper: boolean;
  recipientCount: number;
  threadId?: string;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const responseOutcome = {
  completed: '已回复',
  failed: '回复失败',
  canceled: '已取消',
  interrupted: '回复中断',
} as const;

export function MessageDispatchRecipient({
  projection,
  message,
  timelineMessages,
  pending,
  getCatLabel,
  agentSource,
  whisper,
  recipientCount,
  threadId,
}: RecipientProps) {
  const navigateToMessage = useMessageNavigation();
  const shell = useShellPresentation();
  const cloud = shell === 'v2' ? cloudDispatchReceipt(message, projection.targetId, timelineMessages) : undefined;
  const logical = useCloudReply(cloud?.identity, threadId, timelineMessages, { readDotEvent: shell === 'v2' });
  const label = getCatLabel(projection.targetId);
  const ref = message.lifecycle?.dispatchRefs?.find((candidate) => candidate.targetId === projection.targetId);
  const uncertain = isUnconfirmedAppend(ref, message.lifecycle);
  const checking =
    uncertain &&
    !message.lifecycle?.appendFailures?.find(
      (failure) => failure.targetId === projection.targetId && failure.responseMessageId === ref?.statusMessageId,
    )?.checkedAt;
  const processing = projection.phase === 'processing' && !uncertain;
  const retryEntry =
    uncertain && !checking
      ? pending.find((entry) =>
          entry.recoveryActions?.some(
            (action) => action.kind === 'repeat_target' && action.targetCatId === projection.targetId,
          ),
        )
      : undefined;
  const retryAction = retryEntry?.recoveryActions?.find(
    (action) => action.kind === 'repeat_target' && action.targetCatId === projection.targetId,
  );
  const linkedMessage = timelineMessages.find((candidate) => candidate.id === projection.statusMessageId);
  const linked = linkedMessage?.lifecycle;
  const response = linked?.kind === 'response' ? linked : undefined;
  const appended =
    response && response.inputMessageIds.indexOf(message.id) > 0 && message.timestamp > response.startedAt;
  const running = response ? response.status === 'processing' : ref?.phase !== 'settled';
  const receipt = dispatchReceiptDisplay(ref, running, message.lifecycle);
  const audit = cloud ? cloudDispatchAudit(cloud, logical.state === 'source_replied') : undefined;
  const title = [dispatchReceiptLabel(receipt, label, 'recipient'), audit].filter(Boolean).join('\n');
  const awaitingCloudReply =
    cloud && linkedMessage && !hasAssistantBody(linkedMessage) && response?.status === 'completed';
  const replyMessageId =
    logical.state !== 'unverified'
      ? logical.replyMessageId
      : awaitingCloudReply
        ? undefined
        : projection.statusMessageId;
  const failedDelivery = linked?.kind === 'delivery_failure';
  const outcome = response && response.status !== 'processing' ? responseOutcome[response.status] : undefined;
  const progress =
    logical.state === 'replied'
      ? '收到，已回复'
      : logical.state === 'source_replied'
        ? '这条消息已有回信'
        : awaitingCloudReply
          ? '收到，回复状态待核对'
          : uncertain
            ? checking
              ? `正在核对 ${label} 收到没…`
              : '已送出，没确认收到'
            : failedDelivery
              ? '没送到'
              : appended
                ? `收到，并进了${running ? '正在回' : '已结束'}的这一轮${outcome ? ` · ${outcome}` : ''} · ${dispatchReadText(receipt)}`
                : processing
                  ? '收到，正在回…'
                  : outcome
                    ? `收到，${outcome}`
                    : '收到，回复状态待核对';
  const late = projection.dispatchedAt !== undefined && projection.dispatchedAt - message.timestamp > 60_000;
  return (
    <li
      data-dispatch-target={projection.targetId}
      data-dispatch-phase={projection.phase}
      title={title}
      aria-description={audit}
      className={`inline-flex flex-wrap items-center gap-1 ${failedDelivery ? 'text-conn-red-text' : ''}`}
    >
      {agentSource ? (
        <span>{recipientCount > 1 ? '同时交给' : '交给'}</span>
      ) : whisper ? (
        <span>悄悄话，只有</span>
      ) : null}
      <CatAvatar catId={projection.targetId} size={16} status={processing ? 'streaming' : undefined} />
      {!checking ? <span className="font-medium text-cafe-secondary">{label}</span> : null}
      <span>
        {late ? `${formatTime(projection.dispatchedAt!)} ` : ''}
        {progress}
      </span>
      {retryEntry && retryAction?.kind === 'repeat_target' ? (
        <QueueTargetRetryButton entry={retryEntry} action={retryAction} label="重新发送" />
      ) : null}
      {!checking && replyMessageId && (response || logical.state !== 'unverified') ? (
        <button
          type="button"
          aria-label={`看${label}的回复`}
          className="rounded hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-current"
          onClick={() => {
            if (!replyMessageId) return;
            if (logical.state !== 'unverified') navigateToMessage(replyMessageId, { loadIfNeeded: true });
            else navigateToMessage(replyMessageId);
          }}
        >
          · 看回复 ↓
        </button>
      ) : null}
    </li>
  );
}
