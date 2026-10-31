/** A keyset in the producer's canonical terminal index, descending by time and UTF-8 id. */
export interface SettledHistoryPosition {
  decidedAt: number;
  /** null includes all members at decidedAt; the empty string excludes that entire timestamp. */
  proposalId: string | null;
}

export interface SettledHistoryPageOptions {
  limit: number;
  before?: SettledHistoryPosition;
}

export interface SettledHistorySourcePage<T> {
  records: T[];
  /** Last physical index entry inspected, including deleted, invisible or filtered entries. */
  frontier: SettledHistoryPosition | null;
  hasMore: boolean;
}

export function assertSettledHistoryPageOptions(options: SettledHistoryPageOptions): void {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 61)
    throw new RangeError('invalid settled page limit');
  if (
    options.before &&
    (!Number.isSafeInteger(options.before.decidedAt) ||
      options.before.decidedAt < 0 ||
      (options.before.proposalId !== null &&
        (typeof options.before.proposalId !== 'string' || options.before.proposalId.length > 512)))
  )
    throw new RangeError('invalid settled page position');
}

export function compareHistoryPosition(left: SettledHistoryPosition, right: SettledHistoryPosition): number {
  return (
    right.decidedAt - left.decidedAt ||
    Buffer.compare(Buffer.from(right.proposalId ?? ''), Buffer.from(left.proposalId ?? ''))
  );
}

/** A stale derived order cannot safely be paged as if it were the canonical decision time. */
export function requireHistoryIndexTime(indexTime: number, canonicalTime: number): void {
  if (indexTime !== canonicalTime)
    throw Object.assign(new Error('Settled history index requires canonical time preparation'), {
      statusCode: 503,
      code: 'APPROVAL_HISTORY_PREPARING',
    });
}
