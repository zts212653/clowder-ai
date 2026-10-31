import type { PageOperation } from '../PageActionLoop.js';

export interface CurrentControlElement {
  readonly tagName: string;
  readonly textContent: string | null;
  readonly parentElement: CurrentControlElement | null;
  readonly labels?: ArrayLike<{ textContent: string | null }> | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { left: number; right: number; top: number; bottom: number; width: number; height: number };
  matches(selector: string): boolean;
  contains(element: CurrentControlElement): boolean;
}
declare const document: {
  getElementById(id: string): { textContent: string | null } | null;
  elementFromPoint(x: number, y: number): CurrentControlElement | null;
};
declare const innerWidth: number;
declare const innerHeight: number;
declare function getComputedStyle(element: CurrentControlElement): {
  visibility: string;
  display: string;
  opacity: string;
  pointerEvents: string;
};

/** These helpers run only in the actor's isolated world and are repeated at the commit point. */
export function currentControlVisible(element: CurrentControlElement): boolean {
  const rect = element.getBoundingClientRect();
  if (getComputedStyle(element).pointerEvents === 'none') return false;
  let ancestor: CurrentControlElement | null = element;
  for (let depth = 0; ancestor && depth < 32; depth++, ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (
      style.visibility !== 'visible' ||
      style.display === 'none' ||
      Number(style.opacity) <= 0 ||
      ancestor.matches('[inert],[aria-hidden="true"]')
    )
      return false;
  }
  if (
    !(
      ancestor === null &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < innerWidth &&
      rect.top < innerHeight &&
      !element.matches(':disabled,[readonly],[aria-disabled="true"]')
    )
  )
    return false;
  // Match the pointer target at the visible center, including a control's own descendants.
  const hit = document.elementFromPoint(
    (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2,
    (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2,
  );
  return hit !== null && (hit === element || element.contains(hit));
}

export function currentControlOperation(element: CurrentControlElement): PageOperation | null {
  if (element.tagName === 'TEXTAREA') return 'fill';
  if (element.tagName === 'INPUT') {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (['text', 'search', 'url', 'tel', 'email', 'number'].includes(type)) return 'fill';
    return ['button', 'submit', 'reset'].includes(type) ? 'click' : null;
  }
  if (element.tagName === 'A' && !/^(?:https?:|\/|#|\.\/|\.\.\/)/iu.test(element.getAttribute('href') || ''))
    return null;
  return element.tagName === 'BUTTON' || element.tagName === 'A' || element.getAttribute('role') === 'button'
    ? 'click'
    : null;
}

export function currentControlLabel(element: CurrentControlElement): string {
  const aria = element.getAttribute('aria-label');
  if (aria) return aria.trim().slice(0, 512);
  const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/u).filter(Boolean).slice(0, 8);
  const referenced = labelledBy
    .map((id) => document.getElementById(id)?.textContent?.slice(0, 512) || '')
    .join(' ')
    .trim();
  if (referenced) return referenced.slice(0, 512);
  const label = element.labels?.[0]?.textContent;
  return (
    label ||
    element.getAttribute('placeholder') ||
    element.textContent?.slice(0, 512) ||
    element.getAttribute('name') ||
    ''
  )
    .trim()
    .slice(0, 512);
}

export function permittedCurrentControl(element: CurrentControlElement, operation: PageOperation): boolean {
  return (
    currentControlVisible(element) &&
    currentControlOperation(element) === operation &&
    !(operation === 'fill' && /password|cc-|one-time-code|username/iu.test(element.getAttribute('autocomplete') || ''))
  );
}
