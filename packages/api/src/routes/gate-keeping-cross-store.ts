/** Host-authoritative subject ownership for gate-keeping policy decisions. */

import type { TaskItem } from '@cat-cafe/shared';

/**
 * Minimal TaskStore interface — only the methods cross-store queries need.
 * Kept narrow so test stubs don't have to implement the full ITaskStore.
 */
export interface CrossStoreTaskStore {
  getBySubject(subjectKey: string): TaskItem | null | Promise<TaskItem | null>;
}

/** A subject is keeper-owned only when absent or already in this thread. */
export async function verifyKeeperOwnership(
  taskStore: CrossStoreTaskStore,
  threadId: string,
  subjectKey: string,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<'keeper' | 'distributed'> {
  try {
    const existing = await taskStore.getBySubject(subjectKey);

    // No existing subject has been assigned to another thread.
    if (!existing) return 'keeper';

    // Existing in same thread → keeper re-registering / updating
    if (existing.threadId === threadId) return 'keeper';

    // Existing in different thread → downstream already owns this
    return 'distributed';
  } catch (err) {
    log?.warn({ err, threadId, subjectKey }, 'verifyKeeperOwnership failed; distributed ownership assumed');
    return 'distributed';
  }
}
