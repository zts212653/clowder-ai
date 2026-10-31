import { useCallback, useEffect, useRef } from 'react';

/**
 * Guard against IME composition Enter triggering form submit.
 *
 * Chrome fires `compositionend` BEFORE the final `keydown(Enter)`,
 * so `e.nativeEvent.isComposing` is already false when the keydown
 * handler runs. We keep a ref that stays true for one extra frame
 * after compositionend to bridge the gap.
 *
 * Usage:
 *   const ime = useIMEGuard();
 *   <textarea
 *     onCompositionStart={ime.onCompositionStart}
 *     onCompositionEnd={ime.onCompositionEnd}
 *     onKeyDown={(e) => { if (ime.isComposing()) return; ... }}
 *   />
 */
export function useIMEGuard() {
  const composingRef = useRef(false);
  const rafRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onCompositionStart = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(() => {
    // Delay clearing by one frame + one timer turn. In browser Chrome the Enter
    // that confirms IME candidates can arrive immediately after compositionend;
    // in test/jsdom some environments flush rAF aggressively, so we keep the ref
    // alive until the next macrotask to avoid same-turn false negatives.
    rafRef.current = requestAnimationFrame(() => {
      timeoutRef.current = setTimeout(() => {
        composingRef.current = false;
        timeoutRef.current = null;
      }, 0);
    });
  }, []);

  const isComposing = useCallback(() => composingRef.current, []);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return { onCompositionStart, onCompositionEnd, isComposing } as const;
}
