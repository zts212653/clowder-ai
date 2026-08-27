import { getMessageTimelineOrderTime } from './message-timeline';

type TurnBoundaryPoint = {
  type?: string;
  timestamp?: number;
  deliveredAt?: number;
  timelineOrderAt?: number;
  extra?: {
    stream?: {
      turnInvocationId?: string;
    };
  };
};

function getTurnBoundaryTimestamp(point: TurnBoundaryPoint): number | undefined {
  if (typeof point.timestamp !== 'number') return undefined;
  const timestamp = getMessageTimelineOrderTime({ ...point, timestamp: point.timestamp });
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * Exact per-turn identity is authoritative even when a user supplement lands
 * between two carriers of the same active turn. Without that identity, legacy
 * payloads can reuse the parent invocation id across multiple same-cat turns;
 * a user message then remains the hard reconciliation boundary.
 */
export function crossesUserTurnBoundary(
  messages: TurnBoundaryPoint[],
  left: TurnBoundaryPoint,
  right: TurnBoundaryPoint,
): boolean {
  const leftTurnInvocationId = left.extra?.stream?.turnInvocationId;
  const rightTurnInvocationId = right.extra?.stream?.turnInvocationId;
  if (leftTurnInvocationId && leftTurnInvocationId === rightTurnInvocationId) return false;

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
