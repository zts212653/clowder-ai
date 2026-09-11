import { revealFoldedSourceAnchor } from './folded-source-navigation';
import { resolveMessageElements } from './scrollToMessage';

/** Focus one exact lineage endpoint with the same temporary visual anchor. */
export function focusLineageMessage(messageId: string): boolean {
  if (typeof document === 'undefined') return false;
  const node = resolveMessageElements([messageId])[0];
  if (!node) return false;

  revealFoldedSourceAnchor(node);
  const enclosingDetails = node.closest('details');
  if (enclosingDetails) enclosingDetails.open = true;
  node.dataset.lineageFocus = 'true';
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => delete node.dataset.lineageFocus, 3200);
  return true;
}
