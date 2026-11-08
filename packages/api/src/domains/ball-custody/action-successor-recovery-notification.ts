import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { ActionRecoveryNotification } from './action-successor-recovery-state.js';

/** Status-only Message: the existing owner row holds the intent; Message idempotency is its receipt. */
export function createActionRecoveryNotification(deps: {
  messages: Pick<IMessageStore, 'append' | 'getByIdempotencyKey'>;
  threads: Pick<IThreadStore, 'get'>;
  now?: () => number;
}): ActionRecoveryNotification {
  return async ({ lease, lane, key, reasonCode }) => {
    const thread = await deps.threads.get(lease.holderThreadId);
    if (!thread || thread.deletedAt || thread.createdBy !== lease.tenantScope) return 'owner_unavailable';
    const existing = await deps.messages.getByIdempotencyKey(lease.tenantScope, lease.holderThreadId, key);
    if (!existing) {
      try {
        await deps.messages.append({
          from: { kind: 'system', service: 'action-successor' },
          userId: lease.tenantScope,
          threadId: lease.holderThreadId,
          content: `这条交接的自动恢复已暂停（${reasonCode}）。原交接记录和结果仍保留，请检查原记录。`,
          mentions: [],
          timestamp: (deps.now ?? Date.now)(),
          idempotencyKey: key,
          source: {
            connector: 'action-successor',
            label: '交接需检查',
            icon: '🏓',
            meta: { leaseId: lease.leaseId, generation: lease.generation, lane, phase: 'status' },
          },
        });
      } catch (error) {
        if (!(await deps.messages.getByIdempotencyKey(lease.tenantScope, lease.holderThreadId, key))) throw error;
      }
    }
    return 'delivered';
  };
}
