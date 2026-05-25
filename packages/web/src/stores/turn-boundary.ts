type TurnBoundaryPoint = {
  type?: string;
  timestamp?: number;
  deliveredAt?: number;
};

function getTurnBoundaryTimestamp(point: TurnBoundaryPoint): number | undefined {
  const timestamp = point.deliveredAt ?? point.timestamp;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * Legacy Antigravity payloads can reuse the parent invocation id across
 * multiple same-cat turns. A user message between two assistant records is the
 * hard boundary that keeps those turns from being reconciled as one bubble.
 */
export function crossesUserTurnBoundary(
  messages: TurnBoundaryPoint[],
  left: TurnBoundaryPoint,
  right: TurnBoundaryPoint,
): boolean {
  const leftTs = getTurnBoundaryTimestamp(left);
  const rightTs = getTurnBoundaryTimestamp(right);
  if (leftTs === undefined || rightTs === undefined || leftTs === rightTs) return false;

  const earlier = Math.min(leftTs, rightTs);
  const later = Math.max(leftTs, rightTs);
  return messages.some((message) => {
    if (message.type !== 'user') return false;
    const ts = getTurnBoundaryTimestamp(message);
    return ts !== undefined && ts > earlier && ts <= later;
  });
}
