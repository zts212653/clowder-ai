import type { MemoryReadUsage } from '@cat-cafe/shared';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';

/** Counts survive unavailable threads; navigation never grants access to a stale coordinate. */
export async function projectMemoryUsageThreads(
  usage: MemoryReadUsage,
  owner: string,
  store?: Pick<IThreadStore, 'get'> & Partial<Pick<IThreadStore, 'list'>>,
): Promise<MemoryReadUsage> {
  usage.recent = await Promise.all(
    usage.recent.map(async (row) => {
      if (!row.threadId) return row;
      const thread = await store?.get(row.threadId);
      const visible =
        thread &&
        !thread.deletedAt &&
        (canAccessThread(thread, owner) ||
          (thread.createdBy === 'system' && (await store?.list?.(owner))?.some((t) => t.id === thread.id)));
      return { ...row, threadId: visible ? row.threadId : null };
    }),
  );
  return usage;
}
