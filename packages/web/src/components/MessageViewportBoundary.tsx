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
import { useShellPresentation } from './shell/shell-presentation';

const OFFSCREEN_MESSAGE_STYLE: CSSProperties = {
  containIntrinsicSize: 'auto 240px',
};

// Classic's in-row toolbar needs to escape paint containment while interactive.
// V2 actions and tooltips are body portals: keep its containment stable as the pointer
// crosses Activity, instead of invalidating the row's layout/paint at every hover edge.
const CONTENT_VISIBILITY_CLASS = '[content-visibility:auto]';
const CLASSIC_CONTENT_VISIBILITY_CLASS =
  '[content-visibility:auto] hover:[content-visibility:visible] focus-within:[content-visibility:visible]';

// F322 B §1.16: the cat's 32px face hangs 4px above its nameplate, with a 2px ring around it. `content-visibility:auto`
// paint-contains the row, so extend that paint clip by 6px without changing layout. Padding plus a cancelling negative
// margin looks equivalent for mounted rows, but shortens each border-box deferred placeholder from 240px to 234px and
// accumulates scroll-height error through long history. Classic never gets the extended clip.
const FACE_OVERFLOW_CLASS = '[overflow-clip-margin:6px]';

// Message roots in both shells own outer margins. Without a stable formatting context, moving focus between adjacent records changes
// whether that margin collapses while `content-visibility` flips between auto and visible. The next row can then move between a
// native pointer's down/up events and lose the click. `flow-root` contains the margin in both paint states without padding or a
// compensating negative margin, so disclosure and deferred-row geometry share one coordinate system.
const STABLE_MESSAGE_FLOW_CLASS = 'flow-root';

/**
 * Keep the message DOM available for anchors/search while letting Chromium skip
 * layout and paint for bubbles far outside the scroll viewport.
 */
interface MessageViewportBoundaryProps {
  children: ReactNode;
  messageId?: string;
  eager?: boolean;
  backgroundMountDelayMs?: number;
  /** Readonly message-owner signal; independent of whether the body is mounted. */
  navigationError?: boolean;
}

export function MessageViewportBoundary({
  children,
  messageId,
  eager = false,
  backgroundMountDelayMs,
  navigationError,
}: MessageViewportBoundaryProps) {
  const boundaryRef = useRef<HTMLDivElement>(null);
  const shellPresentation = useShellPresentation();
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
      data-message-navigation-error={navigationError || undefined}
      className={
        shellPresentation === 'v2'
          ? `${CONTENT_VISIBILITY_CLASS} ${FACE_OVERFLOW_CLASS} ${STABLE_MESSAGE_FLOW_CLASS}`
          : `${CLASSIC_CONTENT_VISIBILITY_CLASS} ${STABLE_MESSAGE_FLOW_CLASS}`
      }
      {...(!mounted && messageId ? { 'data-deferred-message-id': messageId } : {})}
      style={mounted ? OFFSCREEN_MESSAGE_STYLE : { ...OFFSCREEN_MESSAGE_STYLE, minHeight: '240px' }}
    >
      {mounted ? children : null}
    </div>
  );
}
