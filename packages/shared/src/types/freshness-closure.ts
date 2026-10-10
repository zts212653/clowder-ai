/**
 * Exact-boundary annotation written on an answer row by the same atomic operation that
 * appends it. `priorFrontierMessageId` is the thread frontier observed at append time;
 * the timeline projection uses it to place the bubble relative to what preceded it.
 *
 * It used to carry a scan verdict too (`fresh` / `freshness_unknown`). Nothing ever
 * branched on that verdict, so #1398 retired the scan and kept the only fact with a reader.
 */
export interface PublishedFreshnessAnnotation {
  priorFrontierMessageId: string | null;
}

/** An answer turn's output is durable at `messageId`. */
export interface OutputCommitDecision {
  messageId: string;
  turnInvocationId: string;
}
