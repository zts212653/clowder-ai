'use client';

import { type RefObject, useLayoutEffect, useRef } from 'react';
import { getThreadDraft, restoreThreadDraftSelection, saveThreadDraftSelection } from './thread-drafts';

/** Keep the original composer's selection across its keyed thread remount without stealing focus. */
export function useThreadDraftSelection(
  threadId: string | undefined,
  input: string,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): void {
  const restoredThread = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!threadId || !textarea || restoredThread.current === threadId) return;
    // The first SSR snapshot can still be empty while the original draft mirror is hydrated.
    if (textarea.value !== getThreadDraft(threadId) || input !== textarea.value) return;
    restoreThreadDraftSelection(threadId, textarea);
    restoredThread.current = threadId;
  }, [input, textareaRef, threadId]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!threadId || !textarea) return;
    const capture = () => {
      if (restoredThread.current === threadId) saveThreadDraftSelection(threadId, textarea);
    };
    textarea.addEventListener('select', capture);
    textarea.addEventListener('blur', capture);
    window.addEventListener('pagehide', capture);
    return () => {
      capture();
      restoredThread.current = undefined;
      textarea.removeEventListener('select', capture);
      textarea.removeEventListener('blur', capture);
      window.removeEventListener('pagehide', capture);
    };
  }, [textareaRef, threadId]);
}
