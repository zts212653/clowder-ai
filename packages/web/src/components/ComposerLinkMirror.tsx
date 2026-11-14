'use client';

import { type RefObject, useLayoutEffect, useRef } from 'react';
import styles from './composer-link-mirror.module.css';
import type { composerWebLinks } from './composer-web-links';

/** Paints the draft while the textarea keeps its value, caret, selection and editing history. */
export function ComposerLinkMirror({
  input,
  textareaRef,
  textareaReady,
  composing,
  links,
}: {
  input: string;
  textareaRef: RefObject<HTMLTextAreaElement>;
  textareaReady: boolean;
  composing: boolean;
  links: ReturnType<typeof composerWebLinks>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { ranges, unmapped } = links;
  const active = ranges.length > 0 && !composing;

  // biome-ignore lint/correctness/useExhaustiveDependencies: The later textarea sibling attaches after our first layout effect; retry before paint once ready, and after every draft change.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!textarea || !viewport || !content) return;
    const sync = () => {
      const computed = getComputedStyle(textarea);
      Object.assign(viewport.style, {
        left: `${textarea.offsetLeft + Number.parseFloat(computed.borderLeftWidth || '0')}px`,
        top: `${textarea.offsetTop + Number.parseFloat(computed.borderTopWidth || '0')}px`,
        width: `${textarea.clientWidth}px`,
        height: `${textarea.clientHeight}px`,
      });
      for (const property of [
        'font',
        'line-height',
        'letter-spacing',
        'word-spacing',
        'tab-size',
        'text-align',
        'text-indent',
        'padding',
        'white-space',
        'overflow-wrap',
        'word-break',
        'direction',
      ])
        content.style.setProperty(property, computed.getPropertyValue(property));
      viewport.scrollTop = textarea.scrollTop;
      viewport.scrollLeft = textarea.scrollLeft;
    };
    sync();
    textarea.addEventListener('scroll', sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(textarea);
    return () => {
      textarea.removeEventListener('scroll', sync);
      observer.disconnect();
    };
  }, [textareaRef, textareaReady, input]);

  let end = 0;
  const spans = ranges.flatMap((range) => {
    const before = input.slice(end, range.start);
    end = range.end;
    return [
      before,
      <mark
        key={range.start}
        className={styles.range}
        data-link-start={range.start}
        data-link-end={range.end}
        data-link-href={range.href}
      >
        {input.slice(range.start, range.end)}
      </mark>,
    ];
  });

  return (
    <div
      ref={viewportRef}
      className={styles.viewport}
      aria-hidden="true"
      data-testid="composer-link-mirror"
      data-unmapped={unmapped}
      data-active={active}
      style={{ visibility: active ? undefined : 'hidden' }}
    >
      <div ref={contentRef} className={styles.content}>
        {spans}
        {input.slice(end)}
        {input.endsWith('\n') ? '\u200b' : null}
      </div>
    </div>
  );
}
