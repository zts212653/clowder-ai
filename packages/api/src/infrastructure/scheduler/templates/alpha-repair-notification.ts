import type { TaskItem } from '@cat-cafe/shared';
import { queueEntryId } from '../../../domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import type { StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { ExecuteContext } from '../types.js';
import type { AlphaBrowserOptions } from './alpha-browser.js';

const REMINDER_INTERVAL_MS = 24 * 60 * 60_000;

function withdrawn(message: StoredMessage): boolean {
  return message.deliveryStatus === 'canceled' || Boolean(message.deletedAt || message.recall || message._tombstone);
}

async function runningOrStopped(
  options: AlphaBrowserOptions,
  message: StoredMessage,
  target: string,
): Promise<boolean> {
  for (const ref of message.lifecycle?.dispatchRefs ?? []) {
    if (ref.targetId !== target) continue;
    // An unresolved native append is not permission to send another input.
    if (ref.phase === 'dispatched' || ref.appendAcceptance === 'pending' || ref.appendAcceptance === 'written')
      return true;
    const result = await options.messages.getById(ref.statusMessageId);
    if (
      result?.lifecycle?.kind === 'response' &&
      (result.lifecycle.status === 'processing' || result.lifecycle.status === 'canceled')
    )
      return true;
  }
  return false;
}

async function repeatDisposition(
  options: AlphaBrowserOptions,
  task: TaskItem,
  existing: StoredMessage | null,
  targetCatId: string,
  content: string,
): Promise<'stop' | 'remind' | 'replay'> {
  if (!existing) return 'replay';
  if (withdrawn(existing)) return 'stop';
  if (existing.content !== content || !existing.mentions.some((id) => id === targetCatId)) {
    throw new Error('Alpha repair notification identity conflict');
  }
  if (await runningOrStopped(options, existing, targetCatId)) return 'stop';
  if (await options.queue.getDurableEntry(task.threadId, queueEntryId(existing.id))) return 'replay';
  const lastProgress = Math.max(task.updatedAt, existing.timestamp, existing.deliveredAt ?? 0);
  // Delivery (including a visible launch failure) is not completed repair.
  // New progress or an active Queue/response suppresses the daily reminder.
  return Date.now() - lastProgress < REMINDER_INTERVAL_MS ? 'stop' : 'remind';
}

/** History is the retry receipt; Task owns repair progress and Queue owns active work. */
export async function notifyAlphaRepair(
  options: AlphaBrowserOptions,
  ctx: ExecuteContext,
  task: TaskItem,
  targetCatId: string,
): Promise<void> {
  if (task.status === 'blocked') return;
  if (!ctx.deliver) throw new Error('Alpha failure delivery is required');
  const baseKey = `alpha-repair:${task.id}:${targetCatId}`;
  const content = `Alpha 浏览器修复任务\n内部 P1：${task.id}\n请读取并推进此任务：查根因、修复、复验；不能仅登记或分诊后关闭。相同故障的后续 RED 会归到本任务。`;
  let key = baseKey;
  for (;;) {
    const existing = await options.messages.getByIdempotencyKey(options.ownerUserId, task.threadId, key);
    const next = await repeatDisposition(options, task, existing, targetCatId, content);
    if (next === 'stop') return;
    if (existing && next === 'remind') {
      key = `${baseKey}:after:${existing.id}`;
      continue;
    }
    try {
      await ctx.deliver({
        threadId: task.threadId,
        content,
        userId: options.ownerUserId,
        targetCatId,
        idempotencyKey: key,
        deliveryStatus: 'queued',
        sourceCategory: 'scheduled',
        priority: 'urgent',
      });
      return;
    } catch (error) {
      // Withdrawal may win between the read above and atomic delivery. Only
      // that explicit terminal choice is acknowledged; real admission errors retry.
      const current = await options.messages.getByIdempotencyKey(options.ownerUserId, task.threadId, key);
      if (current && withdrawn(current)) return;
      throw error;
    }
  }
}
