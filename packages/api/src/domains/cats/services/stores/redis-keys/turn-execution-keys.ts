export const TurnExecutionKeys = {
  record: (invocationId: string) => `turnexec:record:${invocationId}`,
  parent: (parentInvocationId: string) => `turnexec:parent:${parentInvocationId}`,
  running: 'turnexec:running',
  /**
   * F117 KD-21: ended child turns whose response R is not yet confirmed terminal. The terminal
   * transition adds the child atomically; only a confirmed terminal R removes it.
   */
  responsePending: 'turnexec:response-pending',
  settledSequence: 'turnexec:settled:sequence',
  watcherDayPrefix: (userId: string) => `turnexec:watcher:day:${encodeURIComponent(userId)}:`,
  settledUser: (userId: string) => `turnexec:settled:user:${encodeURIComponent(userId)}`,
  settledThread: (userId: string, threadId: string) =>
    `turnexec:settled:thread:${encodeURIComponent(userId)}:${encodeURIComponent(threadId)}`,
} as const;
