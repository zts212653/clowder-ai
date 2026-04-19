/**
 * Redis key patterns for achievement system — F160 Phase C.
 * Key: achievement:unlocked:{memberId} → sorted set (score = timestamp, member = JSON)
 * Key: achievement:counters:{memberId} → hash of event counters (tasks, reviews, sessions)
 */

/** Sorted set of unlocked achievements. Score = unlock timestamp. */
export function achievementUnlockedKey(memberId: string): string {
  return `achievement:unlocked:${memberId}`;
}

/** Hash of event counters for auto-trigger checks. */
export function achievementCountersKey(memberId: string): string {
  return `achievement:counters:${memberId}`;
}
