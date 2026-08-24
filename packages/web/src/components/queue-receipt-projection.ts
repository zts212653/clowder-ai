import type { QueueMessageReceipt, QueueReceiptTarget } from '@cat-cafe/shared';
import type { CatInvocationInfo, QueueEntry } from '@/stores/chat-types';

export const UNSETTLED_SEEN_LABEL = '已读，但关联回合已结束；尚未确认处理完成';

function completedWithTurnReceiptLabel(scope?: QueueMessageReceipt['scope']): string {
  return scope === 'cross_thread_delivery' ? '正文已由本轮消费' : '已随本轮完成';
}

type QueueTargetState = NonNullable<QueueEntry['targetStates']>[string];
type ActiveInvocationSlots = Record<string, { catId: string }>;

export function queueTargetStateEntries(entry: QueueEntry): [string, QueueTargetState][] {
  return Object.entries(entry.targetStates ?? {});
}

/**
 * Resolve every identity that is proven live without changing the parent-keyed control slots.
 *
 * `activeInvocations` owns cancellation and is normally keyed by the parent execution id.
 * Receipts own body exposure and carry the child turn id. `catInvocations` is the typed bridge
 * between those namespaces. A stale same-cat child is admitted only when its recorded parent
 * still owns that cat's exact active slot.
 */
export function collectExactLiveInvocationIds(
  activeInvocations: ActiveInvocationSlots,
  catInvocations: Record<string, CatInvocationInfo>,
): ReadonlySet<string> {
  const ids = new Set(Object.keys(activeInvocations));
  for (const [slotId, slot] of Object.entries(activeInvocations)) {
    const invocation = catInvocations[slot.catId];
    if (!invocation?.invocationId || !invocation.turnInvocationId) continue;
    const ownsSlot = slotId === invocation.invocationId || slotId === `${invocation.invocationId}-${slot.catId}`;
    if (ownsSlot) ids.add(invocation.turnInvocationId);
  }
  return ids;
}

function receiptTargetFor(entry: QueueEntry, catId: string): QueueReceiptTarget | undefined {
  return entry.queueReceipt?.targets.find((target) => target.catId === catId);
}

export function isExactSeenTargetLive(
  entry: QueueEntry,
  catId: string,
  activeInvocationIds: ReadonlySet<string>,
): boolean {
  const invocationId = receiptTargetFor(entry, catId)?.invocationId;
  return typeof invocationId === 'string' && activeInvocationIds.has(invocationId);
}

function isQueueTargetActionable(
  entry: QueueEntry,
  catId: string,
  state: QueueTargetState,
  activeInvocationIds: ReadonlySet<string>,
): boolean {
  if (state === 'handled' || state === 'withdrawn') return false;
  if (state !== 'seen' && state !== 'awakened') return true;
  return !isExactSeenTargetLive(entry, catId, activeInvocationIds);
}

/**
 * QueuePanel is an action surface, not a second execution-history surface.
 *
 * Exact seen+live targets and handled targets stay on the original message receipt.
 * A seen target without its exact live invocation fails closed to a visible, recoverable
 * anomaly. Entries without an enriched per-target receipt stay visible.
 */
export function projectQueueEntryForActions(
  entry: QueueEntry,
  activeInvocationIds: ReadonlySet<string>,
): QueueEntry | null {
  const targetStates = queueTargetStateEntries(entry);
  if (targetStates.length === 0) return entry;

  const actionableStates = targetStates.filter(([catId, state]) =>
    isQueueTargetActionable(entry, catId, state, activeInvocationIds),
  );
  if (actionableStates.length === 0) return null;

  return {
    ...entry,
    targetCats: actionableStates.map(([catId]) => catId),
    targetStates: Object.fromEntries(actionableStates),
  };
}

export function queueEntryNeedsRecovery(
  entry: QueueEntry,
  activeInvocationIds: ReadonlySet<string>,
  activeCatIds: ReadonlySet<string>,
): boolean {
  const targetStates = queueTargetStateEntries(entry);
  if (targetStates.length > 0) {
    return targetStates.some(([catId, state]) => {
      if (state === 'handled' || state === 'withdrawn') return false;
      if (state === 'seen' || state === 'awakened') {
        return !isExactSeenTargetLive(entry, catId, activeInvocationIds);
      }
      return !activeCatIds.has(catId);
    });
  }
  if (entry.targetCats.length === 0) return activeInvocationIds.size === 0;
  return entry.targetCats.some((catId) => !activeCatIds.has(catId));
}

export function receiptTargetStateLabel(
  target: QueueReceiptTarget,
  activeInvocationIds: ReadonlySet<string>,
  scope?: QueueMessageReceipt['scope'],
): string {
  if (target.outcome?.consumption?.kind === 'terminal_silent') {
    return '已消费 · terminal 静默结束';
  }
  if (target.state === 'seen') {
    return target.invocationId && activeInvocationIds.has(target.invocationId)
      ? scope === 'cross_thread_delivery'
        ? '已唤醒 · 当前轮处理中'
        : '已读 · 当前轮处理中'
      : UNSETTLED_SEEN_LABEL;
  }
  if (target.state === 'awakened') {
    return target.invocationId && activeInvocationIds.has(target.invocationId)
      ? '已唤醒 · 等待接入本轮'
      : '已唤醒，但关联回合已结束；尚未读取消息正文';
  }
  if (target.state === 'queued') return scope === 'cross_thread_delivery' ? '已送达' : '未读 · 排队中';
  if (target.state === 'notified') return scope === 'cross_thread_delivery' ? '已送达' : '已提醒 · 尚未读取';
  if (target.state === 'interrupted') return '运行因服务重启中断 · 未自动重试';
  if (target.state === 'failed') {
    if (target.seenAt !== undefined) return '已读取 · 未收口，已回队列';
    return target.invocationId ? '已唤醒 · 未收口，已回队列' : '未能唤醒 · 已回队列';
  }
  if (target.state === 'steering') return 'Steer 中';
  if (target.state === 'withdrawn') return '已撤出待处理 · 历史保留';
  if (target.outcome?.disposition === 'responded') return '已由回复明确处理';
  if (target.outcome?.disposition === 'completed_with_turn') {
    return completedWithTurnReceiptLabel(scope);
  }
  return '已处理 · 无可回溯证据';
}

export function receiptFailureReason(target: QueueReceiptTarget): string {
  const latest = target.attempts?.at(-1);
  if (latest?.terminalReason === 'runtime_restart') return '运行已因服务重启中断；系统没有自动重放';
  if (latest?.terminalReason === 'invocation_cancelled') return '对应回复已停止，消息正文没有完成处理';
  if (target.seenAt !== undefined) return '消息正文已进入回复，但该回复未完成';
  if (target.invocationId) return '已创建对应回复，但消息正文未能进入该回复';
  return '系统未能为该目标启动本次消息处理';
}
