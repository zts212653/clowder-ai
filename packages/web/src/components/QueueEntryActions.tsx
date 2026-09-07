'use client';

import type { QueueRecoveryAction } from '@cat-cafe/shared';
import type { QueueEntry } from '@/stores/chat-types';

type RetryAction = Extract<QueueRecoveryAction, { kind: 'retry_target' }>;
type SteerAction = Extract<QueueRecoveryAction, { kind: 'steer' }>;
type ForceResetAction = Extract<QueueRecoveryAction, { kind: 'force_reset' }>;

interface QueueEntryActionsProps {
  entry: QueueEntry;
  retryingAttemptIds: ReadonlySet<string>;
  resettingActionIds: ReadonlySet<string>;
  onRetry: (action: RetryAction) => void;
  onSteer: (action: SteerAction) => void;
  onForceReset: (action: ForceResetAction) => void;
}

export function QueueEntryActions({
  entry,
  retryingAttemptIds,
  resettingActionIds,
  onRetry,
  onSteer,
  onForceReset,
}: QueueEntryActionsProps) {
  const retryActions = (entry.recoveryActions ?? []).filter(
    (action): action is RetryAction => action.kind === 'retry_target',
  );
  const steerAction = (entry.recoveryActions ?? []).find((action): action is SteerAction => action.kind === 'steer');
  const forceResetAction = (entry.recoveryActions ?? []).find(
    (action): action is ForceResetAction => action.kind === 'force_reset',
  );

  return (
    <>
      {steerAction && (
        <button
          type="button"
          data-testid={`steer-${entry.id}`}
          onClick={() => onSteer(steerAction)}
          className="text-xs px-2.5 py-1 rounded-full border border-cafe text-cafe-secondary hover:bg-cafe-surface transition-colors"
          aria-label="Steer"
        >
          Steer
        </button>
      )}
      {retryActions.map((action) => (
        <button
          key={action.id}
          type="button"
          data-testid={`retry-${entry.id}-${action.targetCatId}`}
          disabled={retryingAttemptIds.has(action.id)}
          onClick={() => onRetry(action)}
          className="text-xs px-2.5 py-1 rounded-full border border-cafe text-cafe-secondary hover:bg-cafe-surface disabled:cursor-wait disabled:opacity-60 transition-colors"
          aria-label={`Retry ${action.targetCatId}`}
        >
          {retryingAttemptIds.has(action.id) ? '重试中…' : '重试'}
        </button>
      ))}
      {forceResetAction && (
        <button
          type="button"
          data-testid={`force-reset-${entry.id}`}
          disabled={resettingActionIds.has(forceResetAction.id)}
          onClick={() => onForceReset(forceResetAction)}
          className="text-xs px-2.5 py-1 rounded-full border border-cafe text-conn-red-text hover:bg-cafe-surface disabled:cursor-wait disabled:opacity-60 transition-colors"
          aria-label="恢复卡住的处理"
        >
          {resettingActionIds.has(forceResetAction.id) ? '恢复中…' : '恢复卡住的处理'}
        </button>
      )}
    </>
  );
}
