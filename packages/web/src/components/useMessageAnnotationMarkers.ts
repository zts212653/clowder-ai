'use client';

import type { QuoteContextAttachment } from '@cat-cafe/shared';
import { type RefObject, useLayoutEffect, useMemo, useState } from 'react';
import { type ContextAnnotationMarker, positionAnnotationMarkers } from './context-annotation-markers';
import { useComposerContextAttachments } from './useComposerContextAttachments';

const CHAT_LAYOUT_CHANGED_EVENT = 'catcafe:chat-layout-changed';

export function useMessageAnnotationMarkers(
  rootRef: RefObject<HTMLElement>,
  threadId: string,
  messageId: string,
): readonly ContextAnnotationMarker[] {
  const composerContextAttachments = useComposerContextAttachments(threadId);
  const candidates = useMemo(
    () =>
      composerContextAttachments
        .filter(
          (attachment): attachment is QuoteContextAttachment =>
            attachment.kind === 'quote' && Boolean(attachment.comment),
        )
        .map((attachment, index) => ({ attachment, number: index + 1 }))
        .filter(
          ({ attachment }) =>
            attachment.source.kind !== 'workspace_file' &&
            attachment.source.threadId === threadId &&
            attachment.source.messageId === messageId,
        ),
    [composerContextAttachments, messageId, threadId],
  );
  const [markers, setMarkers] = useState<ContextAnnotationMarker[]>([]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || candidates.length === 0) {
      setMarkers([]);
      return;
    }
    const sync = () => setMarkers(positionAnnotationMarkers(root, candidates));
    document.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    window.addEventListener(CHAT_LAYOUT_CHANGED_EVENT, sync);
    sync();
    return () => {
      document.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
      window.removeEventListener(CHAT_LAYOUT_CHANGED_EVENT, sync);
    };
  }, [candidates, rootRef]);

  return markers;
}
