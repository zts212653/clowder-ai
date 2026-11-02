'use client';

import type { LifecycleActiveRun } from '@cat-cafe/shared';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import { CatAvatar } from './CatAvatar';
import { MessageDispatchRecipient } from './MessageDispatchRecipient';
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
  threadId?: string;
}

/** One readable receipt per exact recipient; reply progress never substitutes for reading evidence. */
export function MessageDispatchAvatars({
  message,
  timelineMessages,
  activeRuns,
  getCatLabel,
  queue = [],
  inline = false,
  threadId,
}: MessageDispatchAvatarsProps) {
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
      {projections.map((projection) => (
        <MessageDispatchRecipient
          key={`${projection.targetId}:${projection.evidenceKey}`}
          projection={projection}
          message={message}
          timelineMessages={timelineMessages}
          pending={pending}
          getCatLabel={getCatLabel}
          agentSource={agentSource}
          whisper={whisper}
          recipientCount={projections.length}
          threadId={threadId}
        />
      ))}
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
