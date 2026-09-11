import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  assertQueueLedgerEntry,
  cloneQueueLedgerEntry,
  type QueueLedgerClaimResult,
  type QueueLedgerCommitMode,
  type QueueLedgerEnqueueResult,
  type QueueLedgerEntry,
  type QueueLedgerStore,
  type QueueLedgerTargetExpansionResult,
  type QueueLedgerTargetReconcileResult,
  type QueueLedgerTransitionResult,
  queueLedgerAdmissionsMatch,
} from './QueueLedger.js';
import { QueueLedgerKeys } from './queue-ledger-keys.js';
import {
  CLAIM_QUEUE_PREFIX_LUA,
  CLAIM_QUEUE_ROW_LUA,
  COMMIT_QUEUE_ROW_LUA,
  ENQUEUE_QUEUE_ROWS_LUA,
  EXPAND_QUEUE_TARGET_ROWS_LUA,
  MIGRATE_QUEUE_LEDGER_V2_LUA,
  RECONCILE_QUEUE_TARGETS_LUA,
  RESTORE_QUEUE_ROW_LUA,
} from './queue-ledger-redis-scripts.js';
import {
  hydrateQueueLedgerEntry,
  migrateQueueLedgerRowsToV2,
  queueLedgerTransitionResult,
} from './RedisQueueLedgerCodec.js';
import {
  getRedisQueueLedgerEntriesByMessageIds,
  getRedisQueueLedgerEntry,
  listAllRedisQueueLedgerEntries,
  listRedisQueueLedgerEntries,
  listRedisQueueLedgerThreadIds,
} from './RedisQueueLedgerReader.js';

export { hydrateQueueLedgerEntry, migrateQueueLedgerRowsToV2 } from './RedisQueueLedgerCodec.js';

export class RedisQueueLedgerStore implements QueueLedgerStore {
  private readonly migrations = new Map<string, Promise<void>>();

  constructor(private readonly redis: RedisClient) {}

  usesRedisClient(redis: RedisClient): boolean {
    return this.redis === redis;
  }

  private get keyPrefix(): string {
    return (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
  }

  private async ensureThreadMigrated(threadId: string): Promise<void> {
    const existing = this.migrations.get(threadId);
    if (existing) return existing;
    const migration = this.migrateThread(threadId).catch((error) => {
      this.migrations.delete(threadId);
      throw error;
    });
    this.migrations.set(threadId, migration);
    return migration;
  }

  private async migrateThread(threadId: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if ((await this.redis.get(QueueLedgerKeys.schema(threadId))) === '2') return;
      const [rawById, order] = await Promise.all([
        this.redis.hgetall(QueueLedgerKeys.entries(threadId)),
        this.redis.lrange(QueueLedgerKeys.order(threadId), 0, -1),
      ]);
      const plan = migrateQueueLedgerRowsToV2(rawById, order);
      const expectedEntries = Object.entries(rawById).sort(([left], [right]) => left.localeCompare(right));
      const result = Number(
        await this.redis.eval(
          MIGRATE_QUEUE_LEDGER_V2_LUA,
          4,
          QueueLedgerKeys.entries(threadId),
          QueueLedgerKeys.order(threadId),
          QueueLedgerKeys.messageIndex(threadId),
          QueueLedgerKeys.schema(threadId),
          JSON.stringify(expectedEntries),
          JSON.stringify(order),
          JSON.stringify(plan.entries),
          JSON.stringify(plan.order),
          JSON.stringify(plan.messageIndex),
        ),
      );
      if (result === 1 || result === 2) return;
      if (result !== 0) throw new Error(`unexpected Queue v2 migration outcome: ${result}`);
    }
    throw new Error(`Queue v2 migration did not converge for thread ${threadId}`);
  }

  async enqueue(
    entries: readonly QueueLedgerEntry[],
    maxQueuedUserEntries?: number,
  ): Promise<QueueLedgerEnqueueResult> {
    if (entries.length === 0) throw new Error('queue ledger enqueue requires at least one row');
    for (const entry of entries) assertQueueLedgerEntry(entry);
    const first = entries[0];
    if (!first) throw new Error('queue ledger enqueue requires at least one row');
    const threadId = first.threadId;
    await this.ensureThreadMigrated(threadId);
    if (entries.some((entry) => entry.threadId !== threadId))
      throw new Error('queue ledger enqueue must be one thread');
    const serialized = entries.map((entry) => JSON.stringify(entry));
    const raw = Number(
      await this.redis.eval(
        ENQUEUE_QUEUE_ROWS_LUA,
        3,
        QueueLedgerKeys.entries(threadId),
        QueueLedgerKeys.order(threadId),
        QueueLedgerKeys.messageIndex(threadId),
        maxQueuedUserEntries === undefined ? '-1' : String(maxQueuedUserEntries),
        String(entries.length),
        ...serialized,
      ),
    );
    if (raw === 0) return { outcome: 'full', entries: [] };
    if (raw === -1) return { outcome: 'conflict', entries: [] };
    if (raw !== 1 && raw !== 2) throw new Error(`unexpected queue ledger enqueue outcome: ${raw}`);
    if (raw === 1) return { outcome: 'enqueued', entries: entries.map(cloneQueueLedgerEntry) };
    const existingRaws = await this.redis.hmget(QueueLedgerKeys.entries(threadId), ...entries.map((entry) => entry.id));
    if (existingRaws.some((value) => typeof value !== 'string')) {
      throw new Error('Queue replay identity vanished after atomic preflight');
    }
    const existing = existingRaws.map((value) => hydrateQueueLedgerEntry(value as string));
    if (
      !existing.every((entry, index) => {
        const input = entries[index];
        return input !== undefined && queueLedgerAdmissionsMatch(entry, input);
      })
    ) {
      return { outcome: 'conflict', entries: [] };
    }
    return { outcome: 'replayed', entries: existing };
  }

  async expandTargets(
    threadId: string,
    entryId: string,
    bindTargetCatId: string,
    expectedQueuedEntryIds: readonly string[],
    siblingEntries: readonly QueueLedgerEntry[],
  ): Promise<QueueLedgerTargetExpansionResult> {
    await this.ensureThreadMigrated(threadId);
    if (!bindTargetCatId) throw new Error('queue target expansion requires a target');
    for (const entry of siblingEntries) assertQueueLedgerEntry(entry);
    const result = (await this.redis.eval(
      EXPAND_QUEUE_TARGET_ROWS_LUA,
      3,
      QueueLedgerKeys.entries(threadId),
      QueueLedgerKeys.order(threadId),
      QueueLedgerKeys.messageIndex(threadId),
      entryId,
      bindTargetCatId,
      String(expectedQueuedEntryIds.length),
      String(siblingEntries.length),
      ...expectedQueuedEntryIds,
      ...siblingEntries.map((entry) => JSON.stringify(entry)),
    )) as [number | string, string];
    const raw = Number(result[0]);
    if (raw === -2) return { outcome: 'not_found', entries: [] };
    if (raw === 0) return { outcome: 'state_changed', entries: [] };
    if (raw === -1) return { outcome: 'conflict', entries: [] };
    if (raw !== 1 && raw !== 2) throw new Error(`unexpected queue target expansion outcome: ${raw}`);
    const serialized = JSON.parse(result[1]) as unknown;
    if (!Array.isArray(serialized) || serialized.some((value) => typeof value !== 'string')) {
      throw new Error('Queue target expansion returned invalid committed rows');
    }
    const entries = serialized.map((value) => hydrateQueueLedgerEntry(value));
    const anchor = entries[0];
    if (!anchor || !anchor.targets.includes(bindTargetCatId)) {
      return { outcome: 'conflict', entries: [] };
    }
    if (
      !entries.slice(1 + expectedQueuedEntryIds.length).every((entry, index) => {
        const input = siblingEntries[index];
        return input !== undefined && queueLedgerAdmissionsMatch(entry, input);
      })
    ) {
      return { outcome: 'conflict', entries: [] };
    }
    return { outcome: raw === 1 ? 'expanded' : 'replayed', entries };
  }

  async reconcileTargets(
    threadId: string,
    entryId: string,
    addTargetIds: readonly string[],
    removeTargetIds: readonly string[],
    authorIntentByTarget: Readonly<NonNullable<QueueLedgerEntry['delivery']['authorIntentByTarget']>> = {},
  ): Promise<QueueLedgerTargetReconcileResult> {
    await this.ensureThreadMigrated(threadId);
    const result = (await this.redis.eval(
      RECONCILE_QUEUE_TARGETS_LUA,
      3,
      QueueLedgerKeys.entries(threadId),
      QueueLedgerKeys.order(threadId),
      QueueLedgerKeys.messageIndex(threadId),
      entryId,
      JSON.stringify(addTargetIds),
      JSON.stringify(removeTargetIds),
      JSON.stringify(authorIntentByTarget ?? {}),
    )) as [number | string, string];
    const outcome = Number(result[0]);
    if (outcome === -1) return { outcome: 'not_found' };
    if (outcome === 0) return { outcome: 'state_changed' };
    if (outcome !== 1 && outcome !== 2) throw new Error(`unexpected Queue target reconcile outcome: ${outcome}`);
    const entry = result[1] ? hydrateQueueLedgerEntry(result[1]) : null;
    return { outcome: outcome === 1 ? 'updated' : 'replayed', entry };
  }

  async list(threadId: string): Promise<QueueLedgerEntry[]> {
    await this.ensureThreadMigrated(threadId);
    return listRedisQueueLedgerEntries(this.redis, threadId);
  }

  async listAll(threadId: string): Promise<QueueLedgerEntry[]> {
    await this.ensureThreadMigrated(threadId);
    return listAllRedisQueueLedgerEntries(this.redis, threadId);
  }

  async getByMessageIds(threadId: string, messageIds: readonly string[]): Promise<Map<string, QueueLedgerEntry[]>> {
    await this.ensureThreadMigrated(threadId);
    return getRedisQueueLedgerEntriesByMessageIds(this.redis, threadId, messageIds);
  }

  async listThreadIds(): Promise<string[]> {
    return listRedisQueueLedgerThreadIds(this.redis, this.keyPrefix);
  }

  async get(threadId: string, entryId: string): Promise<QueueLedgerEntry | null> {
    await this.ensureThreadMigrated(threadId);
    return getRedisQueueLedgerEntry(this.redis, threadId, entryId);
  }

  async claim(
    threadId: string,
    entryId: string,
    claimId: string,
    claimedAt: number,
    bindTargetCatId?: string,
    steerRequestedAt?: number,
  ): Promise<QueueLedgerClaimResult> {
    await this.ensureThreadMigrated(threadId);
    const raw = await this.redis.eval(
      CLAIM_QUEUE_ROW_LUA,
      1,
      QueueLedgerKeys.entries(threadId),
      entryId,
      claimId,
      String(claimedAt),
      bindTargetCatId ?? '',
      steerRequestedAt === undefined ? '' : String(steerRequestedAt),
    );
    const result = queueLedgerTransitionResult(raw);
    return result.outcome === 'updated'
      ? { outcome: 'claimed', entries: [result.entry], claimId }
      : { outcome: result.outcome };
  }

  async claimPrefix(
    threadId: string,
    entryIds: readonly string[],
    claimId: string,
    claimedAt: number,
    bindTargetCatId?: string,
    steerRequestedAt?: number,
  ): Promise<QueueLedgerClaimResult> {
    await this.ensureThreadMigrated(threadId);
    if (entryIds.length === 0) throw new Error('queue prefix claim requires at least one row');
    const raw = await this.redis.eval(
      CLAIM_QUEUE_PREFIX_LUA,
      1,
      QueueLedgerKeys.entries(threadId),
      String(entryIds.length),
      claimId,
      String(claimedAt),
      bindTargetCatId ?? '',
      steerRequestedAt === undefined ? '' : String(steerRequestedAt),
      ...entryIds,
    );
    if (!Array.isArray(raw)) throw new Error('invalid queue prefix claim reply');
    const outcome = Number(raw[0]);
    if (outcome === -1) return { outcome: 'not_found' };
    if (outcome === 0) return { outcome: 'state_changed' };
    if (outcome !== 1 || typeof raw[1] !== 'string') throw new Error('invalid queue prefix claim outcome');
    const encoded: unknown = JSON.parse(raw[1]);
    if (!Array.isArray(encoded) || encoded.some((item) => typeof item !== 'string')) {
      throw new Error('invalid queue prefix claim payload');
    }
    return {
      outcome: 'claimed',
      claimId,
      entries: encoded.map((item) => hydrateQueueLedgerEntry(item)),
    };
  }

  async commit(
    threadId: string,
    entryId: string,
    claimId: string,
    mode: QueueLedgerCommitMode,
    at: number,
    replacement?: QueueLedgerEntry,
  ): Promise<QueueLedgerTransitionResult> {
    await this.ensureThreadMigrated(threadId);
    if (replacement) assertQueueLedgerEntry(replacement);
    return queueLedgerTransitionResult(
      await this.redis.eval(
        COMMIT_QUEUE_ROW_LUA,
        3,
        QueueLedgerKeys.entries(threadId),
        QueueLedgerKeys.order(threadId),
        QueueLedgerKeys.messageIndex(threadId),
        entryId,
        claimId,
        mode,
        String(at),
        replacement ? JSON.stringify(replacement) : '',
      ),
    );
  }

  async restore(
    threadId: string,
    entryId: string,
    claimId: string,
    restoreUnassignedTarget = false,
  ): Promise<QueueLedgerTransitionResult> {
    await this.ensureThreadMigrated(threadId);
    return queueLedgerTransitionResult(
      await this.redis.eval(
        RESTORE_QUEUE_ROW_LUA,
        1,
        QueueLedgerKeys.entries(threadId),
        entryId,
        claimId,
        restoreUnassignedTarget ? '1' : '0',
      ),
    );
  }
}
