type Bounds = { top: number; right: number; bottom: number; left: number };

/** A body portal still belongs to the original text's visible, clipped chat viewport. */
function sourceViewport(root: HTMLElement): Bounds | null {
  const bounds = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let node: HTMLElement | null = root; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      node.hidden ||
      node.hasAttribute('inert') ||
      node.getAttribute('aria-hidden') === 'true' ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    )
      return null;
    const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow);
    const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow);
    if (!clipsX && !clipsY) continue;
    const rect = node.getBoundingClientRect();
    if (clipsX) {
      bounds.left = Math.max(bounds.left, rect.left);
      bounds.right = Math.min(bounds.right, rect.right);
    }
    if (clipsY) {
      bounds.top = Math.max(bounds.top, rect.top);
      bounds.bottom = Math.min(bounds.bottom, rect.bottom);
    }
  }
  return bounds.right - bounds.left >= 28 && bounds.bottom - bounds.top >= 28 ? bounds : null;
}

function originalTextIsOnTop(root: HTMLElement, visible: Bounds): boolean {
  if (typeof document.elementsFromPoint !== 'function') return true;
  const y = (visible.top + visible.bottom) / 2;
  return [visible.left + 1, (visible.left + visible.right) / 2, visible.right - 1].some((x) => {
    const painted = document
      .elementsFromPoint(x, y)
      .find((element) => !element.closest('[data-context-annotation-ui]'));
    return painted !== undefined && root.contains(painted);
  });
}

export function visibleAnnotationPosition(root: HTMLElement, range: Range): { top: number; left: number } | null {
  const viewport = sourceViewport(root);
  if (!viewport) return null;
  const rect = range.getBoundingClientRect();
  const visible = {
    top: Math.max(viewport.top, rect.top),
    left: Math.max(viewport.left, rect.left),
    right: Math.min(viewport.right, rect.right),
    bottom: Math.min(viewport.bottom, rect.bottom),
  };
  if (visible.right <= visible.left || visible.bottom <= visible.top || !originalTextIsOnTop(root, visible))
    return null;
  return {
    top: Math.round(Math.max(viewport.top + 4, Math.min(visible.top - 8, viewport.bottom - 32))),
    left: Math.round(Math.max(viewport.left + 4, Math.min(visible.right + 8, viewport.right - 32))),
  };
}
