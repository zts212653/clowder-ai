import type { SessionRecord } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { CacheRetentionProbeReceipt } from './CacheRetentionProbeService.js';
import { CacheRetentionSettingsStore } from './CacheRetentionSettingsStore.js';
import { RECORD_RETENTION_RETURN } from './cache-retention-health.js';
import type { CacheRetentionWarmProof } from './cache-retention-proof.js';
import { APPEND_RETENTION_INDEX, scanRetentionIndex } from './cache-retention-scan.js';
import { settleRetentionReceipt } from './cache-retention-settlement.js';
import {
  type RetentionCandidate,
  type RetentionHealth,
  type RetentionWindow,
  retentionKey,
  retentionSourceKey,
  retentionWarmUntil,
  retentionWindowId,
} from './cache-retention-state.js';

const candidates = 'cache-retention:candidates';
const pending = 'cache-retention:pending';
const windows = 'cache-retention:windows';
const reconciliation = 'cache-retention:reconciliation';
const due = 'cache-retention:due';
const memberCandidates = (userId: string, catId: string) => `cache-retention:member:${retentionKey(userId, catId)}`;
const windowKey = (id: string) => `cache-retention:window:${id}`;
const sourceCandidatesKey = (source: RetentionCandidate) =>
  `cache-retention:source-candidates:${retentionSourceKey(source)}`;
const healthKey = (user: string, cat: string, session: string) =>
  `cache-retention:health:${retentionKey(user, cat, session)}`;
const REMEMBER_CANDIDATE = `${APPEND_RETENTION_INDEX}
redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])
appendIndex(KEYS[2], ARGV[1])
appendIndex(KEYS[3], ARGV[1])
appendIndex(KEYS[4], ARGV[1])
return 1
`;
const SAVE_WINDOW = `${APPEND_RETENTION_INDEX}
local old = redis.call('GET', KEYS[1])
local revision = old and cjson.decode(old).revision or 0
if revision ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
appendIndex(KEYS[3], ARGV[4])
local value = cjson.decode(ARGV[2])
if value.state == 'waiting' then redis.call('ZADD', KEYS[4], value.dueAt, ARGV[4])
else redis.call('ZREM', KEYS[4], ARGV[4]) end
return 1
`;

/** Durable receipts and scheduling claims, never a second owner for Queue/Task state. No data TTL. */
export class CacheRetentionStateStore {
  constructor(private readonly redis: RedisClient) {}

  async remember(candidate: RetentionCandidate): Promise<void> {
    await this.redis.eval(
      REMEMBER_CANDIDATE,
      4,
      candidates,
      pending,
      sourceCandidatesKey(candidate),
      memberCandidates(candidate.userId, candidate.catId),
      candidate.id,
      JSON.stringify(candidate),
    );
  }
  async sourceCandidates(source: RetentionCandidate): Promise<{ pointers: RetentionCandidate[]; complete: boolean }> {
    const key = sourceCandidatesKey(source),
      count = await this.redis.zcard(key);
    const pointers = new Map<string, RetentionCandidate>(),
      deadline = Date.now() + 10_000;
    for (let scanned = 0; scanned < count && Date.now() < deadline; scanned += 256) {
      const { ids } = await scanRetentionIndex(this.redis, key);
      if (!ids.length) break;
      for (const raw of await this.redis.hmget(candidates, ...ids)) {
        if (!raw) continue;
        const pointer = JSON.parse(raw) as RetentionCandidate;
        pointers.set(pointer.id, pointer);
      }
    }
    return { pointers: [...pointers.values()], complete: count > 0 && pointers.size >= count };
  }
  async sourcePointer(scope: {
    userId: string;
    catId: string;
    threadId: string;
    sourceInvocationId: string;
  }): Promise<RetentionCandidate | null> {
    const ids = await this.redis.zrange(`cache-retention:source-candidates:${retentionSourceKey(scope)}`, 0, 0);
    return ids[0] ? this.candidate(ids[0]) : null;
  }
  async candidate(id: string): Promise<RetentionCandidate | null> {
    const raw = await this.redis.hget(candidates, id);
    return raw ? (JSON.parse(raw) as RetentionCandidate) : null;
  }
  /** Drain a frozen cardinality in bounded pages this poll; rotation preserves progress if budget expires. */
  async *memberCandidates(userId: string, catId: string, deadline: number): AsyncGenerator<RetentionCandidate[]> {
    const key = memberCandidates(userId, catId);
    const count = await this.redis.zcard(key);
    for (let scanned = 0; scanned < count && Date.now() < deadline; scanned += 256) {
      const { ids } = await scanRetentionIndex(this.redis, key);
      if (!ids.length) return;
      yield (await this.redis.hmget(candidates, ...ids)).flatMap((raw) =>
        raw ? [JSON.parse(raw) as RetentionCandidate] : [],
      );
    }
  }
  async due(now: number): Promise<RetentionWindow[]> {
    const ids = await this.redis.zrangebyscore(due, '-inf', now, 'LIMIT', 0, 256);
    return (await Promise.all(ids.map((id) => this.get(id)))).filter((item): item is RetentionWindow => item !== null);
  }
  async retire(id: string): Promise<void> {
    const pointer = await this.candidate(id);
    await this.redis.eval(
      `
for _, key in ipairs(KEYS) do redis.call('ZREM', key, ARGV[1]) end
return 1`,
      pointer ? 3 : 1,
      pending,
      ...(pointer ? [memberCandidates(pointer.userId, pointer.catId), sourceCandidatesKey(pointer)] : []),
      id,
    );
  }
  async get(id: string): Promise<RetentionWindow | null> {
    const raw = await this.redis.get(windowKey(id));
    return raw ? (JSON.parse(raw) as RetentionWindow) : null;
  }
  async save(value: RetentionWindow, previousRevision: number): Promise<boolean> {
    return (
      (await this.redis.eval(
        SAVE_WINDOW,
        4,
        windowKey(value.id),
        windows,
        reconciliation,
        due,
        previousRevision,
        JSON.stringify(value),
        value.source.observedAt,
        value.id,
      )) === 1
    );
  }
  async recent(): Promise<RetentionWindow[]> {
    const ids = await this.redis.zrevrange(windows, 0, 255);
    return (await Promise.all(ids.map((id) => this.get(id)))).filter((item): item is RetentionWindow => item !== null);
  }
  async settleReceipt(id: string, attemptId: string, receipt: CacheRetentionProbeReceipt): Promise<boolean> {
    return settleRetentionReceipt(this, id, attemptId, receipt);
  }
  async windowsToReconcile(): Promise<RetentionWindow[]> {
    const { ids } = await scanRetentionIndex(this.redis, reconciliation);
    return (await Promise.all(ids.map((id) => this.get(id)))).filter((item): item is RetentionWindow => item !== null);
  }
  async retireReconciliation(id: string): Promise<void> {
    await this.redis.zrem(reconciliation, id);
  }
  async proof(record: SessionRecord): Promise<CacheRetentionWarmProof | undefined> {
    const observation = record.lastUsage?.cacheObservation;
    if (!observation || !record.userId) return undefined;
    const window = await this.get(
      retentionWindowId(record.userId, record.catId, record.threadId, record.id, observation.invocationId),
    );
    const receipt = window?.receipts.at(-1);
    if (!window || receipt?.outcome !== 'sample_pass') return undefined;
    const preference = await new CacheRetentionSettingsStore(this.redis).get(record.userId, record.catId);
    return {
      sessionId: window.sessionId,
      source: window.source,
      maintenanceInvocationId: receipt.invocationId,
      observedAt: receipt.endedAt,
      expiresAt: retentionWarmUntil(window),
      retaining: window.state !== 'stopped' && preference.enabled && preference.revision === window.preferenceRevision,
    };
  }
  async health(user: string, cat: string, session: string): Promise<RetentionHealth | null> {
    const raw = await this.redis.get(healthKey(user, cat, session));
    return raw ? (JSON.parse(raw) as RetentionHealth) : null;
  }
  async recordReturn(window: RetentionWindow, value: NonNullable<RetentionWindow['returned']>): Promise<boolean> {
    if (!Number.isSafeInteger(value.inputSequence) || value.inputSequence < 1 || !Number.isFinite(value.observedAt))
      return false;
    const key = healthKey(window.userId, window.catId, window.sessionId);
    const fact = {
      invocationId: value.invocationId,
      inputSequence: value.inputSequence,
      observedAt: value.observedAt,
      ...(typeof value.readRatio === 'number' && Number.isFinite(value.readRatio) && value.readRatio >= 0
        ? { readRatio: value.readRatio }
        : {}),
    };
    return (
      (await this.redis.eval(
        RECORD_RETENTION_RETURN,
        2,
        key,
        `${key}:returns`,
        value.invocationId,
        JSON.stringify(fact),
      )) === 1
    );
  }
}
