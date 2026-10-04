export interface BallPosition {
  readonly x: number;
  readonly y: number;
}

export interface BallReservedRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface BallPositionConstraints {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly ballSize: number;
  readonly edgeMargin: number;
  readonly toolbarBelow: number;
  readonly reservedRects: readonly BallReservedRect[];
}

interface Candidate extends BallPosition {
  readonly preference: number;
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(value, upper));
}

function isFiniteRect(rect: BallReservedRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.right) &&
    Number.isFinite(rect.bottom) &&
    rect.right > rect.left &&
    rect.bottom > rect.top
  );
}

export function ballIntersectsReservedRect(position: BallPosition, ballSize: number, rect: BallReservedRect): boolean {
  return (
    position.x < rect.right &&
    position.x + ballSize > rect.left &&
    position.y < rect.bottom &&
    position.y + ballSize > rect.top
  );
}

/**
 * Resolve one Cat Ball position against the viewport and every Host reservation.
 * Distance wins; exact ties prefer moving left, then up.
 */
export function resolveBallPosition(candidate: BallPosition, constraints: BallPositionConstraints): BallPosition {
  const ballSize = Math.max(0, constraints.ballSize);
  const toolbarBelow = Math.max(0, constraints.toolbarBelow);
  const edgeMargin = Math.max(0, constraints.edgeMargin);
  const maxX = Math.max(0, constraints.viewport.width - ballSize);
  const maxY = Math.max(0, constraints.viewport.height - ballSize - toolbarBelow);
  const origin = {
    x: clamp(candidate.x, 0, maxX),
    y: clamp(candidate.y, 0, maxY),
  };
  const reservedRects = constraints.reservedRects.filter(isFiniteRect);
  const legal = (position: BallPosition) =>
    reservedRects.every((rect) => !ballIntersectsReservedRect(position, ballSize, rect));
  if (legal(origin)) return origin;

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (position: BallPosition, preference: number) => {
    const next = { x: clamp(position.x, 0, maxX), y: clamp(position.y, 0, maxY), preference };
    const key = `${next.x}:${next.y}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(next);
  };

  const xEdges = [origin.x, 0, maxX];
  const yEdges = [origin.y, 0, maxY];
  for (const rect of reservedRects) {
    const left = rect.left - ballSize - edgeMargin;
    const above = rect.top - ballSize - edgeMargin;
    const right = rect.right + edgeMargin;
    const below = rect.bottom + edgeMargin;
    add({ x: left, y: origin.y }, 1);
    add({ x: origin.x, y: above }, 2);
    add({ x: right, y: origin.y }, 3);
    add({ x: origin.x, y: below }, 4);
    xEdges.push(left, right);
    yEdges.push(above, below);
  }
  for (const x of xEdges) {
    for (const y of yEdges) add({ x, y }, 10);
  }

  const nearest = candidates.filter(legal).sort((a, b) => {
    const aDistance = (a.x - origin.x) ** 2 + (a.y - origin.y) ** 2;
    const bDistance = (b.x - origin.x) ** 2 + (b.y - origin.y) ** 2;
    return aDistance - bDistance || a.preference - b.preference || a.x - b.x || a.y - b.y;
  })[0];

  return nearest ? { x: nearest.x, y: nearest.y } : origin;
}
