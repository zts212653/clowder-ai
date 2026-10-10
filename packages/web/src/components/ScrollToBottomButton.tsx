'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const CHAT_LAYOUT_CHANGED_EVENT = 'catcafe:chat-layout-changed';

function isAtBottom(el: HTMLElement, thresholdPx: number): boolean {
  const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
  return distance <= thresholdPx;
}

export function ScrollToBottomButton({
  scrollContainerRef,
  messagesEndRef,
  onJumpToLatest,
  thresholdPx = 120,
  recomputeSignal,
}: {
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  messagesEndRef: React.RefObject<HTMLElement | null>;
  onJumpToLatest: () => void;
  thresholdPx?: number;
  /** Changes when thread/messages change, to recompute visibility without scroll/resize events. */
  recomputeSignal?: unknown;
  /** Changes when the scroll container / end sentinel is replaced (e.g. thread switch). */
  observerKey?: unknown;
}) {
  const [visible, setVisible] = useState(false);
  // The visibility last handed to React. While a reply streams, `recomputeSignal` changes on nearly every commit; a
  // same-value setState from an effect is still a scheduled update while this component has work pending, and a
  // long chain of those trips React's nested-update limit (F117 baseline B). Only a real change goes to React.
  const visibleRef = useRef(false);
  const applyVisible = useCallback((next: boolean) => {
    if (visibleRef.current === next) return;
    visibleRef.current = next;
    setVisible(next);
  }, []);

  const update = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    applyVisible(!isAtBottom(el, thresholdPx));
  }, [applyVisible, scrollContainerRef, thresholdPx]);

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
        applyVisible(!entry.isIntersecting);
      },
      {
        root: scrollEl,
        threshold: 0,
        rootMargin: `0px 0px ${thresholdPx}px 0px`,
      },
    );

    observer.observe(endEl);
    return () => observer.disconnect();
  }, [applyVisible, scrollContainerRef, messagesEndRef, thresholdPx]);

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
    onJumpToLatest();
  }, [onJumpToLatest]);

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
