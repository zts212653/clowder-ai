export const HandoffKeys = {
  detail: (id: string) => `handoff-proposal:${id}`,
  session: (sessionId: string) => `handoff-proposals:session:${sessionId}`,
  catThread: (userId: string, catId: string, threadId: string) =>
    `handoff-proposals:catthread:${userId}:${catId}:${threadId}`,
  user: (userId: string) => `handoff-proposals:user:${userId}`,
  settledUser: (userId: string) => `handoff-proposals:settled:${userId}`,
  dedup: (userId: string, clientRequestId: string) => `handoff-proposal-dedup:${userId}:${clientRequestId}`,
};
