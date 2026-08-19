export interface MessageTimelinePoint {
  type?: string;
  catId?: string | null;
  origin?: string;
  timestamp: number;
  deliveredAt?: number;
  timelineOrderAt?: number;
}

/** Match the API timeline score, including legacy rows without an explicit marker. */
export function getMessageTimelineOrderTime(message: MessageTimelinePoint): number {
  return message.timelineOrderAt ?? message.deliveredAt ?? message.timestamp;
}
