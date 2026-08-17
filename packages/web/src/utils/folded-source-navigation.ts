const concealTimers = new WeakMap<HTMLElement, number>();

/**
 * A folded source keeps a zero-height DOM anchor so deep links and search hits
 * remain stable without creating a second visible message surface. Reveal only
 * the content-free return affordance after a navigation action actually lands.
 */
export function revealFoldedSourceAnchor(node: Element): boolean {
  if (!(node instanceof HTMLElement) || !node.dataset.foldedSourceAnchor) return false;
  const affordance = node.querySelector<HTMLElement>('[data-folded-source-affordance]');
  if (!affordance) return false;

  const previousTimer = concealTimers.get(node);
  if (previousTimer !== undefined) window.clearTimeout(previousTimer);

  node.setAttribute('aria-hidden', 'false');
  node.dataset.foldedSourceVisible = 'true';
  node.classList.remove('h-0', 'overflow-hidden');
  affordance.hidden = false;

  const timer = window.setTimeout(() => {
    affordance.hidden = true;
    node.setAttribute('aria-hidden', 'true');
    delete node.dataset.foldedSourceVisible;
    node.classList.add('h-0', 'overflow-hidden');
    concealTimers.delete(node);
  }, 3200);
  concealTimers.set(node, timer);
  return true;
}
