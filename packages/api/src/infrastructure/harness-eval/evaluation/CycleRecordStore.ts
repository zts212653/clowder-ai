import { createHash } from 'node:crypto';
import type { CycleRecord, CycleTriggerPolicy } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { isCycleTermination, isCycleWindow } from './cycle-record-validation.js';

const CURRENT_PREFIX = 'harness-cycle-current:';
const HISTORY_PREFIX = 'harness-cycle-history:';
const HISTORY_INDEX_PREFIX = 'harness-cycle-history-index:';
const OWNER_REGISTRY_KEY = 'harness-cycle-owner-registry';
const LEGACY_COMPLETED_WINDOW_END_PREFIX = 'harness-unit-run-completed-window-end:';
export const MAX_CYCLE_RECORD_BYTES = 64 * 1024;

const coordinate = (ownerUserId: string, objectiveId: string) => `${ownerUserId}:${objectiveId}`;
const currentKey = (ownerUserId: string, objectiveId: string) =>
  `${CURRENT_PREFIX}${coordinate(ownerUserId, objectiveId)}`;
const historyKey = (ownerUserId: string, objectiveId: string, cycleId: string) =>
  `${HISTORY_PREFIX}${coordinate(ownerUserId, objectiveId)}:${cycleId}`;
const historyIndexKey = (ownerUserId: string, objectiveId: string) =>
  `${HISTORY_INDEX_PREFIX}${coordinate(ownerUserId, objectiveId)}`;

const TRANSITION_CURRENT_LUA = `
-- @fake-redis-handler: transitionHarnessCycleCurrent
local current = redis.call('GET', KEYS[1])
if current == false then return 0 end
local decoded, cycle = pcall(cjson.decode, current)
if not decoded or cycle.cycleId ~= ARGV[1] or cycle.evalStatus ~= ARGV[2] then return 0 end
if ARGV[4] == 'advance' then
  redis.call('SET', KEYS[2], ARGV[3])
  redis.call('ZADD', KEYS[3], ARGV[5], ARGV[1])
  redis.call('SET', KEYS[1], ARGV[6])
else
  redis.call('SET', KEYS[1], ARGV[3])
end
return 1
`;

function cycleId(ownerUserId: string, objectiveId: string, cycleStart: number): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([ownerUserId, objectiveId, cycleStart]))
    .digest('hex');
  return `cycle-${hash}`;
}

function idleCycle(
  ownerUserId: string,
  objectiveId: string,
  cycleStart: number,
  version: Pick<CycleRecord, 'version' | 'versionContentRef'>,
  state: Pick<CycleRecord, 'triggerPolicy' | 'objectiveLifecycle' | 'carryoverWindows'> = {},
): CycleRecord {
  return {
    schemaVersion: 1,
    cycleId: cycleId(ownerUserId, objectiveId, cycleStart),
    ownerUserId,
    objectiveId,
    ...version,
    cycleStart,
    evalStatus: 'idle',
    ...state,
    windows: [],
  };
}

function parseCycle(raw: string, key: string): CycleRecord {
  if (Buffer.byteLength(raw) > MAX_CYCLE_RECORD_BYTES) throw new Error(`cycle_record_too_large:${key}`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`invalid_cycle_record:${key}`);
  }
  const record = value as Partial<CycleRecord>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.cycleId !== 'string' ||
    typeof record.ownerUserId !== 'string' ||
    typeof record.objectiveId !== 'string' ||
    typeof record.version !== 'string' ||
    typeof record.versionContentRef !== 'string' ||
    typeof record.cycleStart !== 'number' ||
    !Number.isFinite(record.cycleStart) ||
    record.cycleStart < 0 ||
    !Array.isArray(record.windows) ||
    !record.windows.every(isCycleWindow) ||
    (record.carryoverWindows !== undefined &&
      (!Array.isArray(record.carryoverWindows) || !record.carryoverWindows.every(isCycleWindow))) ||
    !['idle', 'requested', 'retriggered', 'written', 'stalled'].includes(record.evalStatus ?? '') ||
    (record.triggerPolicy !== undefined && !isTriggerPolicy(record.triggerPolicy)) ||
    (record.objectiveLifecycle !== undefined && !['active', 'dormant'].includes(record.objectiveLifecycle)) ||
    (record.triggerPolicyChange !== undefined && !isTriggerPolicyChange(record.triggerPolicyChange)) ||
    (record.termination !== undefined && !isCycleTermination(record.termination))
  ) {
    throw new Error(`invalid_cycle_record:${key}`);
  }
  return record as CycleRecord;
}

function isTriggerPolicy(value: unknown): value is CycleTriggerPolicy {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Partial<CycleTriggerPolicy>;
  return (
    Number.isSafeInteger(policy.cumulativeThreshold) &&
    (policy.cumulativeThreshold ?? 0) > 0 &&
    Number.isSafeInteger(policy.counterexampleThreshold) &&
    (policy.counterexampleThreshold ?? 0) > 0 &&
    Number.isSafeInteger(policy.cadenceDays) &&
    (policy.cadenceDays ?? 0) > 0 &&
    Number.isSafeInteger(policy.minimumIntervalMs) &&
    (policy.minimumIntervalMs ?? -1) >= 0 &&
    Number.isSafeInteger(policy.consecutiveKeepCycles) &&
    (policy.consecutiveKeepCycles ?? -1) >= 0 &&
    Number.isSafeInteger(policy.consecutiveCadenceKeepCycles) &&
    (policy.consecutiveCadenceKeepCycles ?? -1) >= 0
  );
}

function isTriggerPolicyChange(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const change = value as Partial<NonNullable<CycleRecord['triggerPolicyChange']>>;
  return (
    ['keep', 'rollback', 'evolve'].includes(change.decision ?? '') &&
    isTriggerPolicy(change.before) &&
    isTriggerPolicy(change.after) &&
    typeof change.appliedAt === 'number' &&
    Number.isFinite(change.appliedAt) &&
    change.appliedAt >= 0
  );
}

function serializeCycle(record: CycleRecord): string {
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > MAX_CYCLE_RECORD_BYTES) {
    throw new Error(`cycle_record_too_large:${record.cycleId}`);
  }
  return serialized;
}

export class CycleRecordStore {
  constructor(private readonly redis: RedisClient) {}

  async current(ownerUserId: string, objectiveId: string): Promise<CycleRecord | null> {
    const key = currentKey(ownerUserId, objectiveId);
    const raw = await this.redis.get(key);
    return raw ? parseCycle(raw, key) : null;
  }

  async initialize(
    ownerUserId: string,
    objectiveId: string,
    cycleStart: number,
    version: Pick<CycleRecord, 'version' | 'versionContentRef'>,
    state: Pick<CycleRecord, 'triggerPolicy' | 'objectiveLifecycle'> = {},
  ): Promise<CycleRecord> {
    if (!Number.isFinite(cycleStart) || cycleStart < 0) throw new Error('invalid_cycle_start');
    const record = idleCycle(ownerUserId, objectiveId, cycleStart, version, state);
    await this.redis.set(currentKey(ownerUserId, objectiveId), serializeCycle(record), 'NX');
    await this.redis.sadd(OWNER_REGISTRY_KEY, ownerUserId);
    return (await this.current(ownerUserId, objectiveId)) ?? record;
  }

  async request(expected: CycleRecord, requested: CycleRecord): Promise<boolean> {
    if (expected.evalStatus !== 'idle' || requested.evalStatus !== 'requested') return false;
    if (
      expected.ownerUserId !== requested.ownerUserId ||
      expected.objectiveId !== requested.objectiveId ||
      expected.cycleId !== requested.cycleId
    ) {
      return false;
    }
    return this.transition(expected, requested);
  }

  async transition(expected: CycleRecord, replacement: CycleRecord): Promise<boolean> {
    if (
      expected.ownerUserId !== replacement.ownerUserId ||
      expected.objectiveId !== replacement.objectiveId ||
      expected.cycleId !== replacement.cycleId
    ) {
      return false;
    }
    const serialized = serializeCycle(replacement);
    const changed = (await this.redis.eval(
      TRANSITION_CURRENT_LUA,
      3,
      currentKey(expected.ownerUserId, expected.objectiveId),
      historyKey(expected.ownerUserId, expected.objectiveId, expected.cycleId),
      historyIndexKey(expected.ownerUserId, expected.objectiveId),
      expected.cycleId,
      expected.evalStatus,
      serialized,
      'replace',
    )) as number;
    return changed === 1;
  }

  async advance(
    expected: CycleRecord,
    completed: CycleRecord,
    version: Pick<CycleRecord, 'version' | 'versionContentRef'>,
  ): Promise<CycleRecord | null> {
    if (
      expected.ownerUserId !== completed.ownerUserId ||
      expected.objectiveId !== completed.objectiveId ||
      expected.cycleId !== completed.cycleId ||
      completed.cycleEnd === undefined ||
      completed.closedAt === undefined ||
      completed.evalStatus !== 'written'
    ) {
      return null;
    }
    const next = idleCycle(expected.ownerUserId, expected.objectiveId, completed.cycleEnd, version, {
      ...(completed.triggerPolicyChange?.after || completed.triggerPolicy
        ? { triggerPolicy: completed.triggerPolicyChange?.after ?? completed.triggerPolicy }
        : {}),
      ...(completed.objectiveLifecycle ? { objectiveLifecycle: completed.objectiveLifecycle } : {}),
    });
    const changed = (await this.redis.eval(
      TRANSITION_CURRENT_LUA,
      3,
      currentKey(expected.ownerUserId, expected.objectiveId),
      historyKey(expected.ownerUserId, expected.objectiveId, expected.cycleId),
      historyIndexKey(expected.ownerUserId, expected.objectiveId),
      expected.cycleId,
      expected.evalStatus,
      serializeCycle(completed),
      'advance',
      String(completed.closedAt),
      serializeCycle(next),
    )) as number;
    return changed === 1 ? next : null;
  }

  /**
   * Close an idle tracing cycle and open its replacement at the exact same
   * timestamp. Redis performs the archive/current swap as one CAS so an eval
   * request can never be overwritten by a late operator click.
   */
  async switchVersion(
    expected: CycleRecord,
    completed: CycleRecord,
    version: Pick<CycleRecord, 'version' | 'versionContentRef'>,
    carryoverWindows: CycleRecord['carryoverWindows'],
  ): Promise<CycleRecord | null> {
    if (
      expected.evalStatus !== 'idle' ||
      completed.evalStatus !== 'idle' ||
      expected.ownerUserId !== completed.ownerUserId ||
      expected.objectiveId !== completed.objectiveId ||
      expected.cycleId !== completed.cycleId ||
      completed.cycleEnd === undefined ||
      completed.closedAt === undefined ||
      !completed.termination ||
      completed.termination.at !== completed.closedAt
    ) {
      return null;
    }
    const next = idleCycle(expected.ownerUserId, expected.objectiveId, completed.cycleEnd, version, {
      ...(completed.triggerPolicy ? { triggerPolicy: completed.triggerPolicy } : {}),
      ...(completed.objectiveLifecycle ? { objectiveLifecycle: completed.objectiveLifecycle } : {}),
      ...(carryoverWindows?.length ? { carryoverWindows } : {}),
    });
    const changed = (await this.redis.eval(
      TRANSITION_CURRENT_LUA,
      3,
      currentKey(expected.ownerUserId, expected.objectiveId),
      historyKey(expected.ownerUserId, expected.objectiveId, expected.cycleId),
      historyIndexKey(expected.ownerUserId, expected.objectiveId),
      expected.cycleId,
      expected.evalStatus,
      serializeCycle(completed),
      'advance',
      String(completed.closedAt),
      serializeCycle(next),
    )) as number;
    return changed === 1 ? next : null;
  }

  async historyCycle(ownerUserId: string, objectiveId: string, id: string): Promise<CycleRecord | null> {
    const key = historyKey(ownerUserId, objectiveId, id);
    const raw = await this.redis.get(key);
    return raw ? parseCycle(raw, key) : null;
  }

  async historyCount(ownerUserId: string, objectiveId: string): Promise<number> {
    return this.redis.zcard(historyIndexKey(ownerUserId, objectiveId));
  }

  async history(ownerUserId: string, objectiveId: string, limit?: number): Promise<CycleRecord[]> {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
      throw new Error('invalid_cycle_history_limit');
    if (limit === 0) return [];
    const ids = await this.redis.zrevrange(
      historyIndexKey(ownerUserId, objectiveId),
      0,
      limit === undefined ? -1 : limit - 1,
    );
    const records: CycleRecord[] = [];
    for (const id of ids) {
      const key = historyKey(ownerUserId, objectiveId, id);
      const raw = await this.redis.get(key);
      if (!raw) throw new Error(`cycle_history_record_missing:${id}`);
      records.push(parseCycle(raw, key));
    }
    return records;
  }

  async ownerUserIds(): Promise<string[]> {
    return (await this.redis.smembers(OWNER_REGISTRY_KEY)).sort();
  }

  async legacyCompletedWindowEnd(ownerUserId: string, objectiveId: string): Promise<number | null> {
    const key = `${LEGACY_COMPLETED_WINDOW_END_PREFIX}${coordinate(ownerUserId, objectiveId)}`;
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid_legacy_completed_window_end:${key}`);
    return value;
  }
}

export function isSkippedCycle(record: CycleRecord): boolean {
  return record.approval?.state === 'skipped' || record.evaluation?.overall === 'insufficient_evidence';
}
