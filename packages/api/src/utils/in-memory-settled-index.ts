import {
  assertSettledHistoryPageOptions,
  compareHistoryPosition,
  type SettledHistoryPageOptions,
  type SettledHistoryPosition,
  type SettledHistorySourcePage,
} from './settled-history-page.js';

type Entry = SettledHistoryPosition & { proposalId: string };

/** Derived keys only, scoped to one canonical in-memory store. Pages never iterate the store's entire Map. */
export class InMemorySettledIndex {
  private readonly owners = new Map<string, Entry[]>();
  private readonly members = new Map<string, { owner: string; entry: Entry }>();

  update(owner: string, proposalId: string, decidedAt: number | null): void {
    const previous = this.members.get(proposalId);
    if (previous?.owner === owner && previous.entry.decidedAt === decidedAt) return;
    if (previous) {
      const rows = this.owners.get(previous.owner)!;
      const rank = lowerBound(rows, previous.entry);
      if (rows[rank]?.proposalId === proposalId) rows.splice(rank, 1);
      this.members.delete(proposalId);
    }
    if (decidedAt === null) return;
    if (!Number.isSafeInteger(decidedAt) || decidedAt < 0) throw new Error('Invalid canonical history time');
    const entry = { proposalId, decidedAt };
    const rows = this.owners.get(owner) ?? [];
    rows.splice(lowerBound(rows, entry), 0, entry);
    this.owners.set(owner, rows);
    this.members.set(proposalId, { owner, entry });
  }

  async page<T>(
    owner: string,
    options: SettledHistoryPageOptions,
    read: (id: string) => T | null | Promise<T | null>,
  ): Promise<SettledHistorySourcePage<T>> {
    assertSettledHistoryPageOptions(options);
    const rows = this.owners.get(owner) ?? [];
    const start = options.before ? lowerBound(rows, options.before, true) : 0;
    const scanned = rows.slice(start, start + options.limit);
    const hasMore = rows.length > start + options.limit;
    const outcomes = await Promise.allSettled(scanned.map((entry) => read(entry.proposalId)));
    const failed = outcomes.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const records: T[] = [];
    for (const result of outcomes)
      if (result.status === 'fulfilled' && result.value !== null) records.push(result.value);
    return { records, frontier: scanned.at(-1) ?? null, hasMore };
  }
}

function lowerBound(rows: Entry[], boundary: SettledHistoryPosition, exclusive = false): number {
  let low = 0,
    high = rows.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2),
      item = rows[mid];
    const comparison =
      boundary.proposalId === null ? boundary.decidedAt - item.decidedAt : compareHistoryPosition(item, boundary);
    if (comparison < 0 || (exclusive && boundary.proposalId !== null && comparison === 0)) low = mid + 1;
    else high = mid;
  }
  return low;
}
