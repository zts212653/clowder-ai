import { getTimelineOrderTime } from '../visibility.js';
import type { BoundedThreadMessagePage, StoredMessage } from './MessageStore.js';

type Position = { id: string; timestamp: number };
type Entry = Position & { message: StoredMessage };
const compare = (a: Position, b: Position) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Ordered references to the canonical retained rows, maintained only on writes.
 * Unlike a projection cache, bodies and visibility are always read from those rows.
 */
export class ThreadMessageTimelineIndex {
  private readonly threads = new Map<string, Entry[]>();
  private readonly positions = new Map<string, { threadId: string; rows: Entry[]; entry: Entry }>();

  private lowerBound(rows: Entry[], position: Position): number {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const entry = rows[middle];
      if (!entry) throw new Error('Missing message timeline position');
      if (compare(entry, position) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  upsert(message: StoredMessage): void {
    this.remove(message.id);
    const rows = this.threads.get(message.threadId) ?? [];
    const entry = { message, id: message.id, timestamp: getTimelineOrderTime(message) };
    rows.splice(this.lowerBound(rows, entry), 0, entry);
    this.threads.set(message.threadId, rows);
    this.positions.set(message.id, { threadId: message.threadId, rows, entry });
  }

  update(message: StoredMessage): void {
    if (this.positions.has(message.id)) this.upsert(message);
  }

  remove(id: string): void {
    const position = this.positions.get(id);
    if (!position) return;
    const rows = position.rows;
    rows.splice(this.lowerBound(rows, position.entry), 1);
    if (rows.length === 0) this.threads.delete(position.threadId);
    this.positions.delete(id);
  }

  readBefore(
    threadId: string,
    timestamp: number,
    beforeId: string | undefined,
    scanLimit: number,
  ): BoundedThreadMessagePage {
    const rows = this.threads.get(threadId) ?? [];
    const end = this.lowerBound(rows, { timestamp, id: beforeId ?? '' });
    const start = Math.max(0, end - scanLimit);
    const page = rows.slice(start, end);
    const oldest = page[0];
    return {
      messages: page.map((entry) => entry.message),
      scannedCount: page.length,
      storageRoundTrips: 0,
      exhausted: start === 0,
      ...(oldest ? { nextCursor: { timestamp: oldest.timestamp, id: oldest.id } } : {}),
    };
  }
}
