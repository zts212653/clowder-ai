'use client';

import type { QueueEntry } from '@/stores/chat-types';
import { latestRetryableQueueAttempt, queueEntryHasSteerableTarget } from './queue-retry-action';

interface QueueEntryActionsProps {
  entry: QueueEntry;
  retryingAttemptIds: ReadonlySet<string>;
  onRetry: (messageId: string, targetCatId: string, attemptId: string) => void;
  onSteer: (entryId: string) => void;
}

export function QueueEntryActions({ entry, retryingAttemptIds, onRetry, onSteer }: QueueEntryActionsProps) {
  const messageId = entry.messageId;
  const retryActions = messageId
    ? (entry.queueReceipt?.targets.flatMap((target) => {
        const attempt = latestRetryableQueueAttempt(target);
        return attempt ? [{ messageId, target, attempt }] : [];
      }) ?? [])
    : [];

  return (
    <>
      {queueEntryHasSteerableTarget(entry) && (
        <button
          type="button"
          data-testid={`steer-${entry.id}`}
          onClick={() => onSteer(entry.id)}
          className="text-xs px-2.5 py-1 rounded-full border border-cafe text-cafe-secondary hover:bg-cafe-surface transition-colors"
          aria-label="Steer"
        >
          Steer
        </button>
      )}
      {retryActions.map(({ messageId, target, attempt }) => (
        <button
          key={target.catId}
          type="button"
          data-testid={`retry-${entry.id}-${target.catId}`}
          disabled={retryingAttemptIds.has(attempt.id)}
          onClick={() => onRetry(messageId, target.catId, attempt.id)}
          className="text-xs px-2.5 py-1 rounded-full border border-cafe text-cafe-secondary hover:bg-cafe-surface disabled:cursor-wait disabled:opacity-60 transition-colors"
          aria-label={`Retry ${target.catId}`}
        >
          {retryingAttemptIds.has(attempt.id) ? '重试中…' : '重试'}
        </button>
      ))}
    </>
  );
}
