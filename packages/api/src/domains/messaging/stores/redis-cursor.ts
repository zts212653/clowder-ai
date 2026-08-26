/** Redis durable subscription records and monotonic delivery cursors. */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { MessageEnvelope } from '@clowder-ai/plugin-contract';
import type {
  CursorStore,
  SnapshotCaptureCandidate,
  SnapshotCaptureCommit,
  SnapshotCaptureStart,
  SnapshotViewRecord,
  SubscriptionRecord,
} from './ports.js';
import { MessagingKeyPrefixes, MessagingKeys } from './redis-keys.js';
import {
  SNAPSHOT_ACK_LUA,
  SNAPSHOT_CAPTURE_ABORT_LUA,
  SNAPSHOT_CAPTURE_APPEND_LUA,
  SNAPSHOT_CAPTURE_BEGIN_LUA,
  SNAPSHOT_CAPTURE_COMMIT_LUA,
  SNAPSHOT_PAGE_CONSUME_LUA,
  SNAPSHOT_PAGE_READ_LUA,
} from './redis-snapshot-capture-lua.js';
import { type StoredSnapshotState, snapshotCompletion, snapshotView } from './redis-snapshot-state.js';

const CURSOR_ADVANCE_LUA = `
local cur = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '-1')
local nxt = tonumber(ARGV[2])
if nxt > cur then redis.call('HSET', KEYS[1], ARGV[1], nxt) end
return 0
`;

const SUBSCRIPTION_CREATE_OR_GET_LUA = `
local existing = redis.call('GET', KEYS[2])
if existing and existing ~= ARGV[6] then return existing end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[3], ARGV[3])
redis.call('HSET', KEYS[4], 'acked', ARGV[4], 'delivered', ARGV[5])
return ARGV[2]
`;

const SUBSCRIPTION_REVOKE_BY_HANDLE_LUA = `
local members = redis.call('SMEMBERS', KEYS[1])
local count = 0
for _, member in ipairs(members) do
  local separator = string.find(member, '|', 1, true)
  if separator then
    local instanceId = string.sub(member, 1, separator - 1)
    local subscriptionId = string.sub(member, separator + 1)
    local suffix = instanceId .. ':' .. subscriptionId
    local recordKey = ARGV[2] .. suffix
    local raw = redis.call('GET', recordKey)
    if raw then
      local record = cjson.decode(raw)
      if record.revokedAt == nil then
        record.revokedAt = tonumber(ARGV[1])
        redis.call('SET', recordKey, cjson.encode(record))
        redis.call('DEL', ARGV[3] .. suffix)
        redis.call('DEL', ARGV[4] .. suffix)
        redis.call('DEL', ARGV[5] .. suffix)
        redis.call('DEL', ARGV[6] .. suffix)
        count = count + 1
      end
    end
  end
end
return count
`;

type PersistedSubscriptionRecord = Omit<SubscriptionRecord, 'snapshotView' | 'lastSnapshotCompletion'>;

function persistedSubscription(record: SubscriptionRecord): PersistedSubscriptionRecord {
  return {
    subscriptionId: record.subscriptionId,
    pluginInstanceId: record.pluginInstanceId,
    handleId: record.handleId,
    threadId: record.threadId,
    ackedSequence: record.ackedSequence,
    lastDeliveredSequence: record.lastDeliveredSequence,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  };
}

export class RedisCursorStore implements CursorStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async put(record: SubscriptionRecord): Promise<void> {
    const { pluginInstanceId, subscriptionId, handleId } = record;
    await this.redis
      .multi()
      .set(MessagingKeys.subscription(pluginInstanceId, subscriptionId), JSON.stringify(persistedSubscription(record)))
      .set(MessagingKeys.subscriptionByHandle(pluginInstanceId, handleId), subscriptionId)
      .sadd(
        MessagingKeys.subscriptionsOfHandle(handleId),
        `${encodeURIComponent(pluginInstanceId)}|${encodeURIComponent(subscriptionId)}`,
      )
      .hset(MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId), {
        acked: String(record.ackedSequence),
        delivered: String(record.lastDeliveredSequence),
      })
      .exec();
  }

  async createOrGet(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    const { pluginInstanceId, subscriptionId, handleId } = record;
    const indexKey = MessagingKeys.subscriptionByHandle(pluginInstanceId, handleId);
    const indexedSubscriptionId = await this.redis.get(indexKey);
    if (indexedSubscriptionId) {
      const indexed = await this.get(pluginInstanceId, indexedSubscriptionId);
      if (indexed && indexed.revokedAt === undefined) return indexed;
    }
    const winner = (await this.redis.eval(
      SUBSCRIPTION_CREATE_OR_GET_LUA,
      4,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      indexKey,
      MessagingKeys.subscriptionsOfHandle(handleId),
      MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId),
      JSON.stringify(persistedSubscription(record)),
      subscriptionId,
      `${encodeURIComponent(pluginInstanceId)}|${encodeURIComponent(subscriptionId)}`,
      String(record.ackedSequence),
      String(record.lastDeliveredSequence),
      indexedSubscriptionId ?? '',
    )) as string;
    const loaded = await this.get(pluginInstanceId, winner);
    if (!loaded) throw new Error(`subscription index points to missing record ${winner}`);
    return loaded;
  }

  async get(pluginInstanceId: string, subscriptionId: string): Promise<SubscriptionRecord | null> {
    const results = await this.redis
      .multi()
      .get(MessagingKeys.subscription(pluginInstanceId, subscriptionId))
      .hgetall(MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId))
      .get(MessagingKeys.subscriptionSnapshot(pluginInstanceId, subscriptionId))
      .exec();
    const raw = results?.[0]?.[1];
    if (typeof raw !== 'string') return null;
    const record = JSON.parse(raw) as SubscriptionRecord;
    const cursorResult = results?.[1]?.[1];
    const cursors = cursorResult && typeof cursorResult === 'object' ? (cursorResult as Record<string, string>) : {};
    const snapshotRaw = results?.[2]?.[1];
    const snapshot = typeof snapshotRaw === 'string' ? (JSON.parse(snapshotRaw) as StoredSnapshotState) : undefined;
    return {
      ...record,
      ackedSequence: cursors.acked !== undefined ? Number(cursors.acked) : record.ackedSequence,
      lastDeliveredSequence: cursors.delivered !== undefined ? Number(cursors.delivered) : record.lastDeliveredSequence,
      ...(snapshot?.status === 'active'
        ? { snapshotView: snapshotView(snapshot) }
        : snapshot?.status === 'completed'
          ? { lastSnapshotCompletion: snapshotCompletion(snapshot) }
          : {}),
    };
  }

  async findByHandle(pluginInstanceId: string, handleId: string): Promise<SubscriptionRecord | null> {
    const subscriptionId = await this.redis.get(MessagingKeys.subscriptionByHandle(pluginInstanceId, handleId));
    if (!subscriptionId) return null;
    const record = await this.get(pluginInstanceId, subscriptionId);
    return record && record.revokedAt === undefined ? record : null;
  }

  private async advance(
    pluginInstanceId: string,
    subscriptionId: string,
    field: 'acked' | 'delivered',
    sequence: number,
  ): Promise<void> {
    await this.redis.eval(
      CURSOR_ADVANCE_LUA,
      1,
      MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId),
      field,
      String(sequence),
    );
  }

  async advanceAck(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    await this.advance(pluginInstanceId, subscriptionId, 'acked', sequence);
  }

  async advanceDelivered(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    await this.advance(pluginInstanceId, subscriptionId, 'delivered', sequence);
  }

  async beginSnapshotCapture(
    pluginInstanceId: string,
    subscriptionId: string,
    capture: SnapshotCaptureCandidate,
  ): Promise<SnapshotCaptureStart | null> {
    const staged = { ...capture, itemCount: 0 };
    const raw = (await this.redis.eval(
      SNAPSHOT_CAPTURE_BEGIN_LUA,
      4,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshot(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotCapture(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotCaptureItems(pluginInstanceId, subscriptionId),
      JSON.stringify(staged),
      String(Date.now()),
    )) as string;
    if (!raw) return null;
    if (raw === 'started' || raw === 'busy') return { status: raw };
    const state = JSON.parse(raw) as StoredSnapshotState;
    return state.status === 'active' ? { status: 'existing', snapshot: snapshotView(state) } : null;
  }

  async appendSnapshotCapture(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    expectedOffset: number,
    items: readonly MessageEnvelope[],
  ): Promise<boolean> {
    const result = (await this.redis.eval(
      SNAPSHOT_CAPTURE_APPEND_LUA,
      3,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotCapture(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotCaptureItems(pluginInstanceId, subscriptionId),
      snapshotId,
      String(expectedOffset),
      String(Date.now()),
      ...items.map((item) => JSON.stringify(item)),
    )) as number;
    return result === 1;
  }

  async commitSnapshotCapture(
    pluginInstanceId: string,
    subscriptionId: string,
    commit: SnapshotCaptureCommit,
  ): Promise<SnapshotViewRecord | null> {
    const raw = (await this.redis.eval(
      SNAPSHOT_CAPTURE_COMMIT_LUA,
      5,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshot(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotItems(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotCapture(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotCaptureItems(pluginInstanceId, subscriptionId),
      commit.snapshotId,
      String(commit.expectedItemCount),
      String(Date.now()),
      String(commit.nextOffset),
      commit.traversalComplete ? '1' : '0',
    )) as string;
    if (!raw) return null;
    const state = JSON.parse(raw) as StoredSnapshotState;
    return state.status === 'active' ? snapshotView(state) : null;
  }

  async abortSnapshotCapture(pluginInstanceId: string, subscriptionId: string, snapshotId: string): Promise<void> {
    await this.redis.eval(
      SNAPSHOT_CAPTURE_ABORT_LUA,
      2,
      MessagingKeys.subscriptionSnapshotCapture(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotCaptureItems(pluginInstanceId, subscriptionId),
      snapshotId,
    );
  }

  async readSnapshotPage(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    offset: number,
    limit: number,
  ): Promise<readonly MessageEnvelope[] | null> {
    const rows = (await this.redis.eval(
      SNAPSHOT_PAGE_READ_LUA,
      3,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshot(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotItems(pluginInstanceId, subscriptionId),
      snapshotId,
      String(offset),
      String(limit),
    )) as string[] | null;
    return rows?.map((row) => JSON.parse(row) as MessageEnvelope) ?? null;
  }

  async ackSnapshot(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    headSequence: number,
  ): Promise<'applied' | 'replayed' | 'rejected'> {
    const completion: StoredSnapshotState = { status: 'completed', snapshotId, headSequence };
    const result = (await this.redis.eval(
      SNAPSHOT_ACK_LUA,
      4,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshot(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotItems(pluginInstanceId, subscriptionId),
      snapshotId,
      String(headSequence),
      JSON.stringify(completion),
    )) as number;
    return result === 1 ? 'applied' : result === 0 ? 'replayed' : 'rejected';
  }

  async consumeSnapshotPage(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    expected: { readonly offset: number; readonly tokenId?: string },
    next: { readonly offset: number; readonly tokenId?: string; readonly traversalComplete: boolean },
  ): Promise<boolean> {
    const result = (await this.redis.eval(
      SNAPSHOT_PAGE_CONSUME_LUA,
      2,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshot(pluginInstanceId, subscriptionId),
      snapshotId,
      String(expected.offset),
      expected.tokenId ?? '',
      String(next.offset),
      next.tokenId ?? '',
      next.traversalComplete ? '1' : '0',
    )) as number;
    return result === 1;
  }

  async revokeByHandle(handleId: string, revokedAt: number): Promise<number> {
    const keyPrefix = this.redis.options.keyPrefix ?? '';
    return (await this.redis.eval(
      SUBSCRIPTION_REVOKE_BY_HANDLE_LUA,
      1,
      MessagingKeys.subscriptionsOfHandle(handleId),
      String(revokedAt),
      `${keyPrefix}${MessagingKeyPrefixes.subscription}`,
      `${keyPrefix}${MessagingKeyPrefixes.subscriptionSnapshot}`,
      `${keyPrefix}${MessagingKeyPrefixes.subscriptionSnapshotItems}`,
      `${keyPrefix}${MessagingKeyPrefixes.subscriptionSnapshotCapture}`,
      `${keyPrefix}${MessagingKeyPrefixes.subscriptionSnapshotCaptureItems}`,
    )) as number;
  }
}
