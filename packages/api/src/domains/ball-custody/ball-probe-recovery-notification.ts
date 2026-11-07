import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { BallRecoveryNotice } from './ball-probe-recovery-state.js';

/** Status-only delivery. The original subject metadata retains pending intent until Message persistence confirms it. */
export function createBallProbeRecoveryNotification(deps: {
  messages: Pick<IMessageStore, 'append' | 'getByIdempotencyKey'>;
  threads: Pick<IThreadStore, 'get'>;
}): (notice: BallRecoveryNotice) => Promise<'delivered' | 'owner_unavailable'> {
  return async (notice) => {
    const { userId, threadId, taskId } = notice.owner;
    const thread = await deps.threads.get(threadId);
    if (!thread || thread.deletedAt || thread.createdBy !== userId) return 'owner_unavailable';
    if (!(await deps.messages.getByIdempotencyKey(userId, threadId, notice.key))) {
      try {
        await deps.messages.append({
          from: { kind: 'system', service: 'ball-custody-recovery' },
          userId,
          threadId,
          content: `这条任务的一次自动检查已暂停（${notice.reasonCode}）。原任务与记录仍保留，请检查原记录。`,
          mentions: [],
          timestamp: Date.now(),
          idempotencyKey: notice.key,
          source: {
            connector: 'ball-custody-recovery',
            label: '条件检查需处理',
            icon: '🏓',
            meta: { taskId, recoveryKey: notice.key, phase: 'status' },
          },
        });
      } catch (err) {
        if (!(await deps.messages.getByIdempotencyKey(userId, threadId, notice.key))) throw err;
      }
    }
    return 'delivered';
  };
}
