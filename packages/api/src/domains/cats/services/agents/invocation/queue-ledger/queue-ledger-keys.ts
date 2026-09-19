function threadTag(threadId: string): string {
  if (!threadId) throw new Error('queue ledger thread id is required');
  return encodeURIComponent(threadId);
}

export const QueueLedgerKeys = {
  entries: (threadId: string) => `queue:{${threadTag(threadId)}}:entries`,
  order: (threadId: string) => `queue:{${threadTag(threadId)}}:order`,
  messageIndex: (threadId: string) => `queue:{${threadTag(threadId)}}:messages`,
  schema: (threadId: string) => `queue:{${threadTag(threadId)}}:schema`,
} as const;
