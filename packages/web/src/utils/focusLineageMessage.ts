import { scrollToMessage } from './scrollToMessage';

/** Focus one exact lineage endpoint with the same temporary visual anchor. */
export function focusLineageMessage(messageId: string): boolean {
  if (typeof document === 'undefined') return false;
  const focus = (attempt: number): boolean => {
    if (scrollToMessage(messageId)) return true;
    if (attempt < 8) window.requestAnimationFrame(() => focus(attempt + 1));
    return false;
  };
  return focus(0);
}
