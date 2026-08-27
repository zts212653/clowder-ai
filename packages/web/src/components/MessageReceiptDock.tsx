'use client';

import type {
  QueueMessageReceipt,
  QueueReceiptTarget,
  QueueReminderAttempt,
  QueueTargetAttempt,
} from '@cat-cafe/shared';
import { useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { resolveMessageElements } from '@/utils/scrollToMessage';
import { CatAvatar } from './CatAvatar';
import { authorIntentLabel, carrierCapabilityLabel, humanCarrierLabel } from './message-disposition-presentation';
import { receiptFailureReason, receiptTargetStateLabel } from './queue-receipt-projection';
import { latestRetryableQueueAttempt } from './queue-retry-action';

const REMINDER_STATE_LABEL: Record<QueueReminderAttempt['state'], string> = {
  requested: '提醒已请求',
  delivered: '提醒已送达 · 尚未读取',
  seen: '提醒后已读取',
  missed: '提醒未赶上本轮',
};

type ReceiptExecutionKind = NonNullable<NonNullable<ChatMessage['extra']>['turnExecution']>['executionKind'];
const EMPTY_ACTIVE_INVOCATION_IDS: ReadonlySet<string> = new Set();

const EXECUTION_KIND_LABEL: Record<ReceiptExecutionKind, string> = {
  ordinary: '普通执行',
  routing_guard: '系统补路由',
  freshness_supplement: '后到消息补充',
};

function findExecutionKind(
  messages: readonly ChatMessage[],
  invocationId: string | undefined,
): ReceiptExecutionKind | undefined {
  if (!invocationId) return undefined;
  for (const message of messages) {
    if (message.extra?.turnExecution?.invocationId === invocationId) {
      return message.extra.turnExecution.executionKind;
    }
    const auxiliary = message.extra?.auxiliaryTurnExecutions?.find(
      (execution) => execution.invocationId === invocationId,
    );
    if (auxiliary) return auxiliary.executionKind;
  }
  return undefined;
}

export function collectInvocationLineageMessageIds(messages: readonly ChatMessage[], invocationId: string): string[] {
  const lineageIds = new Set<string>();
  for (const message of messages) {
    const stream = message.extra?.stream;
    const ownsExecution = message.extra?.turnExecution?.invocationId === invocationId;
    const assistedByExecution = message.extra?.auxiliaryTurnExecutions?.some(
      (execution) => execution.invocationId === invocationId,
    );
    if (
      stream?.invocationId === invocationId ||
      stream?.turnInvocationId === invocationId ||
      ownsExecution ||
      assistedByExecution
    ) {
      lineageIds.add(message.id);
    }
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const message of messages) {
      const supplement = message.extra?.supplement;
      if (!supplement || lineageIds.has(message.id)) continue;
      if (!lineageIds.has(supplement.originalMessageId) && !lineageIds.has(supplement.lineageId)) continue;
      lineageIds.add(message.id);
      grew = true;
    }
  }

  return messages.filter((message) => lineageIds.has(message.id)).map((message) => message.id);
}

export function focusInvocationLineage(messages: readonly ChatMessage[], invocationId: string): boolean {
  if (typeof document === 'undefined') return false;
  const messageIds = new Set(collectInvocationLineageMessageIds(messages, invocationId));
  if (messageIds.size === 0) return false;
  const nodes = resolveMessageElements(messageIds);
  if (nodes.length === 0) return false;

  for (const node of nodes) node.dataset.lineageFocus = 'true';
  nodes[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => {
    for (const node of nodes) delete node.dataset.lineageFocus;
  }, 3200);
  return true;
}

export function focusTurnAbsorptionSummary(messages: readonly ChatMessage[], invocationId: string): boolean {
  if (typeof document === 'undefined') return false;
  resolveMessageElements(collectInvocationLineageMessageIds(messages, invocationId));
  const dock = [...document.querySelectorAll<HTMLDetailsElement>('details[data-turn-absorption-invocation]')].find(
    (candidate) => candidate.dataset.turnAbsorptionInvocation === invocationId,
  );
  if (!dock) return focusInvocationLineage(messages, invocationId);
  dock.open = true;
  dock.dataset.lineageFocus = 'true';
  dock.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => delete dock.dataset.lineageFocus, 3200);
  return true;
}

function latestReminderForTarget(receipt: QueueMessageReceipt, targetCatId: string): QueueReminderAttempt | undefined {
  return receipt.reminderAttempts
    .filter((attempt) => attempt.targetCatId === targetCatId)
    .sort((left, right) => right.requestedAt - left.requestedAt)[0];
}

function formatReceiptTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function targetTimingLabel(target: QueueReceiptTarget, scope: QueueMessageReceipt['scope']): string | undefined {
  const awakened = target.awakenedAt === undefined ? undefined : `回合唤醒 ${formatReceiptTime(target.awakenedAt)}`;
  const seen = target.seenAt === undefined ? undefined : `正文读取 ${formatReceiptTime(target.seenAt)}`;
  const withdrawn =
    target.withdrawnAt === undefined ? undefined : `撤出待处理 ${formatReceiptTime(target.withdrawnAt)}`;
  const handledAt = target.state === 'handled' ? target.outcome?.handledAt : undefined;
  const handled =
    handledAt === undefined
      ? undefined
      : scope === 'cross_thread_delivery'
        ? `本轮消费 ${formatReceiptTime(handledAt)}`
        : `处理完成 ${formatReceiptTime(handledAt)}`;
  return [awakened, seen, withdrawn, handled].filter(Boolean).join(' · ') || undefined;
}

function reminderTitle(attempt: QueueReminderAttempt): string | undefined {
  if (attempt.state !== 'missed') return undefined;
  if (attempt.missedReason === 'source_withdrawn') return '消息已由你撤出待处理，提醒随之结束';
  if (attempt.missedReason === 'delivered_not_read') return '提醒曾送达，但本轮结束前没有读取消息正文';
  return '本轮结束前，提醒没有完成送达';
}

function attemptStatus(
  target: QueueReceiptTarget,
): 'pending' | 'spawning' | 'streaming' | 'done' | 'error' | undefined {
  if (target.state === 'failed' || target.state === 'interrupted') return 'error';
  if (target.state === 'handled' || target.state === 'withdrawn') return 'done';
  if (target.state === 'seen') return 'streaming';
  if (target.state === 'awakened' || target.state === 'steering') return 'spawning';
  return 'pending';
}

interface MessageReceiptDockProps {
  messageId?: string;
  receipt: QueueMessageReceipt;
  messages: readonly ChatMessage[];
  activeInvocationIds?: ReadonlySet<string>;
  getCatLabel: (catId: string) => string;
}

export function MessageReceiptDock({
  messageId,
  receipt,
  messages,
  activeInvocationIds = EMPTY_ACTIVE_INVOCATION_IDS,
  getCatLabel,
}: MessageReceiptDockProps) {
  const isCrossThreadDelivery = receipt.scope === 'cross_thread_delivery';
  const [retryingAttemptId, setRetryingAttemptId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const retry = async (target: QueueReceiptTarget, attempt: QueueTargetAttempt) => {
    if (!messageId) return;
    setRetryingAttemptId(attempt.id);
    setRetryError(null);
    try {
      const response = await apiFetch(
        `/api/messages/${encodeURIComponent(messageId)}/queue-targets/${encodeURIComponent(target.catId)}/retry`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ attemptId: attempt.id }),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? '重试未能排入队列');
      }
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : '重试未能排入队列');
    } finally {
      setRetryingAttemptId(null);
    }
  };

  if (receipt.scope === 'primary_trigger') return null;

  return (
    <section
      data-testid="message-receipt-dock"
      className="mt-3 border-t border-cafe pt-2 text-xs text-cafe-secondary"
      aria-label="本条消息的处理回执"
    >
      <div className="mb-1.5 font-medium text-cafe-muted">{isCrossThreadDelivery ? '系统回执' : '处理回执'}</div>
      <div className="ml-1 border-l-2 border-cafe pl-3">
        {receipt.targets.map((target) => {
          const reminder = latestReminderForTarget(receipt, target.catId);
          const intentLabel = authorIntentLabel(target.authorIntent);
          const timing = targetTimingLabel(target, receipt.scope);
          const evidence = target.state === 'handled' ? target.outcome?.evidenceRef : undefined;
          const executionKind = findExecutionKind(
            messages,
            target.invocationId ?? (target.state === 'handled' ? target.outcome?.invocationId : undefined),
          );
          const loadedLineage = evidence
            ? collectInvocationLineageMessageIds(messages, evidence.invocationId).length > 0
            : false;
          const latestAttempt = target.attempts?.at(-1);
          const retryableAttempt = latestRetryableQueueAttempt(target);
          return (
            <div
              key={target.catId}
              className="relative py-1"
              data-receipt-target={target.catId}
              data-terminal-consumption={target.outcome?.consumption?.kind}
            >
              <span
                aria-hidden
                className="absolute -left-[17px] top-2.5 h-2 w-2 rounded-full bg-[var(--color-cocreator-primary)]"
              />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <CatAvatar catId={target.catId} size={18} status={attemptStatus(target)} />
                <span>{`${getCatLabel(target.catId)} · ${receiptTargetStateLabel(
                  target,
                  activeInvocationIds,
                  receipt.scope,
                  loadedLineage,
                )}`}</span>
                {intentLabel && <span data-receipt-author-intent>{intentLabel}</span>}
                {target.authorIntent?.carrierCapability && (
                  <details className="text-cafe-muted" data-receipt-carrier-detail={target.catId}>
                    <summary className="cursor-pointer select-none inline" data-receipt-carrier-summary={target.catId}>
                      {humanCarrierLabel(target.authorIntent.carrierCapability)}
                    </summary>
                    <span className="block ml-2 mt-0.5" data-receipt-carrier-capability>
                      {carrierCapabilityLabel(target.authorIntent.carrierCapability)}
                    </span>
                  </details>
                )}
                {executionKind && (
                  <span
                    className="font-medium text-cafe-muted"
                    data-receipt-execution-kind={executionKind}
                    title={`typed child execution: ${executionKind}`}
                  >
                    {EXECUTION_KIND_LABEL[executionKind]}
                  </span>
                )}
                {evidence && loadedLineage && (
                  <button
                    type="button"
                    data-receipt-lineage-link={evidence.invocationId}
                    onClick={() => focusInvocationLineage(messages, evidence.invocationId)}
                    className="font-medium text-[var(--color-cocreator-primary)] hover:underline"
                    title="定位并高亮这一轮的全部回复与补充"
                    aria-label={`查看 ${getCatLabel(target.catId)} 的完整处理链路`}
                  >
                    {target.outcome?.disposition === 'responded' ? '查看回复 ↑' : '查看本轮 ↑'}
                  </button>
                )}
                {retryableAttempt && messageId && (
                  <button
                    type="button"
                    data-retry-target={target.catId}
                    disabled={retryingAttemptId !== null}
                    onClick={() => void retry(target, retryableAttempt)}
                    className="font-medium text-[var(--color-cocreator-primary)] hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {retryingAttemptId === retryableAttempt.id ? '正在重试…' : '重试'}
                  </button>
                )}
              </div>
              {(target.state === 'failed' || target.state === 'interrupted') && (
                <output
                  className="mt-1 flex items-center gap-1.5 rounded-md border border-semantic-critical/30 bg-semantic-critical-surface/60 px-2 py-1 text-micro text-semantic-critical"
                  data-receipt-failure={target.catId}
                >
                  <CatAvatar catId={target.catId} size={16} status="error" />
                  <span>
                    系统：{receiptFailureReason(target)}
                    {latestAttempt ? ` · 本条消息第 ${latestAttempt.sequence} 次尝试` : ''}
                  </span>
                </output>
              )}
              {timing && (
                <div
                  className="mt-0.5 text-micro tabular-nums text-cafe-muted"
                  data-awakened-at={target.awakenedAt}
                  data-seen-at={target.seenAt}
                  data-withdrawn-at={target.withdrawnAt}
                  data-handled-at={target.state === 'handled' ? target.outcome?.handledAt : undefined}
                  title={timing}
                >
                  {timing}
                </div>
              )}
              {target.outcome?.consumption?.kind === 'terminal_silent' && (
                <div className="mt-0.5 text-micro text-cafe-muted">协调链已结束，没有新任务，因此无需回复</div>
              )}
              {reminder && (
                <div className="mt-0.5 text-micro text-cafe-muted" title={reminderTitle(reminder)}>
                  {REMINDER_STATE_LABEL[reminder.state]}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {retryError && (
        <output className="mt-2 rounded-md border border-semantic-critical/30 bg-semantic-critical-surface/60 px-2 py-1 text-micro text-semantic-critical">
          重试未成功：{retryError}
        </output>
      )}
    </section>
  );
}
