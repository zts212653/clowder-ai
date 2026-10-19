import { type RefObject, useLayoutEffect } from 'react';

export function useTextareaAutosize(ref: RefObject<HTMLTextAreaElement>, input: string, placeholder?: string) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: React must commit the draft and displayed placeholder before measuring the DOM's scrollHeight.
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    const resize = () => {
      // Measuring the live textarea at `auto` temporarily grows the history viewport.
      // Chromium clamps its scrollTop immediately, even if the textarea grows back
      // before paint. Measure outside normal flow so typing cannot erase that offset.
      const measure = textarea.cloneNode() as HTMLTextAreaElement;
      measure.removeAttribute('id');
      measure.removeAttribute('name');
      measure.removeAttribute('data-testid');
      measure.tabIndex = -1;
      measure.setAttribute('aria-hidden', 'true');
      measure.value = textarea.value;
      Object.assign(measure.style, {
        position: 'fixed',
        visibility: 'hidden',
        pointerEvents: 'none',
        width: `${textarea.getBoundingClientRect().width}px`,
        height: '0',
        minHeight: '0',
        maxHeight: 'none',
        overflow: 'hidden',
      });
      textarea.parentElement?.append(measure);
      const isMobile = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches;
      const maxHeight = isMobile ? 120 : 200;
      // scrollHeight includes padding but excludes our border-box textarea's border.
      const borderHeight = textarea.offsetHeight - textarea.clientHeight;
      textarea.style.height = `${Math.min(measure.scrollHeight + borderHeight, maxHeight)}px`;
      measure.remove();
    };
    resize();
    window.addEventListener('resize', resize);

    // Pane/sidebar resizing can change wrapping without changing the window or draft.
    const parent = textarea.parentElement;
    let parentWidth = parent?.clientWidth;
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width;
            if (width === undefined || width === parentWidth) return;
            parentWidth = width;
            resize();
          })
        : null;
    if (parent) observer?.observe(parent);
    return () => {
      window.removeEventListener('resize', resize);
      observer?.disconnect();
    };
  }, [ref, input, placeholder]);
}
