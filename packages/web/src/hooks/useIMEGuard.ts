import { useCallback, useRef } from 'react';

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

  const onCompositionStart = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(() => {
    // Delay clearing by one frame so the subsequent keydown(Enter)
    // in Chrome still sees composingRef === true.
    rafRef.current = requestAnimationFrame(() => {
      composingRef.current = false;
    });
  }, []);

  const isComposing = useCallback(() => composingRef.current, []);

  return { onCompositionStart, onCompositionEnd, isComposing } as const;
}
