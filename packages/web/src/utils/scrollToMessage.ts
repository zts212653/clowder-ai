/**
 * Scroll to a message by ID with smooth animation and temporary highlight.
 */
export function scrollToMessage(messageId: string): void {
  const escaped = CSS.escape(messageId);
  const el = document.querySelector(`[data-message-id="${escaped}"]`);
  if (!el) return;

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Temporary blue ring highlight
  el.classList.add('ring-2', 'ring-conn-blue-ring', 'transition-all');
  setTimeout(() => {
    el.classList.remove('ring-2', 'ring-conn-blue-ring');
  }, 1500);
}
