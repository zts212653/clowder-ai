import type { CatId } from '@cat-cafe/shared';
import type { IInvocationRecordStore } from '../../stores/ports/InvocationRecordStore.js';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';

export type RestartExecutionWitness =
  | 'child_execution'
  | 'legacy_parent_aggregate'
  | 'live_child'
  | 'interrupted_child'
  | 'retryable_terminal_child';

export async function resolveRestartExecutionWitness(
  message: StoredMessage,
  catId: string,
  invocationId: string,
  hasExactBodyExposure: boolean,
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>,
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>,
): Promise<RestartExecutionWitness | null> {
  if (turnExecutionStore) {
    const child = await turnExecutionStore.get(invocationId);
    if (child) {
      if (child.threadId !== message.threadId || child.userId !== message.userId || child.catId !== catId) {
        return null;
      }
      if (child.status === 'succeeded') return 'child_execution';
      if (child.status === 'running') return 'live_child';
      if (child.status === 'interrupted' && child.terminalReason === 'process_restart') return 'interrupted_child';
      return 'retryable_terminal_child';
    }
  }
  // Once an exact child/body tuple exists, only the durable child ledger may
  // close it. The parent aggregate is retained solely as a rolling-migration
  // witness for pre-ledger custody that never recorded an exact exposure.
  if (hasExactBodyExposure) return null;
  const record = await invocationRecordStore.get(invocationId);
  return record?.status === 'succeeded' &&
    record.threadId === message.threadId &&
    record.userId === message.userId &&
    record.targetCats.includes(catId as CatId) &&
    record.successfulCatIds?.includes(catId as CatId) === true
    ? 'legacy_parent_aggregate'
    : null;
}
