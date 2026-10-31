/** Expanded paint has its own measured extent; it cannot borrow the toolbar's height. */
export function boundedMenuPosition(
  anchor: DOMRect,
  menu: DOMRect,
  column: DOMRect,
  port: { top: number; bottom: number; left: number; right: number },
  isUser: boolean,
) {
  const left = Math.max(column.left, port.left),
    right = Math.min(column.right, port.right);
  const x = Math.max(left, Math.min(isUser ? anchor.right - menu.width : anchor.left, right - menu.width));
  const below = anchor.bottom + 4,
    above = anchor.top - menu.height - 4;
  const y = below + menu.height <= port.bottom ? below : above;
  return { left: x, top: y, available: menu.width <= right - left && y >= port.top && y + menu.height <= port.bottom };
}
