import { revealFoldedSourceAnchor } from './folded-source-navigation';
import { markMessageJumpTarget, resolveMessageElements } from './scrollToMessage';

/** Focus one exact lineage endpoint with the same temporary visual anchor. */
export function focusLineageMessage(messageId: string): boolean {
  if (typeof document === 'undefined') return false;
  const focus = (attempt: number): boolean => {
    const node = resolveMessageElements([messageId])[0];
    if (!node) {
      if (attempt < 8) window.requestAnimationFrame(() => focus(attempt + 1));
      return false;
    }

    revealFoldedSourceAnchor(node);
    const enclosingDetails = node.closest('details');
    if (enclosingDetails) enclosingDetails.open = true;
    markMessageJumpTarget(node);
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  };
  return focus(0);
}
