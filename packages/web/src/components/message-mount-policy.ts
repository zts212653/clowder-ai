export const EAGER_MESSAGE_TAIL_COUNT = 8;
const BACKGROUND_MOUNT_STAGGER_MS = 80;

export interface MessageMountPolicy {
  eager: boolean;
  backgroundMountDelayMs?: number;
}

/** Paint the current reading window and newest messages, then fill older DOM in gently. */
export function messageMountPolicy(index: number, total: number, readingAnchorIndex = -1): MessageMountPolicy {
  const distanceFromTail = total - 1 - index;
  const inReadingWindow =
    readingAnchorIndex >= 0 && index >= readingAnchorIndex - 1 && index < readingAnchorIndex + EAGER_MESSAGE_TAIL_COUNT;
  if (distanceFromTail < EAGER_MESSAGE_TAIL_COUNT || inReadingWindow) return { eager: true };
  return {
    eager: false,
    backgroundMountDelayMs: (distanceFromTail - EAGER_MESSAGE_TAIL_COUNT + 1) * BACKGROUND_MOUNT_STAGGER_MS,
  };
}
