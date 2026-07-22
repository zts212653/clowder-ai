import type { CatId } from '@cat-cafe/shared';
import type { TaskProgressSnapshot, TaskProgressStore } from './TaskProgressStore.js';

export class MemoryTaskProgressStore implements TaskProgressStore {
  private readonly byThread = new Map<string, Map<string, TaskProgressSnapshot>>();

  async getSnapshot(threadId: string, catId: CatId): Promise<TaskProgressSnapshot | null> {
    return this.byThread.get(threadId)?.get(catId) ?? null;
  }

  async setSnapshot(snapshot: TaskProgressSnapshot): Promise<void> {
    let thread = this.byThread.get(snapshot.threadId);
    if (!thread) {
      thread = new Map<string, TaskProgressSnapshot>();
      this.byThread.set(snapshot.threadId, thread);
    }
    thread.set(snapshot.catId, snapshot);
  }

  async deleteSnapshot(threadId: string, catId: CatId): Promise<void> {
    const thread = this.byThread.get(threadId);
    if (!thread) return;
    thread.delete(catId);
    if (thread.size === 0) this.byThread.delete(threadId);
  }

  async deleteSnapshotIfOwner(threadId: string, catId: CatId, invocationId: string): Promise<boolean> {
    const thread = this.byThread.get(threadId);
    const snapshot = thread?.get(catId);
    if (!thread || snapshot?.lastInvocationId !== invocationId) return false;
    thread.delete(catId);
    if (thread.size === 0) this.byThread.delete(threadId);
    return true;
  }

  async getThreadSnapshots(threadId: string): Promise<Record<string, TaskProgressSnapshot>> {
    const thread = this.byThread.get(threadId);
    if (!thread) return {};
    return Object.fromEntries(thread.entries());
  }

  async deleteThread(threadId: string): Promise<void> {
    this.byThread.delete(threadId);
  }
}
