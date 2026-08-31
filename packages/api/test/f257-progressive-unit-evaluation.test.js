import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FakeRedis } from './helpers/fake-redis.js';

const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
const { EvaluationScheduler } = await import('../dist/infrastructure/harness-eval/evaluation/EvaluationScheduler.js');
const { EvaluationSnapshotStore } = await import(
  '../dist/infrastructure/harness-eval/evaluation/EvaluationSnapshotStore.js'
);
const { EvaluatorRunner } = await import('../dist/infrastructure/harness-eval/evaluation/evaluator-runner.js');
const { ObjectiveEvaluationRuntime } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js'
);
const { UnitSemanticEvaluationCoordinator } = await import(
  '../dist/infrastructure/harness-eval/evaluation/UnitSemanticEvaluationCoordinator.js'
);
const { UnitSemanticEvaluationJobStore } = await import(
  '../dist/infrastructure/harness-eval/evaluation/UnitSemanticEvaluationJobStore.js'
);
const { TraceAnnotationStore } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js'
);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function episode(index, segmentId = 'S13', terminalAt = 1_000 + index, statusOverride) {
  const isObserved = statusOverride ? statusOverride === 'observed' : index % 2 === 0;
  return {
    summary: {
      turnId: `turn-${index}`,
      threadId: `thread-${index % 3}`,
      catId: 'cat-1',
      timestamp: terminalAt - 10,
      segments: [
        {
          segmentId,
          stage: 'per-turn',
          status: isObserved ? 'observed' : 'absent',
          contentHash: isObserved ? `hash-${index}` : null,
          charCount: isObserved ? 10 : 0,
          tokenEstimate: isObserved ? 3 : 0,
          pipelineStatus: isObserved ? 'fired' : 'skipped',
        },
      ],
      delivery: [],
      totalCharCount: isObserved ? 10 : 0,
      totalTokenEstimate: isObserved ? 3 : 0,
      totalSegmentsObserved: isObserved ? 1 : 0,
      totalSegmentsAbsent: isObserved ? 0 : 1,
      durationMs: 1,
    },
    terminal: {
      traceTurnId: `turn-${index}`,
      invocationId: `inv-${index}`,
      ownerUserId: 'owner-1',
      threadId: `thread-${index % 3}`,
      catId: 'cat-1',
      inputMessageId: `input-${index}`,
      outputMessageId: `output-${index}`,
      terminalAt,
      terminalKind: 'completed',
      toolCalls: [],
    },
  };
}

function annotation(index, polarity = 'counterexample') {
  return {
    annotationId: `ann-${index}`,
    episodeRef: episode(index).terminal,
    source: 'structured-rule',
    ruleId: 'tool-choice-signal',
    objectiveId: 'tool-access-correct-use',
    metricId: 'tool-choice-correctness',
    unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
    polarity,
    confidence: 1,
    incidentKey: `incident-${index}`,
    evidenceRefs: [`invocation://inv-${index}`],
    rationale: `signal-${index}`,
    createdAt: 1_000 + index,
  };
}

const semanticModel = {
  id: 'em-tool',
  label: 'Tool evaluation',
  ruleVersion: 'v2',
  metrics: [
    {
      id: 'tool-choice-correctness',
      label: 'Tool choice correctness',
      kind: 'semantic',
      evaluator: { kind: 'llm', ruleRef: 'tool-choice-correctness-semantic' },
      trigger: { kind: 'cadence', cadence: 'weekly' },
    },
  ],
};

const unitRefs = [{ unitType: 'segment', unitId: 'S13' }];

describe('F257 progressive Unit evaluation evidence contract', () => {
  test('stale scheduler cleanup cannot delete a newer pending Unit generation', async () => {
    const redis = new FakeRedis();
    const snapshots = new EvaluationSnapshotStore(redis);
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
    const observed = await snapshots.getPendingUnitRun('owner-1', 'tool-access-correct-use');
    assert.deepEqual(observed, stale);

    // Another scheduler clears the stale row and claims the current generation
    // before this worker reaches its cleanup call.
    await redis.set(key, JSON.stringify(current));
    const cleared = await snapshots.clearPending('owner-1', 'tool-access-correct-use', observed);

    assert.equal(cleared, false, 'cleanup must be compare-and-delete, never unconditional DEL');
    assert.deepEqual(await snapshots.getPendingUnitRun('owner-1', 'tool-access-correct-use'), current);
  });

  test('classified episodes remain in the shared owner corpus and Unit filtering includes absent opportunities', async () => {
    const redis = new FakeRedis();
    const traces = new InjectionTraceStore(redis);

    for (const item of [episode(1, 'S13'), episode(2, 'S13'), episode(3, 'S12')]) {
      await traces.persist(item.summary, { ...item.summary });
      await traces.closeEpisode(item.terminal);
    }
    await traces.markEpisodeClassified('owner-1', 'inv-1');

    const corpus = await traces.queryUnitWindow('owner-1', unitRefs, 0, 10_000);
    assert.deepEqual(
      corpus.map((item) => ({ invocationId: item.terminal.invocationId, status: item.summary.segments[0].status })),
      [
        { invocationId: 'inv-1', status: 'absent' },
        { invocationId: 'inv-2', status: 'observed' },
      ],
    );
  });

  test('raw tracing volume freezes a replayable Unit corpus without requiring any annotation', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const snapshots = new EvaluationSnapshotStore(redis);
    const raw = Array.from({ length: 200 }, (_, index) => episode(index + 1, 'S13', undefined, 'observed'));
    const traces = {
      async queryUnitWindow(ownerUserId, refs, startMs, endMs) {
        assert.equal(ownerUserId, 'owner-1');
        assert.deepEqual(refs, unitRefs);
        return raw.filter((item) => item.terminal.terminalAt >= startMs && item.terminal.terminalAt < endMs);
      },
      async countSegmentWindow(_ownerUserId, _segmentId, startMs, endMs) {
        return raw.filter((item) => item.terminal.terminalAt >= startMs && item.terminal.terminalAt < endMs).length;
      },
    };
    const scheduler = new EvaluationScheduler({ annotations, snapshots, traces });

    const scheduled = await scheduler.schedule({
      ownerUserId: 'owner-1',
      objectiveId: 'tool-access-correct-use',
      evaluationModel: semanticModel,
      unitRefs,
      now: 10_000,
    });

    assert.equal(scheduled.status, 'queued');
    assert.equal(scheduled.snapshot.samples.length, 0, 'annotations are optional retrieval hints');
    assert.equal(scheduled.snapshot.traceCorpus.length, 200);
    assert.equal(scheduled.snapshot.episodeRefs.length, 200);
    assert.deepEqual(
      scheduled.snapshot.traceCorpus.map((item) => item.terminal.invocationId),
      scheduled.snapshot.episodeRefs.map((item) => item.invocationId),
    );
  });

  test('weekly cadence starts from the Unit first eligible trace and does not fire immediately', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const snapshots = new EvaluationSnapshotStore(redis);
    const traces = {
      queryUnitWindow: async () => [episode(1, 'S13', 1_000, 'observed')],
      countSegmentWindow: async (_o, _s, _start, _end) => 1,
    };
    const scheduler = new EvaluationScheduler({ annotations, snapshots, traces });

    assert.deepEqual(
      await scheduler.schedule({
        ownerUserId: 'owner-1',
        objectiveId: 'tool-access-correct-use',
        evaluationModel: semanticModel,
        unitRefs,
        now: 1_000 + WEEK_MS - 1,
      }),
      { status: 'not-due', nextDueAt: 1_000 + WEEK_MS },
    );
    assert.equal(
      (
        await scheduler.schedule({
          ownerUserId: 'owner-1',
          objectiveId: 'tool-access-correct-use',
          evaluationModel: semanticModel,
          unitRefs,
          now: 1_000 + WEEK_MS,
        })
      ).status,
      'queued',
    );
  });

  test('durable first-trace baseline prevents a sliding raw window from starving cadence', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const snapshots = new EvaluationSnapshotStore(redis);
    let raw = [episode(1, 'S13', 1_000)];
    const scheduler = new EvaluationScheduler({
      annotations,
      snapshots,
      traces: { queryUnitWindow: async () => raw, countSegmentWindow: async (_o, _s, _start, _end) => raw.length },
    });

    assert.equal(
      (
        await scheduler.schedule({
          ownerUserId: 'owner-1',
          objectiveId: 'tool-access-correct-use',
          evaluationModel: semanticModel,
          unitRefs,
          now: 1_001,
        })
      ).status,
      'not-due',
    );

    raw = [episode(2, 'S13', 1_000 + 2 * WEEK_MS)];
    assert.equal(
      (
        await scheduler.schedule({
          ownerUserId: 'owner-1',
          objectiveId: 'tool-access-correct-use',
          evaluationModel: semanticModel,
          unitRefs,
          now: 1_001 + 2 * WEEK_MS,
        })
      ).status,
      'queued',
      'cadence remains anchored to the first observed Unit trace, not the moving 7-day window',
    );
  });

  test('semantic evaluator must inspect frozen traces; structured counterexamples are retrieval priority, not admission', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const snapshots = new EvaluationSnapshotStore(redis);
    const raw = [episode(1), episode(2), episode(3), episode(4)];
    await annotations.append(annotation(3));
    const scheduler = new EvaluationScheduler({
      annotations,
      snapshots,
      traces: { queryUnitWindow: async () => raw, countSegmentWindow: async (_o, _s, _start, _end) => raw.length },
    });
    const scheduled = await scheduler.schedule({
      ownerUserId: 'owner-1',
      objectiveId: 'tool-access-correct-use',
      evaluationModel: semanticModel,
      unitRefs,
      now: 1_001 + WEEK_MS,
    });
    assert.equal(scheduled.status, 'queued');

    const withoutSemantic = new EvaluatorRunner();
    assert.equal(withoutSemantic.canRun(semanticModel.metrics[0]), false);
    await assert.rejects(
      withoutSemantic.run(scheduled.snapshot, semanticModel.metrics[0], 1_000 + WEEK_MS),
      /semantic_evaluator_unavailable/,
    );

    const inspected = [];
    const runner = new EvaluatorRunner({
      semantic: {
        async evaluate({ retrieval }) {
          const first = retrieval.take(1);
          inspected.push(...first.episodes.map((item) => item.terminal.invocationId));
          const second = retrieval.take(2);
          inspected.push(...second.episodes.map((item) => item.terminal.invocationId));
          return {
            labels: { acceptable: 2, counterexample: 1 },
            explanation: 'One tool choice contradicted the requested capability.',
          };
        },
      },
    });
    const result = await runner.run(scheduled.snapshot, semanticModel.metrics[0], 1_001 + WEEK_MS + 1);

    assert.deepEqual(inspected, ['inv-3', 'inv-1', 'inv-2']);
    assert.deepEqual(result.value.retrieval, {
      frozenCorpusSize: 4,
      inspectedInvocationIds: ['inv-3', 'inv-1', 'inv-2'],
      priorityAnchorIds: ['inv-3'],
      exhausted: false,
    });
  });

  test('eval cat progressively retrieves an exact pending Unit and authenticated submit resumes atomic commit', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const raw = Array.from({ length: 200 }, (_, index) => episode(index + 1, 'S13', undefined, 'observed'));
    const catalog = {
      registry: {
        registryVersion: 2,
        evaluationModels: [semanticModel],
        objectives: [
          {
            id: 'tool-access-correct-use',
            label: 'Tool access',
            statement: 'Choose tools that match the task.',
            evaluationModelId: semanticModel.id,
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
    const runtime = new ObjectiveEvaluationRuntime(redis, catalog, annotations, {
      traceStore: { queryUnitWindow: async () => raw, countSegmentWindow: async (_o, _s, _start, _end) => raw.length },
    });
    await annotations.append(annotation(3));
    assert.equal(
      await runtime.scheduleTraceVolume('owner-1', 10_000),
      1,
      'semantic Unit reports a pending eval-cat job so the terminal seam can wake it immediately',
    );
    assert.ok(await runtime.snapshots.getPendingUnitRun('owner-1', 'tool-access-correct-use'));
    assert.equal(
      await runtime.scheduleTraceVolume('owner-1', 10_001),
      0,
      'an existing pending Unit is not reported as a fresh eval-cat dispatch',
    );

    let contextRevision = 'v1';
    let clock = 10_001;
    const jobStore = new UnitSemanticEvaluationJobStore(redis);
    const coordinator = new UnitSemanticEvaluationCoordinator({
      runtime,
      jobStore,
      hydrateContext: async (item) => ({
        episode: item,
        inputText: `${contextRevision}:input:${item.terminal.invocationId}`,
        outputText: `output:${item.terminal.invocationId}`,
        contextMessages: [],
      }),
      now: () => clock,
    });
    const packets = await coordinator.prepare({
      ownerUserId: 'owner-1',
      evaluatorCatId: 'cat-eval',
      now: 10_001,
      initialBatchSize: 1,
    });
    assert.equal(packets.length, 1);
    assert.deepEqual(
      packets[0].initialRetrieval.episodes.map((item) => item.invocationId),
      ['inv-3'],
      'structured counterexample is first but does not shrink the 200-trace corpus',
    );
    assert.equal(packets[0].frozenCorpusSize, 200);

    contextRevision = 'v2';
    await assert.rejects(
      coordinator.retrieve(
        { ownerUserId: 'owner-1', evaluatorCatId: 'cat-eval' },
        { jobId: packets[0].jobId, cursor: 0, limit: 25 },
      ),
      /unit_semantic_evidence_changed/,
    );
    const initialReceipt = await jobStore.getReceipt(packets[0].jobId, 0);
    assert.ok(initialReceipt);
    assert.equal(initialReceipt.evidenceDigests.length, 1);
    assert.equal('episodes' in initialReceipt, false, 'the ledger never persists a shadow copy of message text');

    await assert.rejects(
      coordinator.retrieve(
        { ownerUserId: 'owner-1', evaluatorCatId: 'wrong-cat' },
        { jobId: packets[0].jobId, cursor: 1, limit: 2 },
      ),
      /unit_semantic_principal_mismatch/,
    );
    const next = await coordinator.retrieve(
      { ownerUserId: 'owner-1', evaluatorCatId: 'cat-eval' },
      { jobId: packets[0].jobId, cursor: 1, limit: 2 },
    );
    assert.deepEqual(
      next.episodes.map((item) => item.invocationId),
      ['inv-1', 'inv-2'],
    );
    assert.equal(next.nextCursor, 3);

    const completeJob = jobStore.complete.bind(jobStore);
    let failCompletionReceipt = true;
    jobStore.complete = async (...args) => {
      if (failCompletionReceipt) {
        failCompletionReceipt = false;
        throw new Error('simulated_crash_after_unit_commit');
      }
      return completeJob(...args);
    };
    clock = 20_000;
    await assert.rejects(
      coordinator.submit(
        { ownerUserId: 'owner-1', evaluatorCatId: 'cat-eval' },
        {
          jobId: packets[0].jobId,
          labels: { acceptable: 2, counterexample: 1 },
          explanation: 'The priority trace chose an incompatible tool; two neighboring traces were sound.',
        },
      ),
      /simulated_crash_after_unit_commit/,
    );
    clock = 21_000;
    const submitted = await coordinator.submit(
      { ownerUserId: 'owner-1', evaluatorCatId: 'cat-eval' },
      {
        jobId: packets[0].jobId,
        labels: { acceptable: 2, counterexample: 1 },
        explanation: 'The priority trace chose an incompatible tool; two neighboring traces were sound.',
      },
    );
    assert.equal(submitted.unitCompleted, true);
    assert.equal(submitted.inspectedCount, 3);
    assert.equal(submitted.exhausted, false);

    const judgment = await runtime.judgments.latest('owner-1', 'tool-access-correct-use');
    assert.equal(judgment?.completion, 'complete');
    assert.equal(
      judgment?.evaluatedAt,
      20_000,
      'retry reuses actual first completion time after Unit commit / job receipt crash',
    );
    assert.deepEqual(judgment?.metricResults[0].value.retrieval, {
      frozenCorpusSize: 200,
      inspectedInvocationIds: ['inv-3', 'inv-1', 'inv-2'],
      priorityAnchorIds: ['inv-3'],
      exhausted: false,
    });
    assert.equal(await runtime.snapshots.getPendingUnitRun('owner-1', 'tool-access-correct-use'), null);

    const completedSnapshot = await runtime.snapshots.latestCompleted('owner-1', 'tool-access-correct-use');
    assert.ok(completedSnapshot);
    const laterSnapshot = {
      ...completedSnapshot,
      snapshotId: 'snapshot-later',
      createdAt: completedSnapshot.createdAt + 1,
      maxAnnotationScore: completedSnapshot.maxAnnotationScore + 1,
    };
    await runtime.snapshots.append(laterSnapshot);
    await runtime.snapshots.markCompleted(laterSnapshot, 22_000);
    const replayed = await coordinator.submit(
      { ownerUserId: 'owner-1', evaluatorCatId: 'cat-eval' },
      {
        jobId: packets[0].jobId,
        labels: { acceptable: 2, counterexample: 1 },
        explanation: 'The priority trace chose an incompatible tool; two neighboring traces were sound.',
      },
    );
    assert.equal(
      replayed.unitCompleted,
      true,
      'an old job replays its original terminal response after a later Unit becomes latest',
    );
  });
});
