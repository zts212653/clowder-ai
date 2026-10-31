function threadTag(threadId: string): string {
  if (!threadId) throw new Error('queue ledger thread id is required');
  return encodeURIComponent(threadId);
}

export const QueueLedgerKeys = {
  entries: (threadId: string) => `queue:{${threadTag(threadId)}}:entries`,
  order: (threadId: string) => `queue:{${threadTag(threadId)}}:order`,
  messageIndex: (threadId: string) => `queue:{${threadTag(threadId)}}:messages`,
  schema: (threadId: string) => `queue:{${threadTag(threadId)}}:schema`,
  /**
   * Durable admission receipts for `private_input`. A public input's winner is its History
   * message, which outlives the Queue row; a private input has no History member, so the
   * receipt is the only thing that can survive the row's retirement at the processing boundary.
   */
  privateAdmissions: (threadId: string) => `queue:{${threadTag(threadId)}}:private-admissions`,
} as const;
