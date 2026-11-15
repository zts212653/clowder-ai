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
  /** F337: non-watcher turns of one member in one thread, scored by startedAt (written at create). */
  memberStarted: (userId: string, threadId: string, catId: string) =>
    `turnexec:member-started:${encodeURIComponent(userId)}:${encodeURIComponent(threadId)}:${encodeURIComponent(catId)}`,
  /** F337: failed host_sleep turns whose continuation is still owed (written at terminal). */
  sleepContinuationOwed: 'turnexec:sleep-continuation-owed',
} as const;
