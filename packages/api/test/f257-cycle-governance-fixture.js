import assert from 'node:assert/strict';

const { CycleEvaluationCoordinator } = await import(
  '../dist/infrastructure/harness-eval/evaluation/CycleEvaluationCoordinator.js'
);
const { CycleRecordStore } = await import('../dist/infrastructure/harness-eval/evaluation/CycleRecordStore.js');
const { CycleGovernanceCoordinator, GOVERNANCE_REMINDER_INTERVAL_MS } = await import(
  '../dist/infrastructure/harness-eval/governance/CycleGovernanceCoordinator.js'
);
const { HarnessGovernanceProposalStore } = await import(
  '../dist/infrastructure/harness-eval/governance/HarnessGovernanceProposalStore.js'
);

class FakeRedis {
  strings = new Map();
  hashes = new Map();
  sets = new Map();
  zsets = new Map();

  async get(key) {
    return this.strings.get(key) ?? null;
  }
  async set(key, value, ...args) {
    if (args.includes('NX') && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }
  async del(key) {
    return this.strings.delete(key) ? 1 : 0;
  }
  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hset(key, field, value) {
    const values = this.hashes.get(key) ?? new Map();
    values.set(field, value);
    this.hashes.set(key, values);
    return 1;
  }
  async sadd(key, ...members) {
    const values = this.sets.get(key) ?? new Set();
    for (const member of members) values.add(member);
    this.sets.set(key, values);
    return members.length;
  }
  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }
  async zadd(key, score, member) {
    const values = this.zsets.get(key) ?? new Map();
    values.set(member, Number(score));
    this.zsets.set(key, values);
    return 1;
  }
  async zrevrange(key, start, end) {
    const ordered = [...(this.zsets.get(key) ?? new Map()).entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([member]) => member);
    return ordered.slice(start, end < 0 ? undefined : end + 1);
  }
  async eval(_script, keyCount, ...args) {
    if (keyCount === 1) {
      const [key, token] = args;
      if (this.strings.get(key) !== token) return 0;
      this.strings.delete(key);
      return 1;
    }
    const [
      currentKey,
      historyKey,
      historyIndexKey,
      expectedCycleId,
      expectedStatus,
      replacement,
      mode,
      closedAt,
      next,
    ] = args;
    const current = JSON.parse(this.strings.get(currentKey) ?? 'null');
    if (current?.cycleId !== expectedCycleId || current.evalStatus !== expectedStatus) return 0;
    if (mode === 'advance') {
      this.strings.set(historyKey, replacement);
      await this.zadd(historyIndexKey, closedAt, expectedCycleId);
      this.strings.set(currentKey, next);
    } else {
      this.strings.set(currentKey, replacement);
    }
    return 1;
  }
}

class FakeThreadStore {
  threads = new Map();
  async get(id) {
    return this.threads.get(id) ?? null;
  }
  async ensureThread(id, title) {
    if (!this.threads.has(id)) this.threads.set(id, { id, title, participants: [], preferredCats: [] });
    return this.threads.get(id);
  }
  async updateSystemKind(id, systemKind) {
    this.threads.get(id).systemKind = systemKind;
  }
  async indexForUser() {}
  async updateTitle(id, title) {
    this.threads.get(id).title = title;
  }
  async restore(id) {
    delete this.threads.get(id).deletedAt;
  }
  async updatePreferredCats(id, cats) {
    this.threads.get(id).preferredCats = cats;
  }
  async addParticipants(id, cats) {
    this.threads.get(id).participants = [...new Set([...this.threads.get(id).participants, ...cats])];
  }
}

const catalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [
      {
        id: 'model-1',
        label: 'Model',
        ruleVersion: 'v1',
        cycleTrigger: { cumulativeThreshold: 3, counterexampleThreshold: 2, cadenceDays: 7, minimumIntervalMs: 1 },
        metrics: [
          {
            id: 'metric-a',
            label: 'Metric A',
            kind: 'counter',
            evaluator: { kind: 'code', ruleRef: 'rule-a' },
            trigger: { kind: 'distinct-counterexamples', threshold: 2 },
            verdictRule: { kind: 'counter-zero' },
          },
        ],
      },
    ],
    objectives: [
      { id: 'obj', label: 'Objective', statement: 'Keep the behavior sound.', evaluationModelId: 'model-1' },
    ],
  },
  manifest: {
    manifestVersion: 1,
    registryVersion: 2,
    units: [
      { unitId: 'D1', hookId: 'different-asset-slug', unitState: 'evaluable', objectives: [{ objectiveId: 'obj' }] },
    ],
  },
};

const principal = { userId: 'owner-1', catId: 'cat-default', threadId: 'thread_eval_f257_obj' };

async function harness() {
  const clock = { now: 2_000 };
  const redis = new FakeRedis();
  const cycles = new CycleRecordStore(redis);
  const idle = await cycles.initialize('owner-1', 'obj', 0, { version: 'v1', versionContentRef: 'hooks:D1@1' });
  const requested = {
    ...idle,
    cycleEnd: 1_000,
    evalStatus: 'requested',
    windows: [{ start: 0, end: 1_000 }],
    triggeredBy: ['cumulative'],
  };
  assert.equal(await cycles.request(idle, requested), true);
  const runtime = {
    catalog,
    cycles,
    annotations: {
      async queryMetricWindow() {
        return [];
      },
    },
    traces: {
      async ownerInvocationIds() {
        return [];
      },
      async getEpisodeByInvocationId() {
        return null;
      },
    },
    cycleChecker: {
      setRequestedHandler(handler) {
        this.handler = handler;
      },
    },
  };
  const threadStore = new FakeThreadStore();
  const deliveries = [];
  const deliveredByKey = new Map();
  const evaluation = new CycleEvaluationCoordinator({
    runtime,
    threadStore,
    messageStore: {
      async getByIds() {
        return [];
      },
    },
    async deliver(input) {
      const previous = deliveredByKey.get(input.idempotencyKey);
      if (previous) return previous;
      const id = `message-${deliveries.length + 1}`;
      deliveries.push({ id, ...input });
      deliveredByKey.set(input.idempotencyKey, id);
      return id;
    },
    getInvokeTrigger: () => ({
      async trigger() {
        return 'dispatched';
      },
    }),
    getDefaultCatId: () => 'cat-default',
    now: () => clock.now,
  });
  const proposals = new HarnessGovernanceProposalStore(redis);
  const applied = [];
  const executor = {
    async hydrate(_objectiveId, input) {
      if (input.decision === 'keep') return [];
      if (input.decision === 'rollback') {
        return [
          {
            action: 'rollback',
            unitId: 'D1',
            hookId: 'D1',
            reason: input.reason,
            sourceVersion: 2,
            targetVersion: 1,
            beforeContent: 'v2 body',
            targetContent: 'v1 body',
          },
        ];
      }
      return [
        {
          action: 'modify',
          unitId: 'D1',
          hookId: 'D1',
          reason: input.v2Draft.changes[0].reason,
          sourceVersion: 1,
          beforeContent: 'v1 body',
          proposedContent: input.v2Draft.changes[0].proposedContent,
        },
      ];
    },
    async apply(proposal, actorId, reason) {
      applied.push({ proposal, actorId, reason });
      return { version: 'v2', versionContentRef: 'hooks:D1@2' };
    },
    async currentVersion() {
      return { version: 'v1', versionContentRef: 'hooks:D1@1' };
    },
  };
  let quiescent = true;
  const governance = new CycleGovernanceCoordinator({
    runtime,
    evaluation,
    proposals,
    executor,
    isThreadQuiescent: async () => quiescent,
    now: () => clock.now,
  });
  return {
    clock,
    cycles,
    evaluation,
    governance,
    proposals,
    deliveries,
    applied,
    setQuiescent(value) {
      quiescent = value;
    },
  };
}

const evaluationSubmission = (cycleId) => ({
  objectiveId: 'obj',
  cycleId,
  metrics: [{ id: 'metric-a', conclusion: { kind: 'count', value: 0, howCounted: 'window scan' }, evidenceRefs: [] }],
  overall: 'complete',
  counterexampleRootCauses: { eventCount: 0, rootCauseCount: 0, howGrouped: 'No counterexamples.' },
  coverageAssessment: { status: 'adequate', rationale: 'No coverage gap observed.', findings: [] },
});

async function writeEvaluation(context) {
  const current = await context.cycles.current('owner-1', 'obj');
  return context.evaluation.submitEvaluation(principal, evaluationSubmission(current.cycleId));
}

export { GOVERNANCE_REMINDER_INTERVAL_MS, harness, principal, writeEvaluation };
