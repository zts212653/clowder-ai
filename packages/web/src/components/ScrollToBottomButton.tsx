'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';

const CHAT_LAYOUT_CHANGED_EVENT = 'catcafe:chat-layout-changed';

function isAtBottom(el: HTMLElement, thresholdPx: number): boolean {
  const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
  return distance <= thresholdPx;
}

export function ScrollToBottomButton({
  scrollContainerRef,
  messagesEndRef,
  thresholdPx = 120,
  recomputeSignal,
}: {
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  messagesEndRef: React.RefObject<HTMLElement | null>;
  thresholdPx?: number;
  /** Changes when thread/messages change, to recompute visibility without scroll/resize events. */
  recomputeSignal?: unknown;
  /** Changes when the scroll container / end sentinel is replaced (e.g. thread switch). */
  observerKey?: unknown;
}) {
  const [visible, setVisible] = useState(false);

  const update = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setVisible(!isAtBottom(el, thresholdPx));
  }, [scrollContainerRef, thresholdPx]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [scrollContainerRef, update]);

  // Cloud P2: media-driven layout shifts (e.g. image load) can move the end sentinel
  // without scroll/resize or message updates. IntersectionObserver fires on such shifts.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const scrollEl = scrollContainerRef.current;
    const endEl = messagesEndRef.current;
    if (!scrollEl || !endEl) return;
    if (typeof window.IntersectionObserver !== 'function') return;

    const observer = new window.IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        // When the end sentinel is not intersecting the viewport (+threshold margin),
        // the user is no longer near bottom → show the button.
        setVisible(!entry.isIntersecting);
      },
      {
        root: scrollEl,
        threshold: 0,
        rootMargin: `0px 0px ${thresholdPx}px 0px`,
      },
    );

    observer.observe(endEl);
    return () => observer.disconnect();
  }, [scrollContainerRef, messagesEndRef, thresholdPx]);

  // Cloud P2: local UI toggles can change scrollHeight without scroll/resize events.
  useEffect(() => {
    const handler = () => update();
    window.addEventListener(CHAT_LAYOUT_CHANGED_EVENT, handler);
    return () => window.removeEventListener(CHAT_LAYOUT_CHANGED_EVENT, handler);
  }, [update]);

  // Cloud P2: thread switch / message replacement can change scrollTop/scrollHeight without
  // firing scroll events; recompute when callers signal content changes.
  useEffect(() => {
    update();
  }, [update, recomputeSignal]);

  const handleClick = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messagesEndRef]);

  const classes = useMemo(
    () =>
      'absolute bottom-3 right-8 z-20 ' +
      'rounded-full border border-cafe bg-cafe-surface/90 shadow-sm ' +
      'px-3 py-1.5 text-xs text-cafe-secondary ' +
      'hover:bg-cafe-surface hover:border-cafe transition-colors',
    [],
  );

  if (!visible) return null;

  return (
    <button type="button" aria-label="到最新" className={classes} onClick={handleClick} title="跳到对话底部">
      ↓ 到最新
    </button>
  );
}
