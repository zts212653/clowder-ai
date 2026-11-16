'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

/**
 * How many files the 变更 page will list for this worktree — the same filtered Git status entries that page reads,
 * without generating the patch bodies that a count does not consume.
 *
 * `null` means "not known" (no worktree yet, the read is still in flight, or it failed). That is a third state, not zero:
 * the row writes nothing for it ("读不到就不写"), where it would write a count for a known number.
 *
 * A number belongs to the read that produced it. Every time a read begins — including coming back to a worktree already
 * seen, or selecting none — whatever an earlier read left is dropped first, so a pending, offline, refused or malformed
 * re-read can never be covered by an old success. Comparing worktree ids alone is not enough: it protects A → B, not
 * A → B → A. It is read once per mount and per worktree, and says the count at that moment.
 */
export function useChangedFileCount(worktreeId: string | null): number | null {
  const [read, setRead] = useState<{ worktreeId: string; count: number } | null>(null);

  useEffect(() => {
    setRead(null);
    if (!worktreeId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch(`/api/workspace/diff?worktreeId=${encodeURIComponent(worktreeId)}&view=count`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = (await response.json()) as { changedFileCount?: unknown };
        const count = body.changedFileCount;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return;
        if (!controller.signal.aborted) setRead({ worktreeId, count });
      } catch {
        /* Unknown stays unknown: no stale or invented number. */
      }
    })();
    return () => controller.abort();
  }, [worktreeId]);

  return worktreeId && read?.worktreeId === worktreeId ? read.count : null;
}
