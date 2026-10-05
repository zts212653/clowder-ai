import type { ApprovalProducerRegistry } from '../../../approval-hub/ApprovalProducerRegistry.js';
import type { IContextEpochStore } from '../../../cats/services/stores/ports/ContextEpochStore.js';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStoreContract.js';
import type { LiveInboxScope, LiveInboxSource } from '../inbox/live-inbox-contract.js';

export interface LiveRecoveryOptions {
  tasks: Pick<ITaskStore, 'get' | 'listByThread'>;
  approvals: Pick<ApprovalProducerRegistry, 'listSettled'>;
  messages: Pick<IMessageStore, 'getById'>;
  epochs: Pick<IContextEpochStore, 'get'>;
  inbox: LiveInboxSource;
  /** Host checks current call/generation AND thread ownership/permission, never a renderer claim. */
  authorize(scope: LiveInboxScope): Promise<boolean>;
}

export interface RecoveryPosition {
  after?: string;
  complete: boolean;
}

/** Host-private ephemeral pagination. Reconnect/compaction must start a new pass. */
export interface LiveRecoveryCursor {
  binding: string;
  tasks: RecoveryPosition;
  decisions: RecoveryPosition;
  inbox: RecoveryPosition;
}

export interface LiveRecoveryRequest {
  signal: AbortSignal;
  cursor?: LiveRecoveryCursor;
  /** Per source, 1–20 items. Text excerpts are separately bounded. */
  pageSize?: number;
}

export const RECOVERY_DECISIONS_PER_PRODUCER = 100;

export function recoveryExcerpt(text: string, limit = 400) {
  return { text: text.slice(0, limit), truncated: text.length > limit };
}

export function recoveryPage<T>(items: T[], key: (item: T) => string, position: RecoveryPosition, limit: number) {
  if (position.complete) return { items: [] as T[], position };
  const remaining = items
    .filter((item) => !position.after || key(item) > position.after)
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const selected = remaining.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected,
    position: {
      after: last === undefined ? position.after : key(last),
      complete: remaining.length <= limit,
    },
  };
}
