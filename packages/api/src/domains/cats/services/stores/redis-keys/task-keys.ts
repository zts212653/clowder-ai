/**
 * Redis key patterns for task storage.
 * All keys share the cat-cafe: prefix set by the Redis client.
 *
 * #320: Added kind and subject indexes for unified task model.
 */

export const TaskKeys = {
  /** Hash with task details: task:{taskId} */
  detail: (id: string) => `task:${id}`,

  /** Per-thread task list sorted set: tasks:thread:{threadId} */
  thread: (threadId: string) => `tasks:thread:${threadId}`,

  /** Per-kind task list sorted set: tasks:kind:{kind} (#320) */
  kind: (kind: string) => `tasks:kind:${kind}`,

  /** Subject → taskId unique mapping: tasks:subject:{subjectKey} (#320) */
  subject: (subjectKey: string) => `tasks:subject:${subjectKey}`,
} as const;
