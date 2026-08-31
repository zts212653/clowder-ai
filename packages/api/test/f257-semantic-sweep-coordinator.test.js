import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { ObjectiveEvaluationRuntime } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js'
);
const { SemanticSweepCoordinator } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/SemanticSweepCoordinator.js'
);
const { SemanticSweepJobStore } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/SemanticSweepJobStore.js'
);
const { TraceAnnotationStore } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js'
);
const { handleSubmitSemanticSweep } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/submit-semantic-sweep.js'
);

class FakeRedis {
  constructor() {
    this.strings = new Map();
    this.sets = new Map();
    this.zsets = new Map();
  }

  async set(key, value, ...args) {
    if (args.includes('NX') && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }

  async get(key) {
    return this.strings.get(key) ?? null;
  }

  async incr(key) {
    const current = this.strings.has(key) ? Number(this.strings.get(key)) : 0;
    if (!Number.isFinite(current)) throw new Error(`fake_redis_incr_not_integer:${key}`);
    const next = current + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async sadd(key, ...members) {
    const set = this.sets.get(key) ?? new Set();
    for (const member of members) set.add(member);
    this.sets.set(key, set);
    return members.length;
  }

  async smembers(key) {
    return [...(this.sets.get(key) ?? new Set())];
  }

  async zadd(key, score, member) {
    const zset = this.zsets.get(key) ?? new Map();
    zset.set(member, Number(score));
    this.zsets.set(key, zset);
    return 1;
  }

  async zrangebyscore(key, min, max) {
    const minExclusive = String(min).startsWith('(');
    const maxExclusive = String(max).startsWith('(');
    const minScore = Number(String(min).replace(/^\(/, ''));
    const maxScore = Number(String(max).replace(/^\(/, ''));
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .filter(([, score]) => {
        if (minExclusive ? score <= minScore : score < minScore) return false;
        if (maxExclusive ? score >= maxScore : score > maxScore) return false;
        return true;
      })
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member);
  }

  async zrem(key, member) {
    return this.zsets.get(key)?.delete(member) ? 1 : 0;
  }

  async zrevrange(key, start, end) {
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
      .slice(start, end + 1)
      .map(([member]) => member);
  }
}

function episode(index) {
  return {
    summary: {
      turnId: `turn-${index}`,
      threadId: 'thread-source',
      catId: 'cat-subject',
      timestamp: 100 + index,
      segments: [],
      delivery: [],
      totalCharCount: 0,
      totalTokenEstimate: 0,
      totalSegmentsObserved: 0,
      totalSegmentsAbsent: 0,
      durationMs: 0,
    },
    terminal: {
      traceTurnId: `turn-${index}`,
      invocationId: `inv-${index}`,
      ownerUserId: 'owner-1',
      threadId: 'thread-source',
      catId: 'cat-subject',
      inputMessageId: `input-${index}`,
      outputMessageId: `output-${index}`,
      terminalAt: 200 + index,
      terminalKind: 'completed',
      toolCalls: [],
    },
  };
}

const metric = {
  id: 'unsupported-external-claim-count',
  label: '关键外部断言缺少有效证据次数',
  kind: 'counter',
  evaluator: { kind: 'code', ruleRef: 'count-unsupported-external-claims' },
  trigger: { kind: 'distinct-counterexamples', threshold: 1 },
};

const catalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [{ id: 'em-evidence', label: 'Evidence', ruleVersion: 'v1', metrics: [metric] }],
    objectives: [
      {
        id: 'knowledge-evidence-quality',
        label: 'Evidence',
        statement: 'Ground claims',
        evaluationModelId: 'em-evidence',
      },
    ],
  },
  manifest: {
    manifestVersion: 1,
    registryVersion: 2,
    units: [
      {
        unitId: 'D20',
        hookId: 'd20-signal-article',
        unitState: 'evaluable',
        objectives: [{ objectiveId: 'knowledge-evidence-quality' }],
      },
    ],
  },
};

describe('F257 semantic sweep coordinator', () => {
  test('freezes trace refs and accepts classifications only from the assigned eval cat', async () => {
    const redis = new FakeRedis();
    const episodes = new Map([
      ['inv-1', episode(1)],
      ['inv-2', episode(2)],
    ]);
    const unclassified = new Set(episodes.keys());
    const traceStore = {
      async listUnclassifiedInvocationIds() {
        return [...unclassified];
      },
      async getEpisodeByInvocationId(invocationId) {
        return episodes.get(invocationId) ?? null;
      },
      async markEpisodeClassified(_ownerUserId, invocationId) {
        unclassified.delete(invocationId);
      },
    };
    const annotations = new TraceAnnotationStore(redis);
    const runtime = new ObjectiveEvaluationRuntime(redis, catalog, annotations);
    const coordinator = new SemanticSweepCoordinator({
      traceStore,
      jobStore: new SemanticSweepJobStore(redis),
      annotationSink: runtime,
      catalog,
      async hydrateContext(item) {
        return {
          episode: item,
          inputText: `input:${item.terminal.inputMessageId}`,
          outputText: `output:${item.terminal.outputMessageId}`,
        };
      },
    });

    const prepared = await coordinator.prepare({
      ownerUserId: 'owner-1',
      evaluatorCatId: 'cat-eval',
      startMs: 0,
      endMs: 1000,
    });
    assert.ok(prepared);
    assert.deepEqual(
      prepared.packet.episodes.map((item) => item.invocationId),
      ['inv-1', 'inv-2'],
    );
    assert.equal(prepared.packet.episodes[0].outputText, 'output:output-1');

    const decisions = [
      {
        invocationId: 'inv-1',
        status: 'matched',
        matches: [
          {
            objectiveId: 'knowledge-evidence-quality',
            metricId: metric.id,
            unitRefs: [{ unitType: 'segment', unitId: 'D20' }],
            polarity: 'counterexample',
            confidence: 0.9,
            explanation: 'The answer makes an external claim without a source.',
          },
        ],
      },
      { invocationId: 'inv-2', status: 'irrelevant', matches: [] },
    ];

    await assert.rejects(
      coordinator.submit(
        { ownerUserId: 'owner-1', evaluatorCatId: 'cat-wrong' },
        { jobId: prepared.packet.jobId, decisions },
      ),
      /semantic_sweep_principal_mismatch/,
    );
    await assert.rejects(
      coordinator.submit(
        { ownerUserId: 'owner-1', evaluatorCatId: 'cat-eval' },
        {
          jobId: prepared.packet.jobId,
          decisions: [{ invocationId: 'inv-not-frozen', status: 'irrelevant', matches: [] }],
        },
      ),
      /semantic_sweep_unknown_invocation/,
    );

    assert.equal(
      (await handleSubmitSemanticSweep(coordinator, { userId: 'owner-1', catId: 'cat-eval' }, {})).status,
      400,
    );
    assert.equal(
      (
        await handleSubmitSemanticSweep(
          coordinator,
          { userId: 'owner-1', catId: 'cat-wrong' },
          { jobId: prepared.packet.jobId, decisions },
        )
      ).status,
      403,
    );

    const accepted = await handleSubmitSemanticSweep(
      coordinator,
      { userId: 'owner-1', catId: 'cat-eval' },
      { jobId: prepared.packet.jobId, decisions },
    );
    assert.equal(accepted.status, 200);
    const submitted = { selected: 2, classified: 2, annotations: 1 };
    assert.deepEqual(accepted.body, {
      outcome: 'accepted',
      jobId: prepared.packet.jobId,
      ...submitted,
    });
    assert.deepEqual(submitted, { selected: 2, classified: 2, annotations: 1 });
    assert.deepEqual([...unclassified], []);
    const results = await runtime.results.queryMetricWindow(
      'owner-1',
      'knowledge-evidence-quality',
      metric.id,
      0,
      Date.now() + 1,
    );
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].value, { kind: 'counter', count: 1, threshold: 1 });

    assert.deepEqual(
      await coordinator.submit(
        { ownerUserId: 'owner-1', evaluatorCatId: 'cat-eval' },
        { jobId: prepared.packet.jobId, decisions },
      ),
      { ...submitted, alreadyCompleted: true },
    );
    assert.equal(
      (
        await handleSubmitSemanticSweep(
          coordinator,
          { userId: 'owner-1', catId: 'cat-eval' },
          {
            jobId: prepared.packet.jobId,
            decisions: [
              {
                invocationId: 'inv-1',
                status: 'irrelevant',
                matches: [],
              },
            ],
          },
        )
      ).status,
      409,
    );
  });
});
