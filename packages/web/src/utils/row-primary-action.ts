const INTERACTIVE_ROW_DESCENDANT = [
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tooltip"]',
].join(', ');

/**
 * Whether a pointer event came from ordinary row content.
 *
 * `closest()` may find an interactive ancestor outside the row, so the
 * descendant check is deliberately bounded by `row`.
 */
export function isRowPrimaryActionTarget(target: EventTarget | null, row: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest(INTERACTIVE_ROW_DESCENDANT);
  return interactive === null || !row.contains(interactive);
}
