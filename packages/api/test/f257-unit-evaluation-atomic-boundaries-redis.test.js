/**
 * F257 P1-1/P1-2/P1-3 — Real-Redis regression drills for Unit evaluation atomic
 * boundaries.
 *
 * These tests require an isolated local Redis (db 15 or manifest-assigned).
 * Run via: REDIS_URL=redis://127.0.0.1:6398/15 CAT_CAFE_REDIS_TEST_ISOLATED=1 \
 *   node --test packages/api/test/f257-unit-evaluation-atomic-boundaries-redis.test.js
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('F257 Unit evaluation atomic boundaries - real Redis', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let createRedisClient;
  let redis;
  let TraceAnnotationStore;
  let ObjectiveEvaluationRuntime;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'f257-unit-evaluation-atomic-boundaries-redis');

    const shared = await import('@cat-cafe/shared/utils');
    createRedisClient = shared.createRedisClient;

    const storeMod = await import('../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js');
    TraceAnnotationStore = storeMod.TraceAnnotationStore;

    const runtimeMod = await import('../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js');
    ObjectiveEvaluationRuntime = runtimeMod.ObjectiveEvaluationRuntime;

    redis = createRedisClient({ url: REDIS_URL, keyPrefix: 'f257-unit-boundaries:' });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[f257-unit-evaluation-atomic-boundaries-redis] Redis unreachable, skipping drills');
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (redis && connected) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupClientKeyspace(redis);
  });

  const countMetric = {
    id: 'tool-schema-failure-count',
    label: 'Count',
    kind: 'counter',
    evaluator: { kind: 'code', ruleRef: 'counter-distinct-episodes-v1' },
    trigger: { kind: 'distinct-counterexamples', threshold: 1 },
  };

  const catalog = {
    registry: {
      registryVersion: 2,
      evaluationModels: [
        {
          id: 'em-tool',
          label: 'Tool',
          ruleVersion: 'v1',
          metrics: [countMetric],
        },
      ],
      objectives: [
        {
          id: 'tool-access-correct-use',
          label: 'Tool access',
          statement: 'Use tools correctly',
          evaluationModelId: 'em-tool',
        },
      ],
    },
    manifest: {
      manifestVersion: 1,
      registryVersion: 2,
      units: [
        {
          unitId: 'S13',
          hookId: 's13-doc',
          unitState: 'evaluable',
          objectives: [{ objectiveId: 'tool-access-correct-use' }],
        },
      ],
    },
  };

  function annotation(index, createdAt) {
    return {
      annotationId: `ann-${index}`,
      episodeRef: {
        traceTurnId: `turn-${index}`,
        invocationId: `inv-${index}`,
        ownerUserId: 'owner-1',
        threadId: 'thread-1',
        catId: 'cat-1',
        inputMessageId: `input-${index}`,
        outputMessageId: `output-${index}`,
        terminalAt: createdAt,
        terminalKind: 'completed',
        toolCalls: [],
      },
      source: 'structured-rule',
      ruleId: 'tool-schema-error-v1',
      objectiveId: 'tool-access-correct-use',
      metricId: countMetric.id,
      unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
      polarity: 'counterexample',
      confidence: 1,
      incidentKey: `incident-${index}`,
      evidenceRefs: [`invocation://inv-${index}`],
      createdAt,
    };
  }

  function makeRuntime() {
    const annotations = new TraceAnnotationStore(redis);
    return new ObjectiveEvaluationRuntime(redis, catalog, annotations);
  }

  it('P1-1 mid-script type error aborts before any durable write', async () => {
    const runtime = makeRuntime();

    // Pre-set the count metric result index to a string. The atomic commit Lua
    // preflights key types and must return -1 before any mutating command, so
    // no result payload, judgment, or consumed annotation is written.
    const resultIndexKey = `harness-metric-result-index:owner-1:tool-access-correct-use:${countMetric.id}`;
    await redis.set(resultIndexKey, 'sabotage');

    await runtime.append(annotation(1, 100));

    assert.equal(await runtime.judgments.latest('owner-1', 'tool-access-correct-use'), null);

    const consumed = await runtime.snapshots.consumedAnnotationIds('owner-1', 'tool-access-correct-use');
    assert.equal(consumed.has('ann-1'), false, 'annotation must remain unconsumed after aborted commit');

    const pending = await runtime.snapshots.getPendingUnitRun('owner-1', 'tool-access-correct-use');
    assert.ok(pending, 'pending UnitRun must survive a retryable preflight failure');

    // Repair the key type and retry. The scheduler resumes the same immutable
    // snapshot and the commit succeeds.
    await redis.del(resultIndexKey);
    await runtime.scheduleObjective('owner-1', 'tool-access-correct-use', 1000);

    const retryResults = await runtime.results.queryMetricWindow(
      'owner-1',
      'tool-access-correct-use',
      countMetric.id,
      0,
      2000,
    );
    assert.equal(retryResults.length, 1, 'retry must produce the result');
    const retryJudgment = await runtime.judgments.latest('owner-1', 'tool-access-correct-use');
    assert.ok(retryJudgment, 'retry must produce the judgment');
    assert.ok((await runtime.snapshots.consumedAnnotationIds('owner-1', 'tool-access-correct-use')).has('ann-1'));
  });

  it('P1-2 later-now retry resumes the same frozen snapshot', async () => {
    const runtime = makeRuntime();

    // Inject a transient failure on the first Lua commit only. The commit script
    // has 4 fixed keys plus 2 keys per result plus 2 judgment keys, so a key
    // count >= 6 identifies the commit command.
    const originalEval = redis.eval.bind(redis);
    let commitAttempts = 0;
    redis.eval = async (script, ...args) => {
      const numKeys = args[0];
      if (typeof numKeys === 'number' && numKeys >= 6) {
        commitAttempts++;
        if (commitAttempts === 1) {
          throw new Error('injected_commit_failure');
        }
      }
      return originalEval(script, ...args);
    };

    await runtime.append(annotation(1, 100));

    assert.equal(
      (await runtime.results.queryMetricWindow('owner-1', 'tool-access-correct-use', countMetric.id, 0, 2000)).length,
      0,
    );
    assert.equal(await runtime.judgments.latest('owner-1', 'tool-access-correct-use'), null);

    const pending = await runtime.snapshots.getPendingUnitRun('owner-1', 'tool-access-correct-use');
    assert.ok(pending, 'pending UnitRun must hold the frozen snapshot');
    const firstSnapshotId = pending.snapshot.snapshotId;

    // Retry at a later `now`. The scheduler resumes the pending immutable
    // snapshot, so the committed judgment keeps the same snapshotId.
    redis.eval = originalEval;
    await runtime.scheduleObjective('owner-1', 'tool-access-correct-use', 1001);

    const judgment = await runtime.judgments.latest('owner-1', 'tool-access-correct-use');
    assert.ok(judgment, 'retry at a later now must commit');
    assert.equal(judgment.snapshotId, firstSnapshotId);
    assert.ok((await runtime.snapshots.consumedAnnotationIds('owner-1', 'tool-access-correct-use')).has('ann-1'));
  });

  it('P1-2 stale cleanup cannot delete a newer pending generation', async () => {
    const runtime = makeRuntime();
    const key = 'harness-unit-run-pending:owner-1:tool-access-correct-use';
    const stale = {
      snapshotId: 'snapshot-stale',
      expectedWatermark: 10,
      snapshot: { snapshotId: 'snapshot-stale' },
    };
    const current = {
      snapshotId: 'snapshot-current',
      expectedWatermark: 20,
      snapshot: { snapshotId: 'snapshot-current' },
    };

    await redis.set(key, JSON.stringify(stale));
    const observed = await runtime.snapshots.getPendingUnitRun('owner-1', 'tool-access-correct-use');
    assert.deepEqual(observed, stale);
    await redis.set(key, JSON.stringify(current));

    assert.equal(await runtime.snapshots.clearPending('owner-1', 'tool-access-correct-use', observed), false);
    assert.deepEqual(await runtime.snapshots.getPendingUnitRun('owner-1', 'tool-access-correct-use'), current);
  });

  it('P1-3 late-arrival annotation before lastCompleted.end is excluded', async () => {
    const runtime = makeRuntime();
    const annotations = runtime.annotations;

    // First annotation at t=100 triggers and commits a Unit run.
    await runtime.append(annotation(1, 100));
    const judgment1 = await runtime.judgments.latest('owner-1', 'tool-access-correct-use');
    assert.ok(judgment1);
    assert.deepEqual(judgment1.annotationIds, ['ann-1']);

    // A later annotation shares the same createdAt but arrives after the Unit run
    // has already frozen [0, lastCompleted.end). Because the semantic window is
    // anchored at the completed run's exclusive upper bound, it must NOT be
    // silently re-included in a new run.
    await annotations.append(annotation(2, 100));
    await runtime.scheduleObjective('owner-1', 'tool-access-correct-use', 200);

    const windowed = await runtime.judgments.queryWindow('owner-1', 'tool-access-correct-use', 0, 201);
    assert.equal(windowed.length, 1, 'only one Unit run must have committed');
    const consumed = await runtime.snapshots.consumedAnnotationIds('owner-1', 'tool-access-correct-use');
    assert.ok(consumed.has('ann-1'));
    assert.equal(consumed.has('ann-2'), false, 'late arrival below lastCompleted.end must stay unconsumed');
  });

  it('R10 identical annotation retry reuses the persisted sequence', async () => {
    const runtime = makeRuntime();
    const ann = annotation(1, 100);

    const first = await runtime.annotations.append(ann);
    assert.equal(first.outcome, 'created');

    const second = await runtime.annotations.append(ann);
    assert.equal(second.outcome, 'duplicate');
    assert.equal(second.annotationId, first.annotationId);

    const window = await runtime.annotations.queryMetricWindow(
      'owner-1',
      'tool-access-correct-use',
      countMetric.id,
      0,
      200,
    );
    assert.equal(window.length, 1);
  });

  it('R10 production-epoch same-ms annotations keep distinct sequence slots', async () => {
    const runtime = makeRuntime();
    const now = Date.now();

    const ann1 = annotation(1, now);
    const ann2 = { ...annotation(2, now), incidentKey: 'incident-r10-2' };
    await runtime.annotations.append(ann1);
    await runtime.annotations.append(ann2);

    const window = await runtime.annotations.queryMetricWindow(
      'owner-1',
      'tool-access-correct-use',
      countMetric.id,
      now,
      now + 1,
    );
    assert.equal(window.length, 2);

    const sequences = window.map((annotation) => annotation.sequence ?? 0).sort((left, right) => left - right);
    assert.ok(sequences[1] > sequences[0], 'production epoch sequence slots must not collapse');
  });

  it('R10 large cohort commit is atomic and consumes all annotations', async () => {
    const runtime = makeRuntime();
    const annotations = runtime.annotations;
    const now = 100;

    // Build a 9000-annotation cohort without scheduling, then trigger a single
    // Unit evaluation by re-appending the first annotation (idempotent) which
    // schedules the objective at now+1.
    for (let index = 1; index <= 9_000; index++) {
      await annotations.append({
        ...annotation(index, now),
        annotationId: `ann-${index}`,
        incidentKey: `incident-${index}`,
      });
    }

    await runtime.append(annotation(1, now));

    const judgment = await runtime.judgments.latest('owner-1', 'tool-access-correct-use');
    assert.ok(judgment, 'large cohort must commit a judgment');
    assert.equal(judgment.annotationIds.length, 9_000, 'judgment must reference every annotation');

    const consumed = await runtime.snapshots.consumedAnnotationIds('owner-1', 'tool-access-correct-use');
    assert.equal(consumed.size, 9_000, 'every annotation must be consumed');
  });

  it('R11 same annotationId with conflicting payload is rejected on real Redis', async () => {
    const runtime = makeRuntime();
    const ann = annotation(1, 100);

    const first = await runtime.annotations.append(ann);
    assert.equal(first.outcome, 'created');

    const conflicting = { ...ann, incidentKey: 'incident-conflicting' };
    await assert.rejects(runtime.annotations.append(conflicting), /trace_annotation_conflict:ann-1/);

    const window = await runtime.annotations.queryMetricWindow(
      'owner-1',
      'tool-access-correct-use',
      countMetric.id,
      0,
      200,
    );
    assert.equal(window.length, 1);
    assert.equal(window[0].incidentKey, ann.incidentKey);

    const duplicate = await runtime.annotations.append(ann);
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(duplicate.annotationId, first.annotationId);
  });

  it('R12 concurrent same annotationId with different incident payload has exactly one winner', async () => {
    const annotations = new TraceAnnotationStore(redis);
    const base = annotation(1, 100);
    const concurrency = 10;

    const attempts = Array.from({ length: concurrency }, (_, index) => ({
      ...base,
      incidentKey: `incident-race-${index}`,
      evidenceRefs: [`invocation://race-${index}`],
    }));

    const results = await Promise.allSettled(attempts.map((ann) => annotations.append(ann)));
    const created = results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'created').length;
    const conflicts = results.filter(
      (r) => r.status === 'rejected' && String(r.reason?.message ?? '').includes('trace_annotation_conflict'),
    ).length;

    assert.equal(created, 1, 'exactly one concurrent append may create the annotation');
    assert.equal(conflicts, concurrency - 1, 'all losers must be rejected as conflict');

    const window = await annotations.queryMetricWindow('owner-1', 'tool-access-correct-use', countMetric.id, 0, 200);
    assert.equal(window.length, 1, 'only one annotation record may exist');

    // ioredis keys() returns prefixed keys; get() would double-prefix them.
    const keyPrefix = redis.options.keyPrefix ?? '';
    const incidentKeys = (
      await redis.keys(`*trace-annotation-incident:owner-1:tool-access-correct-use:${countMetric.id}:*`)
    ).map((key) => (key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key));
    const values = await Promise.all(incidentKeys.map((key) => redis.get(key)));
    const mappings = values.filter((value) => value === base.annotationId).length;
    assert.equal(mappings, 1, 'only the winner incident key may map to the annotationId');
  });

  it('R13 WRONGTYPE metric index aborts before any durable write', async () => {
    const annotations = new TraceAnnotationStore(redis);
    const ann = annotation(1, 100);
    const metricIndexKey = `trace-annotation-metric-index:owner-1:tool-access-correct-use:${countMetric.id}`;

    await redis.set(metricIndexKey, 'sabotage');
    await assert.rejects(annotations.append(ann), /trace_annotation_preflight_failed:metric_index_wrong_type/);

    const keyPrefix = redis.options.keyPrefix ?? '';
    const allKeys = (await redis.keys('*')).map((key) =>
      key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key,
    );
    assert.deepEqual(
      allKeys.sort(),
      [metricIndexKey].sort(),
      'preflight failure must not leave incident, annotation, canonical, or sequence keys',
    );
  });

  it('R13 incident alias is authoritative for different annotationId', async () => {
    const annotations = new TraceAnnotationStore(redis);
    const ann = annotation(1, 100);

    const first = await annotations.append(ann);
    assert.equal(first.outcome, 'created');

    const sameIncident = {
      ...annotation(2, 200),
      incidentKey: ann.incidentKey,
      annotationId: 'ann-different',
    };
    const second = await annotations.append(sameIncident);
    assert.equal(second.outcome, 'duplicate');
    assert.equal(second.annotationId, ann.annotationId, 'must return the annotationId already bound to the incident');

    const window = await annotations.queryMetricWindow('owner-1', 'tool-access-correct-use', countMetric.id, 0, 300);
    assert.equal(window.length, 1);
    assert.equal(window[0].annotationId, ann.annotationId);

    const differentAnnotation = await redis.get('trace-annotation:ann-different');
    assert.equal(differentAnnotation, null, 'the later annotationId must not be written');
  });

  it('R13 persisted annotation retry is a stable duplicate', async () => {
    const annotations = new TraceAnnotationStore(redis);
    const ann = annotation(1, 100);

    const first = await annotations.append(ann);
    assert.equal(first.outcome, 'created');

    const persisted = await annotations.get(ann.annotationId);
    assert.ok(persisted);
    assert.ok(typeof persisted.sequence === 'number');

    const retry = await annotations.append(persisted);
    assert.equal(retry.outcome, 'duplicate');
    assert.equal(retry.annotationId, ann.annotationId);

    const after = await annotations.get(ann.annotationId);
    assert.equal(after.sequence, persisted.sequence, 'sequence must not advance on stable canonical retry');

    const window = await annotations.queryMetricWindow('owner-1', 'tool-access-correct-use', countMetric.id, 0, 200);
    assert.equal(window.length, 1);
  });

  it('R13 closure rejects a poisoned sequence before claiming the incident', async () => {
    const annotations = new TraceAnnotationStore(redis);
    const ann = annotation(1, 100);
    const sequenceKey = 'harness-annotation-seq:owner-1:tool-access-correct-use';

    await redis.set(sequenceKey, 'not-an-integer');
    await assert.rejects(annotations.append(ann), /trace_annotation_preflight_failed:sequence_value_invalid/);

    assert.equal(
      await redis.get(`trace-annotation-incident:owner-1:tool-access-correct-use:${countMetric.id}:${ann.incidentKey}`),
      null,
      'preflight failure must not claim the incident alias',
    );
    assert.equal(await redis.get(`trace-annotation:${ann.annotationId}`), null);
    assert.equal(await redis.get(sequenceKey), 'not-an-integer', 'preflight must not mutate the poisoned sequence');
  });

  it('R13 closure rejects a non-finite score before entering the Lua write path', async () => {
    const annotations = new TraceAnnotationStore(redis);
    const ann = annotation(1, Number.NaN);

    await assert.rejects(annotations.append(ann), /trace_annotation_invalid_created_at:ann-1/);

    const keyPrefix = redis.options.keyPrefix ?? '';
    const allKeys = (await redis.keys('*')).map((key) =>
      key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key,
    );
    assert.deepEqual(allKeys, [], 'invalid input must not leave any Redis state');
  });

  it('R13 closure never overwrites a legacy annotation without a canonical sidecar', async () => {
    const annotations = new TraceAnnotationStore(redis);
    const original = { ...annotation(1, 100), sequence: 7 };
    const originalJson = JSON.stringify(original);
    const sequenceKey = 'harness-annotation-seq:owner-1:tool-access-correct-use';
    const originalIncidentKey = `trace-annotation-incident:owner-1:tool-access-correct-use:${countMetric.id}:${original.incidentKey}`;

    await redis.set(`trace-annotation:${original.annotationId}`, originalJson);
    await redis.set(originalIncidentKey, original.annotationId);
    await redis.set(sequenceKey, '7');

    const retry = await annotations.append(original);
    assert.deepEqual(retry, { outcome: 'duplicate', annotationId: original.annotationId });

    const conflicting = {
      ...annotation(2, 200),
      annotationId: original.annotationId,
      incidentKey: 'incident-new-producer',
    };
    await assert.rejects(annotations.append(conflicting), /trace_annotation_conflict:ann-1/);

    assert.equal(await redis.get(`trace-annotation:${original.annotationId}`), originalJson);
    assert.equal(await redis.get(sequenceKey), '7', 'conflict must not advance the sequence');
    assert.equal(
      await redis.get(
        `trace-annotation-incident:owner-1:tool-access-correct-use:${countMetric.id}:${conflicting.incidentKey}`,
      ),
      null,
      'conflict must roll back the newly claimed incident alias',
    );
  });

  it('R13 closure canonicalization preserves valid JSON when an optional field is undefined', async () => {
    const annotations = new TraceAnnotationStore(redis);
    const ann = { ...annotation(1, 100), rationale: undefined };

    const result = await annotations.append(ann);
    assert.equal(result.outcome, 'created');

    const persisted = await annotations.get(ann.annotationId);
    assert.ok(persisted, 'stored annotation must remain valid JSON');
    assert.equal(
      Object.hasOwn(persisted, 'rationale'),
      false,
      'undefined optional fields follow JSON omission semantics',
    );
    const window = await annotations.queryMetricWindow('owner-1', 'tool-access-correct-use', countMetric.id, 0, 200);
    assert.equal(window.length, 1);
  });
});
