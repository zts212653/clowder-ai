'use client';

import type { LifecycleActiveRun } from '@cat-cafe/shared';
import { useMessageNavigation } from '@/components/thread-chat/MessageNavigationContext';
import {
  dispatchReadText,
  dispatchReceiptDisplay,
  dispatchReceiptLabel,
  isUnconfirmedAppend,
} from '@/lib/dispatch-receipt-display';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import { CatAvatar } from './CatAvatar';
import { projectMessageDispatchAvatars } from './message-dispatch-projection';
import { QueueTargetRetryButton } from './QueueTargetRetryButton';

export type { MessageDispatchAvatarProjection } from './message-dispatch-projection';
export { isLinkedDeliveryFailureCarrier, projectMessageDispatchAvatars } from './message-dispatch-projection';

interface MessageDispatchAvatarsProps {
  message: ChatMessage;
  timelineMessages: readonly ChatMessage[];
  activeRuns: readonly LifecycleActiveRun[];
  getCatLabel: (catId: string) => string;
  queue?: readonly QueueEntry[];
  inline?: boolean;
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

/** One readable receipt per exact recipient; reply progress never substitutes for reading evidence. */
export function MessageDispatchAvatars({
  message,
  timelineMessages,
  activeRuns,
  getCatLabel,
  queue = [],
  inline = false,
}: MessageDispatchAvatarsProps) {
  const navigateToMessage = useMessageNavigation();
  const projections = projectMessageDispatchAvatars(message, timelineMessages, activeRuns);
  const pending = queue.filter((entry) => entry.messageId === message.id);
  if (projections.length === 0 && pending.length === 0) return null;
  const alignsRight = message.type === 'user' && !message.catId;
  const agentSource = message.from?.kind === 'agent' || Boolean(message.catId);
  const whisper = message.visibility === 'whisper';
  const deliveredTargets = new Set(projections.map((projection) => projection.targetId));
  return (
    <ul
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-cafe-muted ${inline ? (alignsRight ? 'justify-end' : 'justify-start') : `-mt-3 mb-4 ${alignsRight ? 'justify-end pr-10' : 'justify-start pl-10'}`}`}
      data-testid="message-dispatch-avatars"
      aria-label={agentSource ? '回话交接' : '消息收件进度'}
    >
      {projections.map((projection) => {
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
        const linked = projection.statusMessageId
          ? timelineMessages.find((candidate) => candidate.id === projection.statusMessageId)?.lifecycle
          : undefined;
        const response = linked?.kind === 'response' ? linked : undefined;
        const appended =
          response && response.inputMessageIds.indexOf(message.id) > 0 && message.timestamp > response.startedAt;
        const running = response ? response.status === 'processing' : ref?.phase !== 'settled';
        const receipt = dispatchReceiptDisplay(ref, running, message.lifecycle);
        const title = dispatchReceiptLabel(receipt, label, 'recipient');
        const failedDelivery = linked?.kind === 'delivery_failure';
        const outcome = response && response.status !== 'processing' ? responseOutcome[response.status] : undefined;
        const progress = uncertain
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
            key={`${projection.targetId}:${projection.evidenceKey}`}
            data-dispatch-target={projection.targetId}
            data-dispatch-phase={projection.phase}
            title={title}
            className={`inline-flex flex-wrap items-center gap-1 ${failedDelivery ? 'text-conn-red-text' : ''}`}
          >
            {agentSource ? (
              <span>{projections.length > 1 ? '同时交给' : '交给'}</span>
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
            {!checking && projection.statusMessageId && response ? (
              <button
                type="button"
                aria-label={`看${label}的回复`}
                className="rounded hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-current"
                onClick={() => navigateToMessage(projection.statusMessageId!)}
              >
                · 看回复 ↓
              </button>
            ) : null}
          </li>
        );
      })}
      {pending.flatMap((entry) => {
        const retryActions =
          entry.recoveryActions?.filter(
            (action) => action.kind === 'retry_target' && !deliveredTargets.has(action.targetCatId),
          ) ?? [];
        const retryTargets = new Set(
          retryActions.map((action) => (action.kind === 'retry_target' ? action.targetCatId : '')),
        );
        const targets = entry.targetCats.filter((target) => !deliveredTargets.has(target) && !retryTargets.has(target));
        const retryRows = retryActions.flatMap((action) =>
          action.kind === 'retry_target'
            ? [
                <li key={action.id} className="inline-flex items-center gap-1 text-conn-red-text">
                  <span>没送到</span>
                  <CatAvatar catId={action.targetCatId} size={16} />
                  <span>{getCatLabel(action.targetCatId)}</span>
                  <QueueTargetRetryButton entry={entry} action={action} label="重新发送" />
                </li>,
              ]
            : [],
        );
        if (entry.targetCats.length > 0 && targets.length === 0) return retryRows;
        const ahead = queue.slice(0, queue.indexOf(entry)).filter((candidate) => {
          const source = timelineMessages.find((item) => item.id === candidate.messageId);
          return targets.some(
            (target) =>
              candidate.targetCats.includes(target) &&
              !source?.lifecycle?.dispatchRefs?.some((ref) => ref.targetId === target),
          );
        }).length;
        const waiting =
          !entry.autoExecute ||
          targets.length === 0 ||
          ahead > 0 ||
          activeRuns.some((run) => targets.includes(run.targetId) && !run.inputMessageIds.includes(message.id));
        return [
          ...retryRows,
          <li key={entry.id} className="inline-flex flex-wrap items-center gap-1" data-dispatch-queued={entry.id}>
            <span>{waiting ? (agentSource ? '排队交给' : '排队中 · 等') : '发送中 ·'}</span>
            {targets.map((target) => (
              <span key={target} className="inline-flex items-center gap-1">
                <CatAvatar catId={target} size={16} />
                {getCatLabel(target)}
              </span>
            ))}
            <span>
              {targets.length ? (waiting && !agentSource ? '接' : '') : '选择收件猫'}
              {ahead > 0 ? `，前面还有 ${ahead} 条` : ''}
            </span>
          </li>,
        ];
      })}
    </ul>
  );
}
