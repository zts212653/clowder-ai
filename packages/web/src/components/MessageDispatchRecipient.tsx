'use client';

import { getLifecycleAppendOutcome, isAppendRepeatSource, type LifecycleActiveRun } from '@cat-cafe/shared';

import { useMessageNavigation } from '@/components/thread-chat/MessageNavigationContext';
import { usePluginTargets } from '@/hooks/usePluginMentionTargets';
import { dispatchReadText, dispatchReceiptDisplay, dispatchReceiptLabel } from '@/lib/dispatch-receipt-display';
import type { ChatMessage } from '@/stores/chat-types';
import { hasAssistantBody } from './assistant-message-renderability';
import { CatAvatar } from './CatAvatar';
import { cloudDispatchAudit, cloudDispatchReceipt, pendingCloudDeliveryLabel } from './cloud-dispatch-receipt';
import { HistoryAppendActions } from './HistoryAppendActions';
import {
  type MessageDispatchAvatarProjection,
  pluginDeliveryReceipt,
  resolveDispatchReplyArrow,
  resolveUnloadedDispatchReply,
} from './message-dispatch-projection';
import { PluginTargetIcon } from './PluginTargetIcon';
import { useShellPresentation } from './shell/shell-presentation';
import { projectTargetReply } from './target-response-projection';
import { useCloudReply } from './useCloudReply';

interface RecipientProps {
  projection: MessageDispatchAvatarProjection;
  message: ChatMessage;
  timelineMessages: readonly ChatMessage[];
  activeRuns?: readonly LifecycleActiveRun[];
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
  activeRuns = [],
  getCatLabel,
  agentSource,
  whisper,
  recipientCount,
  threadId,
}: RecipientProps) {
  const navigateToMessage = useMessageNavigation();
  const shell = useShellPresentation();
  const { knownTargets } = usePluginTargets();
  const cloud = shell === 'v2' ? cloudDispatchReceipt(message, projection.targetId, timelineMessages) : undefined;
  const logical = useCloudReply(cloud?.identity, threadId, timelineMessages, { readDotEvent: shell === 'v2' });
  const ref = message.lifecycle?.dispatchRefs?.find((candidate) => candidate.targetId === projection.targetId);
  const linkedMessage = timelineMessages.find(
    (candidate) => candidate.id === (projection.statusMessageId ?? ref?.statusMessageId),
  );
  const pluginReceipt = pluginDeliveryReceipt(linkedMessage);
  const targetReply = pluginReceipt && linkedMessage ? projectTargetReply(linkedMessage, timelineMessages) : undefined;
  const resultMessageId = targetReply?.resultMessageId;
  const pluginReply =
    pluginReceipt && targetReply?.hasBody && resultMessageId
      ? timelineMessages.find((row) => row.id === resultMessageId)
      : undefined;
  const pluginTarget = knownTargets.find((candidate) => candidate.id === projection.targetId);
  const pluginRecipient = pluginTarget !== undefined || pluginReceipt !== undefined;
  const label = pluginTarget?.alias ?? (pluginRecipient ? '插件' : getCatLabel(projection.targetId));
  const failure = message.lifecycle?.appendFailures?.find(
    (candidate) => candidate.targetId === projection.targetId && candidate.responseMessageId === ref?.statusMessageId,
  );
  const appendOutcome = getLifecycleAppendOutcome(ref, message.lifecycle);
  const uncertain = appendOutcome === 'unknown';
  const checking = uncertain && (!failure || (failure.acceptance === 'unknown' && failure.checkedAt === undefined));
  const notAccepted = appendOutcome === 'not_accepted';
  const incomplete = appendOutcome === 'incomplete';
  const { selfIndex, exactActiveRun, unloadedSettledAppended, unloadedLinkedReply } = resolveUnloadedDispatchReply({
    message,
    targetId: projection.targetId,
    ref,
    linkedMessage,
    timelineMessages,
    activeRuns,
    disqualified:
      Boolean(cloud) ||
      pluginRecipient ||
      notAccepted ||
      incomplete ||
      uncertain ||
      appendOutcome === 'awaiting_completion',
  });
  const processing =
    (projection.phase === 'processing' || exactActiveRun !== undefined) &&
    !uncertain &&
    failure?.acceptance !== 'incomplete';
  const linked = linkedMessage?.lifecycle;
  const response = linked?.kind === 'response' ? linked : undefined;
  const appended = response
    ? response.inputMessageIds.indexOf(message.id) > 0 && message.timestamp > response.startedAt
    : exactActiveRun
      ? exactActiveRun.inputMessageIds.indexOf(message.id) > 0 && message.timestamp > exactActiveRun.startedAt
      : unloadedSettledAppended;
  const running = response ? response.status === 'processing' : exactActiveRun ? true : ref?.phase !== 'settled';
  const receipt = dispatchReceiptDisplay(ref, running, message.lifecycle);
  const audit = cloud ? cloudDispatchAudit(cloud, logical.state === 'source_replied') : undefined;
  const title = pluginReply
    ? '插件的回复已到达'
    : pluginReceipt?.phase === 'sending'
      ? '正在向插件投递，尚未确认接收'
      : pluginReceipt
        ? pluginReceipt.accepted
          ? '插件确认收到了这条消息；如果它回复，会作为新消息出现'
          : '插件没有确认收到，请检查插件状态后重新发送'
        : [dispatchReceiptLabel(receipt, label, 'recipient'), audit].filter(Boolean).join('\n');
  const awaitingCloudReply =
    cloud && linkedMessage && !hasAssistantBody(linkedMessage) && response?.status === 'completed';
  const replyMessageId =
    resultMessageId ??
    pluginReply?.id ??
    (logical.state !== 'unverified'
      ? logical.replyMessageId
      : awaitingCloudReply
        ? undefined
        : (projection.statusMessageId ?? (unloadedLinkedReply ? ref?.statusMessageId : undefined)));
  const replyArrow = resolveDispatchReplyArrow({
    message,
    replyMessageId,
    linkedMessage,
    timelineMessages,
    selfIndex,
    appended: Boolean(appended),
    unloadedLinkedReply,
  });
  const failedDelivery = linked?.kind === 'delivery_failure';
  const notSent =
    cloud?.receipt?.status === 'failed' &&
    cloud.receipt.transport === 'none' &&
    cloud.receipt.idempotency.disposition === 'not_attempted';
  const outcome = response && response.status !== 'processing' ? responseOutcome[response.status] : undefined;
  const pendingCloud = cloud ? pendingCloudDeliveryLabel(cloud) : undefined;
  const memberProgress = notAccepted
    ? '未并进上一轮（未接收）'
    : incomplete
      ? '追加未完成'
      : appendOutcome === 'awaiting_completion'
        ? '收到，本条补充消息还未确认完成'
        : logical.state === 'replied'
          ? '收到，已回复'
          : logical.state === 'source_replied'
            ? '这条消息已有回信'
            : pendingCloud
              ? pendingCloud
              : notSent
                ? '尚未发送'
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
  const progress =
    pluginReceipt && targetReply?.terminal
      ? targetReply.status === 'completed'
        ? '收到，已回复'
        : `收到，${responseOutcome[targetReply.status as keyof typeof responseOutcome]}`
      : pluginReceipt && targetReply?.status === 'processing'
        ? '收到，正在回…'
        : pluginReply
          ? '已有回复内容'
          : pluginReceipt?.phase === 'sending'
            ? '正在投递…'
            : pluginReceipt
              ? pluginReceipt.accepted
                ? '已接收'
                : '未确认接收 · 请检查插件后重新发送'
              : memberProgress;
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
      {pluginRecipient ? (
        <PluginTargetIcon icon={pluginTarget?.icon} />
      ) : (
        <CatAvatar catId={projection.targetId} size={16} status={processing ? 'streaming' : undefined} />
      )}
      {!checking ? <span className="font-medium text-cafe-secondary">{label}</span> : null}
      <span>
        {late ? `${formatTime(projection.dispatchedAt!)} ` : ''}
        {progress}
      </span>
      {(uncertain || notAccepted || incomplete) && ref && threadId ? (
        <HistoryAppendActions
          key={`${message.id}:${ref.targetId}:${ref.statusMessageId}`}
          threadId={threadId}
          messageId={message.id}
          delivery={{
            targetId: ref.targetId,
            responseMessageId: ref.statusMessageId,
            ...(response?.invocationId ? { invocationId: response.invocationId } : {}),
          }}
          canRepeat={Boolean(
            isAppendRepeatSource(message.from, ref, failure) && failure && (notAccepted || incomplete || !checking),
          )}
          repeatKind={notAccepted ? 'not_accepted' : incomplete ? 'incomplete' : 'unknown'}
        />
      ) : null}
      {!checking &&
      replyMessageId &&
      (resultMessageId || pluginReply || response || unloadedLinkedReply || logical.state !== 'unverified') ? (
        <button
          type="button"
          aria-label={`看${label}的回复`}
          className="rounded hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-current"
          onClick={() => {
            if (!replyMessageId) return;
            if (logical.state !== 'unverified' || pluginReceipt || unloadedLinkedReply) {
              navigateToMessage(replyMessageId, { loadIfNeeded: true });
            } else {
              navigateToMessage(replyMessageId);
            }
          }}
        >
          · 看回复 {replyArrow}
        </button>
      ) : null}
    </li>
  );
}
