import type { ThreadProgressReceiptV1 } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { AppendThreadProgressReceiptResult, IThreadProgressReceiptStore } from './ThreadProgressReceiptStore.js';

const APPEND_IF_ABSENT_LUA = `
local sourceExisting = redis.call('GET', KEYS[1])
local turnExisting = redis.call('GET', KEYS[2])
if turnExisting then
  return {turnExisting, 0}
end
if sourceExisting then
  redis.call('SET', KEYS[2], sourceExisting)
  return {sourceExisting, 0}
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('SET', KEYS[3], ARGV[2])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
return {ARGV[1], 1}
`;

const Keys = {
  receipt: (id: string) => `thread-progress:receipt:${id}`,
  source: (sourceKey: string) => `thread-progress:source:${sourceKey}`,
  turn: (terminalTurnKey: string) => `thread-progress:turn:${terminalTurnKey}`,
  thread: (ownerUserId: string, threadId: string) => `thread-progress:thread:${ownerUserId}:${threadId}`,
};

export class RedisThreadProgressReceiptStore implements IThreadProgressReceiptStore {
  constructor(private readonly redis: RedisClient) {}

  async appendIfAbsent(
    receipt: ThreadProgressReceiptV1,
    options: { readonly terminalTurnKey?: string } = {},
  ): Promise<AppendThreadProgressReceiptResult> {
    const raw = (await this.redis.eval(
      APPEND_IF_ABSENT_LUA,
      4,
      Keys.source(receipt.sourceKey),
      Keys.turn(options.terminalTurnKey ?? receipt.sourceKey),
      Keys.receipt(receipt.id),
      Keys.thread(receipt.ownerUserId, receipt.threadId),
      receipt.id,
      JSON.stringify(receipt),
      String(receipt.occurredAt),
    )) as [string, number];
    const [receiptId, insertedFlag] = raw;
    if (insertedFlag === 1) return { receipt, inserted: true };
    const existing = await this.get(receiptId);
    if (!existing) throw new Error(`Thread progress source index points to missing receipt: ${receiptId}`);
    return { receipt: existing, inserted: false };
  }

  async get(receiptId: string): Promise<ThreadProgressReceiptV1 | null> {
    const raw = await this.redis.get(Keys.receipt(receiptId));
    return raw ? (JSON.parse(raw) as ThreadProgressReceiptV1) : null;
  }

  async listByThread(
    ownerUserId: string,
    threadId: string,
    options: { readonly limit?: number } = {},
  ): Promise<ThreadProgressReceiptV1[]> {
    const limit = options.limit ?? 100;
    const ids = await this.redis.zrevrange(Keys.thread(ownerUserId, threadId), 0, Math.max(0, limit - 1));
    const receipts = await Promise.all(ids.map((id) => this.get(id)));
    return receipts.filter((receipt): receipt is ThreadProgressReceiptV1 => receipt !== null);
  }

  async listPageByThread(
    ownerUserId: string,
    threadId: string,
    options: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<{ items: ThreadProgressReceiptV1[]; nextCursor: string | null }> {
    const key = Keys.thread(ownerUserId, threadId);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const rank = options.cursor ? await this.redis.zrevrank(key, options.cursor) : null;
    if (options.cursor && rank === null) return { items: [], nextCursor: null };
    const start = rank === null ? 0 : rank + 1;
    const ids = await this.redis.zrevrange(key, start, start + limit);
    const pageIds = ids.slice(0, limit);
    const receipts = await Promise.all(pageIds.map((id) => this.get(id)));
    return {
      items: receipts.filter((receipt): receipt is ThreadProgressReceiptV1 => receipt !== null),
      nextCursor: ids.length > limit ? (pageIds.at(-1) ?? null) : null,
    };
  }
}
