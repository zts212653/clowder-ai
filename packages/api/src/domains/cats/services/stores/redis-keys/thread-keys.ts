/**
 * Redis key patterns for thread storage (预留 for Redis ThreadStore).
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const ThreadKeys = {
  /** Hash with thread details: thread:{threadId} */
  detail: (id: string) => `thread:${id}`,

  /** Set of participants: thread:{threadId}:participants */
  participants: (id: string) => `thread:${id}:participants`,

  /** Per-user thread list sorted set: threads:user:{userId} */
  userList: (userId: string) => `threads:user:${userId}`,

  /** F032 Phase C: Hash with participant activity: thread:{threadId}:activity
   *  Fields: {catId}:lastMessageAt, {catId}:messageCount
   */
  activity: (id: string) => `thread:${id}:activity`,

  /** F046 D3: One-shot suppressed mention routing feedback per cat. */
  mentionRoutingFeedback: (id: string) => `thread:${id}:mention-routing-feedback`,

  /** F128: Sorted set of child thread IDs: thread:{parentId}:children */
  children: (parentId: string) => `thread:${parentId}:children`,
} as const;
