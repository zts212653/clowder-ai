import type { QueueEntry } from './InvocationQueue.js';

/** Minimal queue surface needed to converge a dead invocation's stale entry. */
export interface ZombieQueueConverger {
  list(threadId: string, userId: string): QueueEntry[];
  removeProcessed(threadId: string, userId: string, entryId: string): QueueEntry | null;
}

export type QueueConvergedHandler = (info: { threadId: string; userId: string; removedEntryIds: string[] }) => void;

interface ZombieQueueRecord {
  threadId: string;
  userId: string;
  userMessageId?: string | null;
}

interface ZombieQueueIdentity {
  invocationId: string;
  reason: string;
}

interface ZombieQueueLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * F220 Phase 2a (clowder-ai#972) — remove the dead invocation's stale
 * `processing` queue entry.
 *
 * QueueEntry has no invocationId, so the trigger message is the join key:
 * InvocationRecord.userMessageId matches QueueEntry.messageId or mergedMessageIds.
 * Removal stays exact-id and processing-only; a concurrent replacement tombstone
 * therefore degrades to null without a duplicate broadcast.
 */
export function convergeZombieQueueEntry(
  queue: ZombieQueueConverger | undefined,
  record: ZombieQueueRecord,
  zombie: ZombieQueueIdentity,
  log: ZombieQueueLogger,
  onQueueConverged: QueueConvergedHandler | undefined,
): { converged: number; errors: number } {
  if (!queue) return { converged: 0, errors: 0 };
  const messageId = record.userMessageId;
  if (!messageId) return { converged: 0, errors: 0 };

  try {
    const stale = queue
      .list(record.threadId, record.userId)
      .filter(
        (entry) =>
          entry.status === 'processing' &&
          (entry.messageId === messageId || entry.mergedMessageIds?.includes(messageId)),
      );

    const removedEntryIds: string[] = [];
    for (const entry of stale) {
      if (queue.removeProcessed(record.threadId, record.userId, entry.id)) {
        removedEntryIds.push(entry.id);
        log.info(
          {
            invocationId: zombie.invocationId,
            entryId: entry.id,
            messageId,
            threadId: record.threadId,
            reason: zombie.reason,
          },
          '[reconcile-zombies] converged stale processing queue entry',
        );
      }
    }

    if (removedEntryIds.length > 0) {
      onQueueConverged?.({ threadId: record.threadId, userId: record.userId, removedEntryIds });
    }
    return { converged: removedEntryIds.length, errors: 0 };
  } catch (err) {
    log.warn(
      {
        invocationId: zombie.invocationId,
        err: err instanceof Error ? err.message : String(err),
      },
      '[reconcile-zombies] failed to converge queue entry',
    );
    return { converged: 0, errors: 1 };
  }
}
