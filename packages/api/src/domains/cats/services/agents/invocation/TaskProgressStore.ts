import type { CatId } from '@cat-cafe/shared';

export type TaskProgressStatus = 'running' | 'completed' | 'interrupted';

export interface TaskProgressItem {
  id: string;
  subject: string;
  status: string;
  activeForm?: string;
}

export interface TaskProgressSnapshot {
  threadId: string;
  catId: CatId;
  tasks: TaskProgressItem[];
  status: TaskProgressStatus;
  updatedAt: number;
  lastInvocationId?: string;
  interruptReason?: string;
}

export interface TaskProgressStore {
  getSnapshot(threadId: string, catId: CatId): Promise<TaskProgressSnapshot | null>;
  setSnapshot(snapshot: TaskProgressSnapshot, options?: { ttlSeconds?: number }): Promise<void>;
  deleteSnapshot(threadId: string, catId: CatId): Promise<void>;
  /**
   * Delete only when the current snapshot still belongs to `invocationId`.
   * Implementations must make the comparison and deletion atomic because
   * zombie cleanup can race with a same-cat replacement snapshot.
   */
  deleteSnapshotIfOwner(threadId: string, catId: CatId, invocationId: string): Promise<boolean>;
  getThreadSnapshots(threadId: string): Promise<Record<string, TaskProgressSnapshot>>;
  deleteThread(threadId: string): Promise<void>;
}
