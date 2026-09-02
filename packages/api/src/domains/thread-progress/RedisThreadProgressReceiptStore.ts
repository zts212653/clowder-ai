import type { ThreadProgressReceiptV1 } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  type AppendThreadProgressReceiptResult,
  decodeRecentThreadCursor,
  encodeRecentThreadCursor,
  type IThreadProgressReceiptStore,
  type ListRecentThreadOptions,
  type ThreadProgressRecentThread,
} from './ThreadProgressReceiptStore.js';

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
local currentRecent = redis.call('ZSCORE', KEYS[5], ARGV[4])
if not currentRecent or tonumber(ARGV[3]) > tonumber(currentRecent) then
  redis.call('ZADD', KEYS[5], ARGV[3], ARGV[4])
end
return {ARGV[1], 1}
`;

const Keys = {
  receipt: (id: string) => `thread-progress:receipt:${id}`,
  source: (sourceKey: string) => `thread-progress:source:${sourceKey}`,
  turn: (terminalTurnKey: string) => `thread-progress:turn:${terminalTurnKey}`,
  thread: (ownerUserId: string, threadId: string) => `thread-progress:thread:${ownerUserId}:${threadId}`,
  ownerRecent: (ownerUserId: string) => `thread-progress:owner:${ownerUserId}:recent`,
};

export class RedisThreadProgressReceiptStore implements IThreadProgressReceiptStore {
  private readonly recentIndexBackfilledOwners = new Set<string>();
  private readonly recentIndexBackfillPromises = new Map<string, Promise<void>>();

  constructor(private readonly redis: RedisClient) {}

  private get keyPrefix(): string {
    return (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
  }

  private stripPrefix(rawKey: string): string {
    const prefix = this.keyPrefix;
    return prefix && rawKey.startsWith(prefix) ? rawKey.slice(prefix.length) : rawKey;
  }

  async appendIfAbsent(
    receipt: ThreadProgressReceiptV1,
    options: { readonly terminalTurnKey?: string } = {},
  ): Promise<AppendThreadProgressReceiptResult> {
    const raw = (await this.redis.eval(
      APPEND_IF_ABSENT_LUA,
      5,
      Keys.source(receipt.sourceKey),
      Keys.turn(options.terminalTurnKey ?? receipt.sourceKey),
      Keys.receipt(receipt.id),
      Keys.thread(receipt.ownerUserId, receipt.threadId),
      Keys.ownerRecent(receipt.ownerUserId),
      receipt.id,
      JSON.stringify(receipt),
      String(receipt.occurredAt),
      receipt.threadId,
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

  async listRecentThreads(
    ownerUserId: string,
    options: ListRecentThreadOptions = {},
  ): Promise<{ items: ThreadProgressRecentThread[]; nextCursor: string | null }> {
    await this.ensureRecentIndexBackfilled(ownerUserId);
    const key = Keys.ownerRecent(ownerUserId);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const cursor = options.cursor ? decodeRecentThreadCursor(options.cursor) : null;
    const collected = await this.collectRecentThreads(key, cursor, limit + 1, options.excludeThreadIds);

    const items = collected.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: collected.length > limit && last ? encodeRecentThreadCursor(last) : null,
    };
  }

  private async collectRecentThreads(
    key: string,
    cursor: ThreadProgressRecentThread | null,
    targetCount: number,
    excluded?: ReadonlySet<string>,
  ): Promise<ThreadProgressRecentThread[]> {
    const collected: ThreadProgressRecentThread[] = [];
    let maxScore: string | number = cursor?.lastProgressAt ?? '+inf';
    let afterThreadId = cursor?.threadId ?? null;
    while (collected.length < targetCount) {
      const group = await this.readRecentScoreGroup(key, maxScore);
      if (!group) break;
      appendRecentGroup(collected, group, cursor, afterThreadId, excluded, targetCount);
      maxScore = `(${group.score}`;
      afterThreadId = null;
    }
    return collected;
  }

  private async readRecentScoreGroup(
    key: string,
    maxScore: string | number,
  ): Promise<{ readonly score: number; readonly threadIds: readonly string[] } | null> {
    const top = await this.redis.zrevrangebyscore(key, maxScore, '-inf', 'WITHSCORES', 'LIMIT', 0, 1);
    if (top.length < 2) return null;
    const score = Number(top[1]);
    if (!Number.isFinite(score)) return null;
    return { score, threadIds: await this.redis.zrangebyscore(key, score, score) };
  }

  private async ensureRecentIndexBackfilled(ownerUserId: string): Promise<void> {
    if (this.recentIndexBackfilledOwners.has(ownerUserId)) return;
    let pending = this.recentIndexBackfillPromises.get(ownerUserId);
    if (!pending) {
      pending = this.scanOwnerReceiptThreads(ownerUserId);
      this.recentIndexBackfillPromises.set(ownerUserId, pending);
    }
    try {
      await pending;
      this.recentIndexBackfilledOwners.add(ownerUserId);
    } finally {
      this.recentIndexBackfillPromises.delete(ownerUserId);
    }
  }

  private async scanOwnerReceiptThreads(ownerUserId: string): Promise<void> {
    const barePrefix = Keys.thread(ownerUserId, '');
    const matchPattern = `${this.keyPrefix}${barePrefix}*`;
    let cursor = '0';
    do {
      const [nextCursor, rawKeys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (rawKeys.length > 0) await this.backfillOwnerReceiptBatch(ownerUserId, barePrefix, rawKeys);
    } while (cursor !== '0');
  }

  private async backfillOwnerReceiptBatch(
    ownerUserId: string,
    barePrefix: string,
    rawKeys: readonly string[],
  ): Promise<void> {
    const reads = this.redis.pipeline();
    for (const rawKey of rawKeys) reads.zrevrange(this.stripPrefix(rawKey), 0, 0, 'WITHSCORES');
    const results = await reads.exec();
    const updates = this.redis.pipeline();
    let updateCount = 0;
    for (let index = 0; index < rawKeys.length; index++) {
      const [error, value] = results?.[index] ?? [null, null];
      const rawKey = rawKeys[index];
      if (error || !rawKey || !Array.isArray(value) || value.length < 2) continue;
      const score = Number(value[1]);
      const threadId = this.stripPrefix(rawKey).slice(barePrefix.length);
      if (!threadId || !Number.isFinite(score)) continue;
      updates.zadd(Keys.ownerRecent(ownerUserId), 'GT', String(score), threadId);
      updateCount++;
    }
    if (updateCount > 0) await updates.exec();
  }
}

function appendRecentGroup(
  target: ThreadProgressRecentThread[],
  group: { readonly score: number; readonly threadIds: readonly string[] },
  cursor: ThreadProgressRecentThread | null,
  afterThreadId: string | null,
  excluded: ReadonlySet<string> | undefined,
  targetCount: number,
): void {
  for (const threadId of group.threadIds) {
    if (afterThreadId && group.score === cursor?.lastProgressAt && threadId.localeCompare(afterThreadId) <= 0) continue;
    if (excluded?.has(threadId)) continue;
    target.push({ threadId, lastProgressAt: group.score });
    if (target.length >= targetCount) return;
  }
}
