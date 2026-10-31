'use client';

import { type RefObject, useEffect } from 'react';

/** Text fields match :focus-visible even after mouse clicks; track focus navigation for their one outer ring. */
export function useComposerKeyboardFocus(enabled: boolean, textareaRef: RefObject<HTMLTextAreaElement | null>): void {
  useEffect(() => {
    const textarea = textareaRef.current;
    const card = textarea?.closest<HTMLElement>('[data-testid="chat-input-composer-row"]');
    if (!enabled || !textarea || !card) return;
    // Programmatic / assistive focus stays visible unless a real pointer explicitly selected the field.
    let keyboard = true;
    const clear = () => card.removeAttribute('data-composer-keyboard-focus');
    const focus = () => {
      if (keyboard) card.setAttribute('data-composer-keyboard-focus', 'true');
      else clear();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') keyboard = true;
    };
    const onPointer = () => {
      keyboard = false;
      clear();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    textarea.addEventListener('focus', focus);
    textarea.addEventListener('blur', clear);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      textarea.removeEventListener('focus', focus);
      textarea.removeEventListener('blur', clear);
      clear();
    };
  }, [enabled, textareaRef]);
}
