'use client';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useArtworkLightboxScope } from '../content-review/ArtworkLightboxScope';

/** One stable portal owns the original input. Moving its container never remounts ChatInput or its draft. */
export function ThreadComposerHost({ threadId, children }: { threadId: string; children: ReactNode }) {
  const scope = useArtworkLightboxScope();
  const home = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const height = useRef(0);
  const floating = scope?.threadId === threadId && !!scope.work;
  const destination = floating ? scope.composerSlot : null;
  useLayoutEffect(() => {
    const node = document.createElement('div');
    node.dataset.threadComposerHost = threadId;
    setContainer(node);
    return () => node.remove();
  }, [threadId]);
  useLayoutEffect(() => {
    if (!container || !home.current) return;
    const previous =
      document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
        ? document.activeElement
        : null;
    const text = previous instanceof HTMLTextAreaElement || previous instanceof HTMLInputElement ? previous : null;
    const selection = text ? ([text.selectionStart, text.selectionEnd] as const) : null;
    if (container.parentElement === home.current) height.current = container.getBoundingClientRect().height;
    home.current.style.height = floating ? `${height.current}px` : '';
    const target = destination ?? home.current;
    if (container.parentElement !== target) target.appendChild(container);
    if (previous?.isConnected) {
      previous.focus({ preventScroll: true });
      if (text && selection && selection[0] !== null && selection[1] !== null)
        text.setSelectionRange(selection[0], selection[1]);
    }
  }, [container, destination, floating]);
  return (
    <>
      <div ref={home} data-thread-composer-home />
      {container && createPortal(children, container)}
    </>
  );
}
