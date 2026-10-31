'use client';
import type { WorkspaceContentReview } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useWorkspaceSurfaceVisibility } from '../WorkspaceSurfaceVisibility';
import { readProjectReview, synchronizeProjectReview } from './screening-ui/project-review-read';

export function useProjectReview(contentRef: string, refresh: number) {
  const threadId = useChatStore((state) => state.currentThreadId),
    visible = useWorkspaceSurfaceVisibility();
  const [review, setReview] = useState<WorkspaceContentReview | null>(null);
  const [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly requests canonical ledger revalidation.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setReview(null);
    setError(null);
    const read = async () => {
      const sync = await synchronizeProjectReview(contentRef, threadId, controller.signal);
      if (!controller.signal.aborted && sync.pending !== null) setPending(sync.pending);
      const review = await readProjectReview(contentRef, controller.signal);
      if (!controller.signal.aborted) {
        setReview(review);
        setError(sync.error instanceof Error ? sync.error.message : null);
      }
    };
    const reportError = (failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '问题暂时不可读。');
    };
    const poll = async () => {
      await read().catch(reportError);
      if (!controller.signal.aborted && visible) timer = setTimeout(() => void poll(), 3000);
    };
    if (visible) void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [contentRef, threadId, refresh, visible]);
  return { review, error, pending };
}
