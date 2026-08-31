import { createHash } from 'node:crypto';
import type {
  EvaluationSnapshot,
  MetricDefinition,
  MetricResult,
  ObjectiveJudgment,
  TraceAnnotation,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { InjectionTraceStore } from '../../../domains/prompt-hooks/InjectionTraceStore.js';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { EvaluationIndexer } from './EvaluationIndexer.js';
import { classifyMetrics, EvaluationScheduler, type UnitTraceCorpusReader } from './EvaluationScheduler.js';
import { EvaluationSnapshotStore } from './EvaluationSnapshotStore.js';
import { ExternalSemanticResultStore } from './ExternalSemanticResultStore.js';
import { type EvaluationCatalog } from './evaluation-catalog.js';
import { EvaluatorRunner, type ReplayEvaluator, type SemanticEvaluator } from './evaluator-runner.js';
import { MetricResultStore } from './MetricResultStore.js';
import { ObjectiveJudgmentStore } from './ObjectiveJudgmentStore.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const UNIT_RUN_PENDING_PREFIX = 'harness-unit-run-pending:';
const UNIT_RUN_WATERMARK_PREFIX = 'harness-unit-run-watermark:';
const UNIT_RUN_CADENCE_WATERMARK_PREFIX = 'harness-unit-run-cadence-watermark:';
const UNIT_RUN_COMPLETED_WINDOW_END_PREFIX = 'harness-unit-run-completed-window-end:';

const pendingKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_PENDING_PREFIX}${ownerUserId}:${objectiveId}`;
const watermarkKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_WATERMARK_PREFIX}${ownerUserId}:${objectiveId}`;
const cadenceWatermarkKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_CADENCE_WATERMARK_PREFIX}${ownerUserId}:${objectiveId}`;
const completedWindowEndKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_COMPLETED_WINDOW_END_PREFIX}${ownerUserId}:${objectiveId}`;

/**
 * F257 P1-1/P1-2: Atomic claim of a Unit run.
 *
 * The pending key stores the full UnitRun as JSON so a later retry can resume
 * the same immutable snapshot even if `now` has advanced. If the watermark has
 * moved past the expected cursor, any pending is stale and is cleared.
 */
const CLAIM_UNIT_RUN_LUA = `
-- @fake-redis-handler: claimUnitRun
local pendingRaw = redis.call('GET', KEYS[1])
if pendingRaw ~= false then
  local pending = cjson.decode(pendingRaw)
  if pending.snapshotId ~= ARGV[1] then return 0 end
  if tostring(pending.expectedWatermark) ~= ARGV[2] then
    redis.call('DEL', KEYS[1])
    return 0
  end
  return 1
end
local watermark = redis.call('GET', KEYS[2])
if watermark == false then watermark = '0' end
if watermark ~= ARGV[2] then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('SET', KEYS[1], ARGV[3])
return 1
`;

/**
 * F257 P1-1 / R10: Atomic commit of a Unit run.
 *
 * All durable side effects (results, judgment, consumed annotations, ingestion
 * cursor, cadence watermark) are written inside one Lua script. Redis executes
 * the script atomically, but a runtime error inside the script does NOT roll
 * back writes that have already executed. To prevent partial commits, we
 * preflight every target key type before performing any writes. If any key has
 * the wrong type, the script returns -1 and leaves nothing written.
 *
 * Large cohorts are added to the consumed set with a Lua loop instead of
 * unpack(), which fails with "too many results to unpack" for ~8000+ items.
 */
const COMMIT_UNIT_RUN_LUA = `
-- @fake-redis-handler: commitUnitRun
-- KEYS layout:
--   [1] pending key
--   [2] ingestion watermark key
--   [3] cadence watermark key
--   [4] consumed-annotation set key
--   [5] completed-snapshot-index zset key
--   [6] completed-window-end string key
--   [7..7 + resultCount*2 - 1] result payload key, result index key pairs
--   [7 + resultCount*2] judgment payload key
--   [8 + resultCount*2] judgment index key
-- ARGV layout:
--   [1] snapshotId
--   [2] new ingestion watermark (maxAnnotationScore)
--   [3] expected ingestion watermark (windowStartScore)
--   [4] new cadence watermark (evaluatedAt)
--   [5] new completed window end
--   [6] JSON array of [resultJson, resultScore, resultId]
--   [7] JSON array of [judgmentJson, judgmentScore, judgmentId]
--   [8] JSON array of annotationIds
local pendingRaw = redis.call('GET', KEYS[1])
if pendingRaw == false then return 0 end
local pending = cjson.decode(pendingRaw)
if pending.snapshotId ~= ARGV[1] then return 0 end
local watermark = redis.call('GET', KEYS[2])
if watermark == false then watermark = '0' end
if watermark ~= ARGV[3] then
  redis.call('DEL', KEYS[1])
  return 0
end

local resultEntries = cjson.decode(ARGV[6])
local judgmentEntry = cjson.decode(ARGV[7])
local annotationIds = cjson.decode(ARGV[8])

-- Preflight all target keys before any writes. Wrong types would cause a
-- runtime error mid-script and leave a partial commit behind. Each key role
-- has a precise allowed type set so a string-typed index key is caught before
-- ZADD would fail. All keys are passed through KEYS so the Redis client can
-- apply its keyPrefix consistently.
local function checkStringOrNone(key)
  local t = redis.call('TYPE', key)['ok']
  return t == 'string' or t == 'none'
end
local function checkZsetOrNone(key)
  local t = redis.call('TYPE', key)['ok']
  return t == 'zset' or t == 'none'
end
local function checkSetOrNone(key)
  local t = redis.call('TYPE', key)['ok']
  return t == 'set' or t == 'none'
end

for i = 7, 7 + #resultEntries * 2 - 1, 2 do
  if not checkStringOrNone(KEYS[i]) then return -1 end
  if not checkZsetOrNone(KEYS[i + 1]) then return -1 end
end
local judgmentKeyIdx = 7 + #resultEntries * 2
if not checkStringOrNone(KEYS[judgmentKeyIdx]) then return -1 end
if not checkZsetOrNone(KEYS[judgmentKeyIdx + 1]) then return -1 end
if not checkSetOrNone(KEYS[4]) then return -1 end
if not checkZsetOrNone(KEYS[5]) then return -1 end
if not checkStringOrNone(KEYS[2]) then return -1 end
if not checkStringOrNone(KEYS[3]) then return -1 end
if not checkStringOrNone(KEYS[6]) then return -1 end

for i = 1, #resultEntries do
  local keyIdx = 7 + (i - 1) * 2
  redis.call('SET', KEYS[keyIdx], resultEntries[i][1], 'NX')
  redis.call('ZADD', KEYS[keyIdx + 1], resultEntries[i][2], resultEntries[i][3])
end

redis.call('SET', KEYS[judgmentKeyIdx], judgmentEntry[1], 'NX')
redis.call('ZADD', KEYS[judgmentKeyIdx + 1], judgmentEntry[2], judgmentEntry[3])

for i = 1, #annotationIds do
  redis.call('SADD', KEYS[4], annotationIds[i])
end

redis.call('ZADD', KEYS[5], ARGV[2], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], ARGV[4])
redis.call('SET', KEYS[6], ARGV[5])
redis.call('DEL', KEYS[1])
return 1
`;

export class ObjectiveEvaluationRuntime {
  readonly indexer: EvaluationIndexer;
  readonly snapshots: EvaluationSnapshotStore;
  readonly results: MetricResultStore;
  readonly judgments: ObjectiveJudgmentStore;
  readonly scheduler: EvaluationScheduler;
  readonly runner: EvaluatorRunner;
  readonly traces: UnitTraceCorpusReader;
  readonly externalSemanticResults: ExternalSemanticResultStore;

  constructor(
    private readonly redis: RedisClient,
    readonly catalog: EvaluationCatalog,
    readonly annotations: TraceAnnotationStore,
    options: {
      replayEvaluator?: ReplayEvaluator;
      semanticEvaluator?: SemanticEvaluator;
      traceStore?: UnitTraceCorpusReader;
    } = {},
  ) {
    this.indexer = new EvaluationIndexer(catalog, annotations);
    this.snapshots = new EvaluationSnapshotStore(redis);
    this.results = new MetricResultStore(redis);
    this.judgments = new ObjectiveJudgmentStore(redis);
    this.externalSemanticResults = new ExternalSemanticResultStore(redis);
    this.traces = options.traceStore ?? new InjectionTraceStore(redis);
    this.scheduler = new EvaluationScheduler({ annotations, snapshots: this.snapshots, traces: this.traces });
    this.runner = new EvaluatorRunner({
      ...(options.replayEvaluator ? { replay: options.replayEvaluator } : {}),
      ...(options.semanticEvaluator ? { semantic: options.semanticEvaluator } : {}),
    });
  }

  async append(annotation: TraceAnnotation): Promise<{
    outcome: 'created' | 'duplicate';
    annotationId: string;
    unitEvaluationReady?: boolean;
  }> {
    const appended = await this.indexer.append(annotation);
    // Use createdAt + 1 as the exclusive upper bound so the triggering annotation
    // itself is included in the half-open Unit window [start, now).
    const unitEvaluationReady = await this.scheduleObjective(
      annotation.episodeRef.ownerUserId,
      annotation.objectiveId,
      annotation.createdAt + 1,
    );
    return { ...appended, ...(unitEvaluationReady ? { unitEvaluationReady: true } : {}) };
  }

  async scheduleObjective(ownerUserId: string, objectiveId: string, now: number): Promise<boolean> {
    const objective = this.catalog.registry.objectives.find((definition) => definition.id === objectiveId);
    if (!objective) return false;
    const model = this.catalog.registry.evaluationModels.find(
      (definition) => definition.id === objective.evaluationModelId,
    );
    if (!model) return false;
    const pendingBefore = await this.snapshots.getPendingUnitRun(ownerUserId, objectiveId);
    await this.evaluateObjective(ownerUserId, objective.id, model, now);
    const pendingAfter = await this.snapshots.getPendingUnitRun(ownerUserId, objectiveId);
    return !pendingBefore && hasExternalSemanticMetric(pendingAfter?.snapshot.metricDefinitions);
  }

  async runCadenceMetrics(ownerUserId: string, now: number): Promise<number> {
    let evaluated = 0;
    for (const objective of this.catalog.registry.objectives) {
      const model = this.catalog.registry.evaluationModels.find(
        (candidate) => candidate.id === objective.evaluationModelId,
      );
      if (!model) continue;
      const { cadenceMetrics } = classifyMetrics(model.metrics);
      if (cadenceMetrics.length === 0) continue;
      // The scheduler derives first-run cadence from the Unit's first eligible
      // raw trace; the sweep itself does not manufacture a due watermark.
      const didRun = await this.evaluateObjective(ownerUserId, objective.id, model, now, true);
      if (didRun) evaluated++;
    }
    return evaluated;
  }

  /** Re-evaluate all owner Units after a raw trace terminal becomes durable. */
  async scheduleTraceVolume(ownerUserId: string, now: number): Promise<number> {
    let scheduled = 0;
    for (const objective of this.catalog.registry.objectives) {
      const model = this.catalog.registry.evaluationModels.find(
        (candidate) => candidate.id === objective.evaluationModelId,
      );
      if (!model) continue;
      const pendingBefore = await this.snapshots.getPendingUnitRun(ownerUserId, objective.id);
      if (await this.evaluateObjective(ownerUserId, objective.id, model, now)) continue;
      const pendingAfter = await this.snapshots.getPendingUnitRun(ownerUserId, objective.id);
      if (!pendingBefore && hasExternalSemanticMetric(pendingAfter?.snapshot.metricDefinitions)) {
        scheduled++;
      }
    }
    return scheduled;
  }

  /**
   * Accept one semantic result produced by an authenticated asynchronous eval
   * job, then resume the exact pending Unit snapshot. The staged result is
   * immutable and is not visible in the canonical result index until every
   * required metric reaches a terminal outcome and the Unit commit succeeds.
   */
  async acceptExternalSemanticResult(result: MetricResult): Promise<{ unitCompleted: boolean }> {
    if (result.kind !== 'semantic' || result.value.kind !== 'semantic') {
      throw new Error(`external_semantic_result_kind_mismatch:${result.metricId}`);
    }
    const snapshot = await this.snapshots.get(result.snapshotId);
    if (!snapshot) throw new Error(`external_semantic_snapshot_not_found:${result.snapshotId}`);
    if (snapshot.ownerUserId !== result.ownerUserId || snapshot.objectiveId !== result.objectiveId) {
      throw new Error(`external_semantic_result_coordinate_mismatch:${result.snapshotId}:${result.metricId}`);
    }
    const metric = snapshot.metricDefinitions.find((candidate) => candidate.id === result.metricId);
    if (!metric || metric.kind !== 'semantic' || metric.evaluator.kind !== 'llm') {
      throw new Error(`external_semantic_metric_not_found:${result.snapshotId}:${result.metricId}`);
    }

    const pending = await this.snapshots.getPendingUnitRun(snapshot.ownerUserId, snapshot.objectiveId);
    if (!pending) {
      const completed = await this.snapshots.latestCompleted(snapshot.ownerUserId, snapshot.objectiveId);
      if (completed?.snapshotId === snapshot.snapshotId) {
        await this.externalSemanticResults.append(result);
        return { unitCompleted: true };
      }
      throw new Error(`external_semantic_unit_not_pending:${result.snapshotId}`);
    }
    if (pending.snapshotId !== snapshot.snapshotId) {
      throw new Error(`external_semantic_pending_snapshot_mismatch:${result.snapshotId}:${pending.snapshotId}`);
    }
    const model = this.catalog.registry.evaluationModels.find(
      (candidate) => candidate.id === snapshot.evaluationModelId,
    );
    if (!model || model.ruleVersion !== snapshot.evaluationModelVersion) {
      throw new Error(`external_semantic_model_version_mismatch:${result.snapshotId}`);
    }
    await this.externalSemanticResults.append(result);
    const unitCompleted = await this.evaluateObjective(
      snapshot.ownerUserId,
      snapshot.objectiveId,
      model,
      result.evaluatedAt,
    );
    return { unitCompleted };
  }

  private async evaluateObjective(
    ownerUserId: string,
    objectiveId: string,
    model: import('./EvaluationScheduler.js').EvaluationModelInput,
    now: number,
    force = false,
  ): Promise<boolean> {
    const unitRefs = unitRefsForObjective(this.catalog, objectiveId);
    const scheduled = await this.scheduler.schedule({
      ownerUserId,
      objectiveId,
      evaluationModel: model,
      unitRefs,
      now,
      force,
    });
    if (scheduled.status !== 'queued') return false;

    // Claim the Unit run before evaluating metrics. The claim freezes the
    // expected watermark and snapshotId, preventing concurrent workers from
    // committing overlapping windows and allowing retries to resume the same
    // immutable snapshot.
    const snapshot = scheduled.snapshot;
    const expectedWatermark = snapshot.windowStartScore;
    const claimed = await this.claimUnitRun(ownerUserId, objectiveId, snapshot.snapshotId, expectedWatermark, snapshot);
    if (!claimed) return false;

    const metricOutcomes: Array<{
      metricId: string;
      result?: MetricResult;
      status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
      reason?: string;
    }> = [];
    for (const metric of model.metrics) {
      metricOutcomes.push(await this.evaluateMetric(snapshot, metric, now));
    }

    if (metricOutcomes.some((outcome) => outcome.status === 'unavailable')) {
      // A required metric could not be evaluated due to a transient failure
      // (missing replay adapter, runtime error, etc.). Do not commit a partial
      // Unit run; the pending key is left in place so the next schedule attempt
      // resumes the same snapshotId.
      return false;
    }

    const results = metricOutcomes
      .map((outcome) => outcome.result)
      .filter((result): result is MetricResult => result !== undefined);
    const committed = await this.commitUnitRun(snapshot, results, metricOutcomes, now);
    return committed;
  }

  private async claimUnitRun(
    ownerUserId: string,
    objectiveId: string,
    snapshotId: string,
    expectedWatermark: number,
    snapshot: EvaluationSnapshot,
  ): Promise<boolean> {
    if (typeof (this.redis as { eval?: unknown }).eval !== 'function') {
      // Fallback for stubs without eval support (should not happen in production).
      return true;
    }
    const unitRun = JSON.stringify({ snapshotId, expectedWatermark, snapshot });
    const result = (await this.redis.eval(
      CLAIM_UNIT_RUN_LUA,
      2,
      pendingKey(ownerUserId, objectiveId),
      watermarkKey(ownerUserId, objectiveId),
      snapshotId,
      String(expectedWatermark),
      unitRun,
    )) as number;
    return result === 1;
  }

  private async evaluateMetric(
    snapshot: EvaluationSnapshot,
    metric: EvaluationCatalogMetric,
    now: number,
  ): Promise<{
    metricId: string;
    result?: MetricResult;
    status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
    reason?: string;
  }> {
    if (metric.kind === 'semantic' && metric.evaluator.kind === 'llm') {
      const staged = await this.externalSemanticResults.get(snapshot.snapshotId, metric.id);
      if (staged) return { metricId: metric.id, result: staged, status: 'evaluated' };
    }
    if (!this.runner.canRun(metric)) {
      return { metricId: metric.id, status: 'unavailable', reason: 'evaluator_unavailable' };
    }
    try {
      const result = await this.runner.run(snapshot, metric, now);
      if (result) return { metricId: metric.id, result, status: 'evaluated' };
      return { metricId: metric.id, status: 'insufficient_evidence', reason: 'insufficient_evidence' };
    } catch (error) {
      return {
        metricId: metric.id,
        status: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async commitUnitRun(
    snapshot: EvaluationSnapshot,
    results: MetricResult[],
    metricOutcomes: Array<{
      metricId: string;
      result?: MetricResult;
      status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
      reason?: string;
    }>,
    evaluatedAt: number,
  ): Promise<boolean> {
    const judgment = buildObjectiveJudgment(snapshot, results, metricOutcomes, evaluatedAt);

    // Atomic commit via a single Lua script. A preflight inside the script checks
    // key types before any writes: Redis does not roll back writes on a runtime
    // error, so we must abort before the first mutating command when a key has an
    // unexpected type. The pending key remains for resume if the failure is
    // transient; a type mismatch returns -1 and also leaves the pending key.
    if (typeof (this.redis as { eval?: unknown }).eval !== 'function') {
      // Fallback for stubs without eval support (should not happen in production).
      await this.commitWithoutPipeline(snapshot, results, judgment);
      return true;
    }

    // Build KEYS so the Redis client applies keyPrefix to every durable key.
    // Result/judgment payload and index keys are dynamic, so they are passed as
    // KEYS instead of ARGV to stay consistent with prefixed indexes.
    const keys: string[] = [
      pendingKey(snapshot.ownerUserId, snapshot.objectiveId),
      watermarkKey(snapshot.ownerUserId, snapshot.objectiveId),
      cadenceWatermarkKey(snapshot.ownerUserId, snapshot.objectiveId),
      `harness-evaluation-consumed-annotation:${snapshot.ownerUserId}:${snapshot.objectiveId}`,
      `harness-evaluation-completed-snapshot-index:${snapshot.ownerUserId}:${snapshot.objectiveId}`,
      completedWindowEndKey(snapshot.ownerUserId, snapshot.objectiveId),
    ];
    const resultEntries: [string, string, string][] = [];
    for (const result of results) {
      keys.push(
        `harness-metric-result:${result.resultId}`,
        `harness-metric-result-index:${result.ownerUserId}:${result.objectiveId}:${result.metricId}`,
      );
      resultEntries.push([JSON.stringify(result), String(result.evaluatedAt), result.resultId]);
    }
    keys.push(
      `harness-objective-judgment:${judgment.judgmentId}`,
      `harness-objective-judgment-index:${judgment.ownerUserId}:${judgment.objectiveId}`,
    );
    const judgmentEntry: [string, string, string] = [
      JSON.stringify(judgment),
      String(judgment.evaluatedAt),
      judgment.judgmentId,
    ];

    try {
      const committed = (await this.redis.eval(
        COMMIT_UNIT_RUN_LUA,
        keys.length,
        ...keys,
        snapshot.snapshotId,
        String(snapshot.maxAnnotationScore),
        String(snapshot.windowStartScore),
        String(evaluatedAt),
        String(snapshot.window.end),
        JSON.stringify(resultEntries),
        JSON.stringify(judgmentEntry),
        JSON.stringify(snapshot.annotationIds),
      )) as number;
      return committed === 1;
    } catch {
      // Transient failures (connection, injected test fault) are retryable.
      return false;
    }
  }

  private async commitWithoutPipeline(
    snapshot: EvaluationSnapshot,
    results: MetricResult[],
    judgment: ObjectiveJudgment,
  ): Promise<void> {
    for (const result of results) {
      await this.results.append(result);
    }
    await this.judgments.append(judgment);
    await this.snapshots.markAnnotationsConsumed(snapshot);
    await this.snapshots.markCompleted(snapshot, judgment.evaluatedAt);
  }
}

function hasExternalSemanticMetric(metrics: readonly MetricDefinition[] | undefined): boolean {
  return metrics?.some((metric) => metric.kind === 'semantic' && metric.evaluator.kind === 'llm') ?? false;
}

function unitRefsForObjective(
  catalog: EvaluationCatalog,
  objectiveId: string,
): import('@cat-cafe/shared').EvaluationUnitRef[] {
  return catalog.manifest.units
    .filter((unit) => unit.objectives.some((attachment) => attachment.objectiveId === objectiveId))
    .flatMap((unit) =>
      unit.objectives
        .filter((attachment) => attachment.objectiveId === objectiveId)
        .map((attachment) => ({
          unitType: 'segment' as const,
          unitId: unit.unitId,
          ...(attachment.clauseId ? { clauseId: attachment.clauseId } : {}),
        })),
    );
}

function buildObjectiveJudgment(
  snapshot: EvaluationSnapshot,
  results: MetricResult[],
  metricOutcomes: Array<{
    metricId: string;
    result?: MetricResult;
    status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
    reason?: string;
  }>,
  evaluatedAt: number,
): ObjectiveJudgment {
  const unavailable = metricOutcomes.filter((outcome) => outcome.status === 'unavailable').length;
  let completion: ObjectiveJudgment['completion'];
  if (unavailable > 0) {
    // Unavailable metrics abort the commit before this point; keep the value
    // honest for any callers that build a judgment from an in-memory outcome set.
    completion = 'partial';
  } else if (
    metricOutcomes.length === 0 ||
    metricOutcomes.every((outcome) => outcome.status === 'insufficient_evidence')
  ) {
    completion = 'insufficient_evidence';
  } else {
    // A mix of evaluated and insufficient_evidence metrics is a complete Unit
    // evaluation: every required metric reached a terminal outcome.
    completion = 'complete';
  }

  return {
    judgmentId: `judgment-${digest(['objective', snapshot.snapshotId, snapshot.evaluationModelVersion])}`,
    snapshotId: snapshot.snapshotId,
    ownerUserId: snapshot.ownerUserId,
    objectiveId: snapshot.objectiveId,
    evaluationModelId: snapshot.evaluationModelId,
    evaluationModelVersion: snapshot.evaluationModelVersion,
    unitRefs: snapshot.unitRefs,
    window: snapshot.window,
    metricResults: results,
    metricOutcomes: metricOutcomes.map((outcome) => ({
      metricId: outcome.metricId,
      status: outcome.status,
      reason: outcome.reason,
    })),
    annotationIds: snapshot.annotationIds,
    completion,
    evaluatedAt,
  };
}

// Local type alias to avoid importing non-shared EvaluationModelDefinition.
type EvaluationCatalogMetric = import('@cat-cafe/shared').MetricDefinition;
