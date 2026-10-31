import type { ActionPlaneContext } from './message-actions-overlay-scheduler';

/** Coordinates and their measurement witness are written before any surface becomes reachable. */
export function positionActionPlane(
  node: HTMLElement,
  context: ActionPlaneContext,
  slot: DOMRect,
  position: { left: number; top: number },
) {
  node.style.left = `${position.left}px`;
  node.style.top = `${position.top}px`;
  Object.assign(node.dataset, {
    messageActionsViewport: String(window.innerWidth),
    messageActionsColumnWidth: String(context.column.width),
    messageActionsColumnLeft: String(context.column.left),
    messageActionsColumnRight: String(context.column.right),
    messageActionsAnchorTop: String(slot.top),
    messageActionsAnchorLeft: String(slot.left),
    messageActionsPortTop: String(context.port.top),
    messageActionsPortBottom: String(context.port.bottom),
    messageActionsPortLeft: String(context.port.left),
    messageActionsPortRight: String(context.port.right),
  });
}

export function settleActionPlane(node: HTMLElement, epoch: number, available: boolean) {
  node.toggleAttribute('inert', !available);
  node.setAttribute('aria-hidden', String(!available));
  node.style.visibility = available ? 'visible' : 'hidden';
  node.dataset.messageActionsReady = 'true';
  node.dataset.messageActionsCommittedEpoch = String(epoch);
}

export function settleActionMenu(
  node: HTMLElement | null,
  position: { left: number; top: number; available: boolean } | null,
  onUnavailable: () => void,
) {
  if (!node || !position) return;
  node.style.left = `${position.left}px`;
  node.style.top = `${position.top}px`;
  // A visible child must not escape its plane's pending visibility.
  node.style.visibility = position.available ? 'inherit' : 'hidden';
  if (!position.available) onUnavailable();
}
