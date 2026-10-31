export function ownerAllowsActions(owner: HTMLElement) {
  return !owner.closest('[aria-hidden="true"], [inert], [hidden]') && getComputedStyle(owner).visibility !== 'hidden';
}

/** The same live reading clip is used during invalidation and the settled geometry pass. */
export function readActionPort(port: HTMLElement | null) {
  const rect = port?.getBoundingClientRect();
  return {
    top: Math.max(0, (rect?.top ?? 0) + (port?.clientTop ?? 0)),
    bottom: Math.min(
      window.innerHeight,
      rect ? rect.top + (port?.clientTop ?? 0) + (port?.clientHeight || rect.height) : window.innerHeight,
    ),
    left: Math.max(0, (rect?.left ?? 0) + (port?.clientLeft ?? 0)),
    right: Math.min(
      window.innerWidth,
      rect ? rect.left + (port?.clientLeft ?? 0) + (port?.clientWidth || rect.width) : window.innerWidth,
    ),
  };
}

export function messageIsReadable(row: HTMLElement, port: ReturnType<typeof readActionPort>) {
  const bounds = row.getBoundingClientRect();
  return (
    ownerAllowsActions(row) &&
    bounds.bottom > port.top &&
    bounds.top < port.bottom &&
    bounds.right > port.left &&
    bounds.left < port.right
  );
}

function fitsAfterAnchor(slot: DOMRect, bounds: DOMRect, width: number, isUser: boolean) {
  return isUser ? slot.left - width >= bounds.left : slot.right + width <= bounds.right;
}

export function planePosition(slot: DOMRect, bounds: DOMRect, control: DOMRect, isUser: boolean) {
  const preferred = isUser ? slot.left - control.width : slot.right;
  return {
    left: Math.max(bounds.left, Math.min(preferred, bounds.right - control.width)),
    top: slot.top - control.height / 2,
  };
}

function coversFact(
  position: { left: number; top: number },
  size: { width: number; height: number },
  facts: DOMRect[],
) {
  return facts.some(
    (fact) =>
      fact.width > 0 &&
      fact.height > 0 &&
      position.left < fact.right &&
      position.left + size.width > fact.left &&
      position.top < fact.bottom &&
      position.top + size.height > fact.top,
  );
}

export function authorFacts(anchor: HTMLElement) {
  return [...(anchor.parentElement?.children ?? [])]
    .filter((child) => child !== anchor)
    .map((child) => child.getBoundingClientRect());
}

export function needsCompactControl(
  slot: DOMRect,
  bounds: DOMRect,
  size: { width: number; height: number },
  facts: DOMRect[],
  isUser: boolean,
  mediaMatches: boolean,
) {
  if (mediaMatches || !fitsAfterAnchor(slot, bounds, size.width, isUser)) return true;
  const preferred = { left: isUser ? slot.left - size.width : slot.right, top: slot.top - size.height / 2 };
  return coversFact(preferred, size, facts);
}

/** The portal inherits the history's paint clip, including after author-fact avoidance. */
export function boundedActionPosition(
  slot: DOMRect,
  column: DOMRect,
  control: DOMRect,
  port: { top: number; bottom: number; left: number; right: number },
  facts: DOMRect[],
  isUser: boolean,
  compact: boolean,
) {
  const left = Math.max(column.left, port.left);
  const right = Math.min(column.right, port.right);
  const preferred = planePosition(
    slot,
    new DOMRect(left, port.top, Math.max(0, right - left), port.bottom - port.top),
    control,
    isUser,
  );
  const occupied = facts.filter((fact) => fact.height > 0);
  const tops =
    compact && occupied.length
      ? [
          preferred.top,
          Math.min(...occupied.map((fact) => fact.top)) - control.height - 4,
          Math.max(...occupied.map((fact) => fact.bottom)) + 4,
        ]
      : [preferred.top];
  const positions = tops.map((top) => ({
    left: preferred.left,
    top: Math.max(port.top, Math.min(top, port.bottom - control.height)),
  }));
  const position = positions.find((candidate) => !coversFact(candidate, control, facts));
  return {
    ...(position ?? positions[0]),
    available:
      Boolean(position) &&
      slot.top >= port.top &&
      slot.top <= port.bottom &&
      control.height <= port.bottom - port.top &&
      control.width <= right - left,
  };
}
