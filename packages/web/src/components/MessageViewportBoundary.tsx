'use client';

import {
  type CSSProperties,
  type ReactNode,
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { MESSAGE_VIEWPORT_MOUNTED_EVENT, MOUNT_DEFERRED_MESSAGE_EVENT } from '@/utils/scrollToMessage';

const OFFSCREEN_MESSAGE_STYLE: CSSProperties = {
  containIntrinsicSize: 'auto 240px',
};

// `content-visibility: auto` also paint-contains descendants. The message toolbar floats above
// its row, so lift that containment only while the real row is interactive.
const CONTENT_VISIBILITY_CLASS =
  '[content-visibility:auto] hover:[content-visibility:visible] focus-within:[content-visibility:visible]';

/**
 * Keep the message DOM available for anchors/search while letting Chromium skip
 * layout and paint for bubbles far outside the scroll viewport.
 */
interface MessageViewportBoundaryProps {
  children: ReactNode;
  messageId?: string;
  eager?: boolean;
  backgroundMountDelayMs?: number;
}

export function MessageViewportBoundary({
  children,
  messageId,
  eager = false,
  backgroundMountDelayMs,
}: MessageViewportBoundaryProps) {
  const boundaryRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(eager || !messageId);
  const transitionPendingRef = useRef(!mounted);

  useEffect(() => {
    if (eager) setMounted(true);
  }, [eager]);

  useLayoutEffect(() => {
    if (mounted) return;
    const boundary = boundaryRef.current;
    if (!boundary) return;
    const mountForNavigation = () => {
      flushSync(() => setMounted(true));
    };
    boundary.addEventListener(MOUNT_DEFERRED_MESSAGE_EVENT, mountForNavigation);
    return () => boundary.removeEventListener(MOUNT_DEFERRED_MESSAGE_EVENT, mountForNavigation);
  }, [mounted]);

  useLayoutEffect(() => {
    if (!mounted || !messageId || !transitionPendingRef.current) return;
    transitionPendingRef.current = false;
    window.dispatchEvent(
      new CustomEvent<{ messageId: string }>(MESSAGE_VIEWPORT_MOUNTED_EVENT, { detail: { messageId } }),
    );
  }, [messageId, mounted]);

  useEffect(() => {
    if (mounted) return;
    const boundary = boundaryRef.current;
    if (!boundary || typeof IntersectionObserver === 'undefined') {
      setMounted(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setMounted(true);
        observer.disconnect();
      },
      { rootMargin: '1200px 0px' },
    );
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [mounted]);

  useEffect(() => {
    if (mounted || backgroundMountDelayMs === undefined) return;
    const timer = window.setTimeout(() => {
      startTransition(() => setMounted(true));
    }, backgroundMountDelayMs);
    return () => window.clearTimeout(timer);
  }, [backgroundMountDelayMs, mounted]);

  return (
    <div
      ref={boundaryRef}
      data-message-viewport-boundary
      data-message-viewport-id={messageId}
      className={CONTENT_VISIBILITY_CLASS}
      {...(!mounted && messageId ? { 'data-deferred-message-id': messageId } : {})}
      style={mounted ? OFFSCREEN_MESSAGE_STYLE : { ...OFFSCREEN_MESSAGE_STYLE, minHeight: '240px' }}
    >
      {mounted ? children : null}
    </div>
  );
}
