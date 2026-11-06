/**
 * Scroll geometry shared by the sidebar's virtual lists (the thread list and the
 * attention groups), F314 cluster 15: both lists must agree on where a row
 * sits and how much of the top is covered by a sticky header.
 */

/** Height assumed before the scroll container has a measured size. */
export const FALLBACK_VIEWPORT_HEIGHT_PX = 640;

/** Distance from the top of `container`'s content to `element`, summed through offset parents. */
export function offsetTopWithin(element: HTMLElement, container: HTMLElement): number {
  let top = 0;
  let current: HTMLElement | null = element;
  while (current && current !== container) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return top;
}

/** How much of the container's top edge a sticky header (`data-scroll-occluder`) currently covers. */
export function visibleTopInset(container: HTMLElement): number {
  const occluder = container.querySelector<HTMLElement>('[data-scroll-occluder="true"]');
  if (!occluder) return 0;
  const containerTop = container.getBoundingClientRect().top;
  const rect = occluder.getBoundingClientRect();
  return rect.top <= containerTop + 2 && rect.bottom > containerTop ? rect.bottom - containerTop : 0;
}

export function viewportHeight(container: HTMLElement): number {
  return container.clientHeight || FALLBACK_VIEWPORT_HEIGHT_PX;
}
