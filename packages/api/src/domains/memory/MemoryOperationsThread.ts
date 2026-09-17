import { createHash } from 'node:crypto';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';

export const MEMORY_OPERATIONS_THREAD_TITLE = '记忆整理';

export function memoryOperationsThreadId(ownerUserId: string): string {
  const ownerScope = createHash('sha256').update(`memory_ops\0${ownerUserId}`).digest('hex').slice(0, 24);
  return `thread_memory_ops_${ownerScope}`;
}

/** Ensure the one reusable owner-indexed carrier for background memory work. */
export async function ensureMemoryOperationsThread(threadStore: IThreadStore, ownerUserId: string): Promise<string> {
  const threadId = memoryOperationsThreadId(ownerUserId);
  const existing = await threadStore.get(threadId);
  if (!existing) {
    await threadStore.ensureThread(threadId, MEMORY_OPERATIONS_THREAD_TITLE);
  } else {
    if (!existing.title?.trim()) await threadStore.updateTitle(threadId, MEMORY_OPERATIONS_THREAD_TITLE);
    if (existing.deletedAt != null) await threadStore.restore(threadId);
  }
  if (existing?.systemKind !== 'memory_ops') {
    await threadStore.updateSystemKind(threadId, 'memory_ops');
  }
  await threadStore.indexForUser(threadId, ownerUserId);
  return threadId;
}
