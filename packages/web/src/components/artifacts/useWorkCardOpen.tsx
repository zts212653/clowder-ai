'use client';
import type { WorkReference } from '@cat-cafe/shared';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useContentOpen } from '../content-review/useContentOpen';

type WorkCardSelection = { reference: WorkReference; title: string; navigationOrigin?: WorkspaceFileNavigationOrigin };
/** A registered card supplies its exact owner/version; the common opener owns every transition. */
export function useWorkCardOpen(reference: WorkReference | undefined, title: string, messageId?: string) {
  const opening = useContentOpen(undefined, JSON.stringify([reference?.contentRef, reference?.ownerRevision]));
  return {
    ...opening,
    open: (
      mode: 'lightbox' | 'work-mode',
      current = false,
      selection?: WorkCardSelection,
      expectedSurfaceKey?: string,
    ) => {
      const selected = selection ?? (reference ? { reference, title } : null);
      if (!selected) return Promise.resolve(false);
      const threadId = useChatStore.getState().currentThreadId;
      const origin =
        selected.navigationOrigin ??
        (threadId && messageId ? { kind: 'chat-file-link' as const, threadId, messageId } : undefined);
      return opening.openContent(
        { kind: 'work', reference: selected.reference, title: selected.title, current, origin, expectedSurfaceKey },
        mode,
      );
    },
  };
}
