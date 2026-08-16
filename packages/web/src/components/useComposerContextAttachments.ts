'use client';

import type { ContextAttachment } from '@cat-cafe/shared';
import { useCallback, useSyncExternalStore } from 'react';
import { getContextAttachmentDraft, subscribeContextAttachmentDrafts } from './thread-drafts';

const EMPTY_CONTEXT_ATTACHMENTS: readonly ContextAttachment[] = [];

export function useComposerContextAttachments(threadId: string): readonly ContextAttachment[] {
  const getSnapshot = useCallback(() => getContextAttachmentDraft(threadId), [threadId]);
  return useSyncExternalStore(subscribeContextAttachmentDrafts, getSnapshot, () => EMPTY_CONTEXT_ATTACHMENTS);
}
