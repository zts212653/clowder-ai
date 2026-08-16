export const EAGER_MESSAGE_TAIL_COUNT = 8;
const BACKGROUND_MOUNT_STAGGER_MS = 80;

export interface MessageMountPolicy {
  eager: boolean;
  backgroundMountDelayMs?: number;
}

/** Prioritize the newest conversation surface, then fill older DOM in gently. */
export function messageMountPolicy(index: number, total: number): MessageMountPolicy {
  const distanceFromTail = total - 1 - index;
  if (distanceFromTail < EAGER_MESSAGE_TAIL_COUNT) return { eager: true };
  return {
    eager: false,
    backgroundMountDelayMs: (distanceFromTail - EAGER_MESSAGE_TAIL_COUNT + 1) * BACKGROUND_MOUNT_STAGGER_MS,
  };
}
