export interface MessageSearchToolQuery {
  query: string;
  messageSort?: 'time' | 'relevance';
  scope?: string;
  mode?: string;
  threadId?: string;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  dimension?: string;
  intent?: 'topk' | 'coverage';
}
/** Shared transport for the one message search; publication never implements retrieval. */
export function messageSearchParams(input: MessageSearchToolQuery): Record<string, string> {
  const params: Record<string, string> = {
    q: input.query,
    resultUnit: 'message',
    scope: input.scope ?? 'threads',
    messageSort: input.messageSort ?? 'time',
    mode: input.mode ?? 'hybrid',
  };
  if (input.threadId) params.threadId = input.threadId;
  if (input.limit !== undefined) params.limit = String(input.limit);
  if (input.dateFrom) params.dateFrom = input.dateFrom;
  if (input.dateTo) params.dateTo = input.dateTo;
  if (input.dimension) params.dimension = input.dimension;
  if (input.intent) params.intent = input.intent;
  return params;
}
