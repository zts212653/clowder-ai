/**
 * Scroll to a message by ID with smooth animation and temporary highlight.
 * Returns true when the target element was found (so callers can retry on a
 * raf loop until the message DOM has rendered after a thread switch).
 */
export function scrollToMessage(messageId: string): boolean {
  const escaped = CSS.escape(messageId);
  const el = document.querySelector(`[data-message-id="${escaped}"]`);
  if (!el) return false;

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Temporary blue ring highlight
  el.classList.add('ring-2', 'ring-blue-400', 'transition-all');
  setTimeout(() => {
    el.classList.remove('ring-2', 'ring-blue-400');
  }, 1500);
  return true;
}
