type Rect = { left: number; right: number; top: number; bottom: number };

/** Keep the popup inside its Workspace width and the viewport's vertical space. */
export function workspaceMenuPosition(
  anchor: Rect,
  boundary: Rect,
  viewport: { width: number; height: number },
  width: number,
  height: number,
) {
  const margin = 8;
  const leftEdge = Math.max(margin, Math.min(boundary.left, viewport.width - margin - 1));
  const rightEdge = Math.max(leftEdge + 1, Math.min(boundary.right, viewport.width - margin));
  const panelWidth = Math.min(width, rightEdge - leftEdge);
  const below = Math.max(1, viewport.height - margin - anchor.bottom - 4);
  const above = Math.max(1, anchor.top - margin - 4);
  const opensBelow = height <= below || below >= above;
  const maxHeight = opensBelow ? below : above;
  const panelHeight = Math.min(height, maxHeight);
  return {
    position: 'fixed' as const,
    left: Math.max(leftEdge, Math.min(anchor.right - panelWidth, rightEdge - panelWidth)),
    top: Math.max(
      margin,
      Math.min(opensBelow ? anchor.bottom + 4 : anchor.top - panelHeight - 4, viewport.height - margin - panelHeight),
    ),
    width: panelWidth,
    maxHeight,
  };
}
