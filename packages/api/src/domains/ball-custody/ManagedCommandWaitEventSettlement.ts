import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type {
  ManagedCommandWakeDynamicTaskStore,
  ManagedCommandWakeRecoveryResult,
} from './managed-command-wake-lifecycle.js';

/** Coalesces transient event hints only. Wait rows and History retain every durable responsibility. */
export class ManagedCommandWaitEventSettlement {
  private readonly active = new Map<string, Promise<ManagedCommandWakeRecoveryResult>>();
  private readonly recheck = new Set<string>();
  constructor(
    private readonly store: ManagedCommandWakeDynamicTaskStore,
    private readonly process: (taskId: string, force: boolean) => Promise<ManagedCommandWakeRecoveryResult>,
  ) {}

  recover(taskId: string, force: boolean): Promise<ManagedCommandWakeRecoveryResult> {
    const existing = this.active.get(taskId);
    if (existing) {
      if (force) this.recheck.add(taskId);
      return existing;
    }
    let forced = force;
    const run = async () => {
      for (;;) {
        this.recheck.delete(taskId);
        const result = await this.process(taskId, forced);
        if (this.recheck.delete(taskId)) {
          forced = true;
          continue;
        }
        // Release synchronously before resolving: an event after this point starts a new observation.
        this.active.delete(taskId);
        return result;
      }
    };
    const operation = run().finally(() => {
      if (this.active.get(taskId) === operation) {
        this.active.delete(taskId);
        this.recheck.delete(taskId);
      }
    });
    this.active.set(taskId, operation);
    return operation;
  }

  async onMessage(message: StoredMessage): Promise<number> {
    const lifecycle = message.lifecycle;
    if (lifecycle?.kind === 'response' && lifecycle.status === 'processing') return 0;
    const sources =
      lifecycle?.kind === 'response'
        ? lifecycle.inputMessageIds
        : lifecycle?.kind === 'delivery_failure'
          ? [lifecycle.inputMessageId]
          : [message.id];
    let observed = 0;
    for (const sourceId of new Set(sources)) {
      for (const id of this.store.findManagedCommandWaitsForSource?.(sourceId) ?? []) {
        const ref = this.store.getManagedCommandRecoveryState?.(id)?.fact.consumption;
        if (
          !ref ||
          ref.sourceMessageId !== sourceId ||
          ref.threadId !== message.threadId ||
          (ref.userId !== message.userId &&
            !(
              message.userId === 'system' &&
              message.from?.kind === 'system' &&
              message.from.service === 'message_delivery' &&
              lifecycle?.kind === 'delivery_failure'
            ))
        )
          continue;
        if (lifecycle?.kind === 'response' && lifecycle.targetId !== ref.catId) continue;
        if (lifecycle?.kind === 'delivery_failure' && !lifecycle.requestedTargets.includes(ref.catId)) continue;
        await this.recover(id, true);
        observed++;
      }
    }
    return observed;
  }
}
