import type { EvaluationSnapshot } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const SNAPSHOT_PREFIX = 'harness-evaluation-snapshot:';
const SNAPSHOT_INDEX_PREFIX = 'harness-evaluation-snapshot-index:';
const CONSUMED_PREFIX = 'harness-evaluation-consumed-annotation:';
const COMPLETED_INDEX_PREFIX = 'harness-evaluation-completed-snapshot-index:';
const UNIT_RUN_WATERMARK_PREFIX = 'harness-unit-run-watermark:';
const UNIT_RUN_CADENCE_WATERMARK_PREFIX = 'harness-unit-run-cadence-watermark:';
const UNIT_RUN_COMPLETED_WINDOW_END_PREFIX = 'harness-unit-run-completed-window-end:';
const UNIT_FIRST_ELIGIBLE_TRACE_AT_PREFIX = 'harness-unit-first-eligible-trace-at:';

const snapshotKey = (snapshotId: string) => `${SNAPSHOT_PREFIX}${snapshotId}`;
const unitCoordinate = (ownerUserId: string, objectiveId: string) => `${ownerUserId}:${objectiveId}`;
const snapshotIndexKey = (ownerUserId: string, objectiveId: string) =>
  `${SNAPSHOT_INDEX_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const consumedKey = (ownerUserId: string, objectiveId: string) =>
  `${CONSUMED_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const completedIndexKey = (ownerUserId: string, objectiveId: string) =>
  `${COMPLETED_INDEX_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const unitRunWatermarkKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_WATERMARK_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const unitRunCadenceWatermarkKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_CADENCE_WATERMARK_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const unitRunCompletedWindowEndKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_COMPLETED_WINDOW_END_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const unitFirstEligibleTraceAtKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_FIRST_ELIGIBLE_TRACE_AT_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const UNIT_RUN_PENDING_PREFIX = 'harness-unit-run-pending:';
const pendingKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_PENDING_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;

const CLEAR_PENDING_UNIT_RUN_LUA = `
-- @fake-redis-handler: clearPendingUnitRun
local pendingRaw = redis.call('GET', KEYS[1])
if pendingRaw == false then return 0 end
local decoded, pending = pcall(cjson.decode, pendingRaw)
if not decoded then return 0 end
if pending.snapshotId ~= ARGV[1] then return 0 end
if tostring(pending.expectedWatermark) ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

export interface PendingUnitRun {
  snapshotId: string;
  expectedWatermark: number;
  snapshot: EvaluationSnapshot;
}

export class EvaluationSnapshotStore {
  constructor(private readonly redis: RedisClient) {}

  async append(snapshot: EvaluationSnapshot): Promise<{ outcome: 'created' | 'duplicate' }> {
    const serialized = JSON.stringify(snapshot);
    const created = await this.redis.set(snapshotKey(snapshot.snapshotId), serialized, 'NX');
    if (created !== 'OK') {
      const existing = await this.redis.get(snapshotKey(snapshot.snapshotId));
      if (existing !== serialized) throw new Error(`evaluation_snapshot_conflict:${snapshot.snapshotId}`);
    }
    await this.redis.zadd(
      snapshotIndexKey(snapshot.ownerUserId, snapshot.objectiveId),
      snapshot.createdAt,
      snapshot.snapshotId,
    );
    return { outcome: created === 'OK' ? 'created' : 'duplicate' };
  }

  async get(snapshotId: string): Promise<EvaluationSnapshot | null> {
    const raw = await this.redis.get(snapshotKey(snapshotId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as EvaluationSnapshot;
    } catch {
      return null;
    }
  }

  async latest(ownerUserId: string, objectiveId: string): Promise<EvaluationSnapshot | null> {
    const ids = await this.redis.zrevrange(snapshotIndexKey(ownerUserId, objectiveId), 0, 0);
    return ids[0] ? this.get(ids[0]) : null;
  }

  async latestCompleted(ownerUserId: string, objectiveId: string): Promise<EvaluationSnapshot | null> {
    const ids = await this.redis.zrevrange(completedIndexKey(ownerUserId, objectiveId), 0, 0);
    return ids[0] ? this.get(ids[0]) : null;
  }

  async consumedAnnotationIds(ownerUserId: string, objectiveId: string): Promise<Set<string>> {
    return new Set(await this.redis.smembers(consumedKey(ownerUserId, objectiveId)));
  }

  async markAnnotationsConsumed(snapshot: EvaluationSnapshot): Promise<void> {
    if (snapshot.annotationIds.length === 0) return;
    await this.redis.sadd(consumedKey(snapshot.ownerUserId, snapshot.objectiveId), ...snapshot.annotationIds);
  }

  async markCompleted(snapshot: EvaluationSnapshot, evaluatedAt: number): Promise<void> {
    // F257 R11: three separate watermarks are persisted atomically on commit:
    //   - completed window end = the semantic upper bound of the last completed
    //     Unit run. The next run's window starts here so completed windows never
    //     overlap and late arrivals below this bound are excluded.
    //   - ingestion cursor = max createdAt of consumed annotations, kept for
    //     audit/dedup but no longer used as the semantic window start.
    //   - cadence watermark = Unit run completion timestamp (used to enforce
    //     daily/weekly cadence, independent of when the last sample arrived).
    await this.redis.zadd(
      completedIndexKey(snapshot.ownerUserId, snapshot.objectiveId),
      snapshot.maxAnnotationScore,
      snapshot.snapshotId,
    );
    await this.redis.set(
      unitRunWatermarkKey(snapshot.ownerUserId, snapshot.objectiveId),
      String(snapshot.maxAnnotationScore),
    );
    await this.redis.set(unitRunCadenceWatermarkKey(snapshot.ownerUserId, snapshot.objectiveId), String(evaluatedAt));
    await this.redis.set(
      unitRunCompletedWindowEndKey(snapshot.ownerUserId, snapshot.objectiveId),
      String(snapshot.window.end),
    );
  }

  /**
   * F257 P1-2/P1-3: the ingestion cursor is a composite cursor
   * (timestamp * SCALE + sequence) stored as a string. It is the inclusive
   * start cursor of the next run and advances monotonically with consumed
   * annotations.
   */
  async ingestionCursor(ownerUserId: string, objectiveId: string): Promise<number> {
    const raw = await this.redis.get(unitRunWatermarkKey(ownerUserId, objectiveId));
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * F257 R10: the cadence watermark is the evaluatedAt timestamp of the last
   * completed Unit run. It is used to decide whether a daily/weekly cadence
   * metric is due again.
   */
  async cadenceWatermark(ownerUserId: string, objectiveId: string): Promise<number> {
    const raw = await this.redis.get(unitRunCadenceWatermarkKey(ownerUserId, objectiveId));
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Durable baseline for a Unit's first cadence. The scheduler is called after
   * every closed trace, so SET NX captures the first eligible raw opportunity
   * and prevents a sliding readiness window from postponing cadence forever.
   */
  async firstEligibleTraceAt(ownerUserId: string, objectiveId: string, observedAt: number): Promise<number> {
    const key = unitFirstEligibleTraceAtKey(ownerUserId, objectiveId);
    if (observedAt > 0) await this.redis.set(key, String(observedAt), 'NX');
    const raw = await this.redis.get(key);
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  /**
   * F257 R11: the completed-window-end is the exclusive upper bound of the last
   * completed Unit run. It is the semantic start of the next Unit window.
   */
  async completedWindowEnd(ownerUserId: string, objectiveId: string): Promise<number> {
    const raw = await this.redis.get(unitRunCompletedWindowEndKey(ownerUserId, objectiveId));
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * F257 P1-2: a durable pending UnitRun freezes the immutable snapshot so a
   * retry at a later `now` can resume the same cohort instead of building a new
   * snapshotId that the claim Lua would reject.
   */
  async getPendingUnitRun(ownerUserId: string, objectiveId: string): Promise<PendingUnitRun | null> {
    const raw = await this.redis.get(pendingKey(ownerUserId, objectiveId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as PendingUnitRun;
      if (parsed.snapshot && parsed.snapshotId && typeof parsed.expectedWatermark === 'number') {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  async clearPending(
    ownerUserId: string,
    objectiveId: string,
    expected: Pick<PendingUnitRun, 'snapshotId' | 'expectedWatermark'>,
  ): Promise<boolean> {
    const cleared = (await this.redis.eval(
      CLEAR_PENDING_UNIT_RUN_LUA,
      1,
      pendingKey(ownerUserId, objectiveId),
      expected.snapshotId,
      String(expected.expectedWatermark),
    )) as number;
    return cleared === 1;
  }
}
