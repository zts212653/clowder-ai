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
            attachment.source.kind !== 'collective_message' &&
            !(attachment.source.kind === 'message' && attachment.source.artifactFile) &&
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
    const sync = () => {
      const next = positionAnnotationMarkers(root, candidates);
      setMarkers((previous) =>
        previous.length === next.length &&
        previous.every((marker, index) => {
          const other = next[index];
          return (
            marker.attachment === other.attachment &&
            marker.number === other.number &&
            marker.position.top === other.position.top &&
            marker.position.left === other.position.left
          );
        })
          ? previous
          : next,
      );
    };
    // A split-pane resize or a covering portal need not resize the browser or scroll the source.
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
    for (let node: HTMLElement | null = root; node; node = node.parentElement) resize?.observe(node);
    const mutation = new MutationObserver(sync);
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'open'],
    });
    document.addEventListener('scroll', sync, true);
    document.addEventListener('load', sync, true);
    window.addEventListener('resize', sync);
    window.addEventListener(CHAT_LAYOUT_CHANGED_EVENT, sync);
    sync();
    return () => {
      resize?.disconnect();
      mutation.disconnect();
      document.removeEventListener('scroll', sync, true);
      document.removeEventListener('load', sync, true);
      window.removeEventListener('resize', sync);
      window.removeEventListener(CHAT_LAYOUT_CHANGED_EVENT, sync);
    };
  }, [candidates, rootRef]);

  return markers;
}
