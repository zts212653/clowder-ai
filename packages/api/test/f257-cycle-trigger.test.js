import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { CycleRecordStore } = await import('../dist/infrastructure/harness-eval/evaluation/CycleRecordStore.js');
const { CycleTriggerChecker } = await import('../dist/infrastructure/harness-eval/evaluation/CycleTriggerChecker.js');
const { ManualVersionCycleService } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ManualVersionCycleService.js'
);

class FakeRedis {
  strings = new Map();
  sets = new Map();
  zsets = new Map();

  async get(key) {
    return this.strings.get(key) ?? null;
  }

  async set(key, value, mode) {
    if (mode === 'NX' && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }

  async sadd(key, ...members) {
    const set = this.sets.get(key) ?? new Set();
    for (const member of members) set.add(member);
    this.sets.set(key, set);
    return members.length;
  }

  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }

  async zadd(key, score, member) {
    const entries = this.zsets.get(key) ?? new Map();
    entries.set(member, Number(score));
    this.zsets.set(key, entries);
    return 1;
  }

  async zrevrange(key, start, end) {
    const ordered = [...(this.zsets.get(key) ?? new Map()).entries()]
      .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))
      .map(([member]) => member);
    return ordered.slice(start, end < 0 ? undefined : end + 1);
  }

  async zrange(key, start, end, withScores) {
    const ordered = [...(this.zsets.get(key) ?? new Map()).entries()].sort(
      (left, right) => left[1] - right[1] || left[0].localeCompare(right[0]),
    );
    const selected = ordered.slice(start, end < 0 ? undefined : end + 1);
    return withScores === 'WITHSCORES'
      ? selected.flatMap(([member, score]) => [member, String(score)])
      : selected.map(([member]) => member);
  }

  async zcount(key, start, end) {
    return [...(this.zsets.get(key) ?? new Map()).values()].filter(
      (score) => score >= Number(start) && score <= Number(end),
    ).length;
  }

  async eval(
    _script,
    _keyCount,
    currentKey,
    historyKey,
    historyIndexKey,
    expectedCycleId,
    expectedStatus,
    replacement,
    mode,
    closedAt,
    next,
  ) {
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

const DAY = 24 * 60 * 60 * 1000;
const model = (overrides = {}) => ({
  id: 'em-obj',
  label: 'Objective model',
  ruleVersion: 'v1',
  cycleTrigger: {
    cumulativeThreshold: 3,
    counterexampleThreshold: 2,
    cadenceDays: 7,
    minimumIntervalMs: 2 * 60 * 60 * 1000,
    ...overrides,
  },
  metrics: [
    {
      id: 'metric-a',
      label: 'Metric A',
      kind: 'counter',
      evaluator: { kind: 'code', ruleRef: 'metric-a' },
      trigger: { kind: 'distinct-counterexamples', threshold: 2 },
      verdictRule: { kind: 'counter-zero' },
    },
  ],
});

function catalog(cycleModel = model()) {
  return {
    registry: {
      registryVersion: 2,
      evaluationModels: [cycleModel],
      objectives: [{ id: 'obj', label: 'Objective', statement: 'Do the thing', evaluationModelId: cycleModel.id }],
    },
    manifest: {
      manifestVersion: 1,
      registryVersion: 2,
      units: [
        {
          unitId: 'D1',
          hookId: 'd1-test',
          unitState: 'evaluable',
          objectives: [{ objectiveId: 'obj' }],
        },
      ],
    },
  };
}

function episode(id, terminalAt, status = 'observed') {
  return {
    terminal: { invocationId: id, terminalAt, ownerUserId: 'owner-1' },
    summary: { segments: [{ segmentId: 'D1', status }] },
  };
}

function createHarness({
  episodes = [],
  annotations = [],
  cycleModel = model({ minimumIntervalMs: 0 }),
  version = 'v4',
} = {}) {
  const redis = new FakeRedis();
  const store = new CycleRecordStore(redis);
  const evaluationCatalog = catalog(cycleModel);
  let traceWindowQueries = 0;
  const traces = {
    async ensureOwnerEpisodeBackfilled() {},
    async getEpisodeByInvocationId(invocationId) {
      return episodes.find((item) => item.terminal.invocationId === invocationId) ?? null;
    },
    async countOwnerWindow(_owner, start, end) {
      traceWindowQueries++;
      return episodes.filter((item) => item.terminal.terminalAt >= start && item.terminal.terminalAt < end).length;
    },
    async earliestOwnerEpisode() {
      return episodes.length > 0 ? Math.min(...episodes.map((item) => item.terminal.terminalAt)) : null;
    },
  };
  const checker = new CycleTriggerChecker({
    catalog: evaluationCatalog,
    cycles: store,
    traces,
    annotations: {
      async queryMetricWindow(_owner, _objective, metricId, start, end) {
        return annotations.filter(
          (item) =>
            (item.metricId === undefined || item.metricId === metricId) &&
            item.createdAt >= start &&
            item.createdAt < end,
        );
      },
    },
    resolveVersion: () => ({ version, versionContentRef: `hooks:d1-test@${version}` }),
  });
  return { redis, store, checker, traceWindowQueries: () => traceWindowQueries };
}

function seedHistory(redis, record) {
  redis.strings.set(
    `harness-cycle-history:${record.ownerUserId}:${record.objectiveId}:${record.cycleId}`,
    JSON.stringify(record),
  );
  const index = `harness-cycle-history-index:${record.ownerUserId}:${record.objectiveId}`;
  const entries = redis.zsets.get(index) ?? new Map();
  entries.set(record.cycleId, record.closedAt);
  redis.zsets.set(index, entries);
}

describe('F257 CycleRecord trigger checker', () => {
  test('manual version switch archives tracing and carries old evidence without using it to wake the new cycle', async () => {
    const episodes = [episode('old-a', 100), episode('old-b', 200), episode('new-a', 600), episode('new-b', 700)];
    const context = createHarness({ episodes });
    const current = await context.store.initialize(
      'owner-1',
      'obj',
      0,
      { version: 'objective-v3', versionContentRef: 'hooks:D1@3' },
      {
        triggerPolicy: {
          cumulativeThreshold: 3,
          counterexampleThreshold: 2,
          cadenceDays: 7,
          minimumIntervalMs: 0,
          consecutiveKeepCycles: 0,
          consecutiveCadenceKeepCycles: 0,
        },
        objectiveLifecycle: 'active',
      },
    );
    let activeVersion = 3;
    const activations = [];
    const service = new ManualVersionCycleService({
      runtime: {
        catalog: catalog(),
        cycles: context.store,
        cycleChecker: context.checker,
        async resolveVersion() {
          return { version: 'objective-v2', versionContentRef: 'hooks:D1@2' };
        },
        async resolveSegmentVersion(versionContentRef) {
          return Number(versionContentRef.match(/@([0-9]+)$/)?.[1] ?? 0);
        },
      },
      overrideStore: {
        async getActiveVersion() {
          return activeVersion;
        },
        async activateVersion(_segmentId, version) {
          activations.push(version);
          activeVersion = version;
        },
      },
      async refreshOverrideSnapshot() {},
      now: () => 500,
    });

    const switched = await service.switch({
      ownerUserId: 'owner-1',
      segmentId: 'D1',
      targetVersion: 2,
      actorId: 'owner-1',
      reason: '手动切换当前版本至 v2',
    });
    const archived = await context.store.historyCycle('owner-1', 'obj', current.cycleId);

    assert.deepEqual(activations, [2]);
    assert.equal(archived.cycleEnd, 500);
    assert.deepEqual(archived.termination, {
      kind: 'manual-version-switch',
      segmentId: 'D1',
      fromVersion: 3,
      toVersion: 2,
      at: 500,
      by: 'owner-1',
      reason: '手动切换当前版本至 v2',
    });
    assert.equal(switched.currentCycle.cycleStart, 500);
    assert.equal(switched.currentCycle.versionContentRef, 'hooks:D1@2');
    assert.deepEqual(switched.currentCycle.carryoverWindows, [
      {
        start: 0,
        end: 500,
        provenance: {
          kind: 'manual-version-switch',
          sourceCycleId: current.cycleId,
          sourceVersion: 'objective-v3',
          sourceVersionContentRef: 'hooks:D1@3',
          sourceSegmentId: 'D1',
          sourceSegmentVersion: 3,
        },
      },
    ]);

    const belowNativeThreshold = await context.checker.checkObjective('owner-1', 'obj', 800);
    assert.equal(belowNativeThreshold.status, 'idle', 'old v3 evidence must not wake the new v2 cycle');
    episodes.push(episode('new-c', 750));
    const requested = await context.checker.checkObjective('owner-1', 'obj', 800);
    assert.equal(requested.status, 'requested');
    assert.deepEqual(requested.record.windows, [switched.currentCycle.carryoverWindows[0], { start: 500, end: 800 }]);
    await assert.rejects(
      service.switch({
        ownerUserId: 'owner-1',
        segmentId: 'D1',
        targetVersion: 3,
        actorId: 'owner-1',
        reason: 'must wait',
      }),
      /manual_version_switch_evaluation_in_progress/,
    );
    assert.deepEqual(activations, [2], 'blocked switch must not mutate the active content version');
  });

  test('creates and activates a new version from a historical base without an intermediate activation', async () => {
    const context = createHarness();
    const current = await context.store.initialize('owner-1', 'obj', 100, {
      version: 'objective-v2',
      versionContentRef: 'hooks:D1@2',
    });
    let activeVersion = 2;
    const writes = [];
    const service = new ManualVersionCycleService({
      runtime: {
        catalog: catalog(),
        cycles: context.store,
        cycleChecker: context.checker,
        async resolveVersion() {
          return { version: `objective-v${activeVersion}`, versionContentRef: `hooks:D1@${activeVersion}` };
        },
        async resolveSegmentVersion(versionContentRef) {
          return Number(versionContentRef.match(/@(\d+)$/)?.[1] ?? 0);
        },
      },
      overrideStore: {
        async getActiveVersion() {
          return activeVersion;
        },
        async hasVersion(_segmentId, version) {
          return [1, 2, 3].includes(version);
        },
        async setContentOverride(_segmentId, content, _actorId, opts) {
          writes.push({ kind: 'create', content, parentVersion: opts?.parentVersion });
          activeVersion = 4;
        },
        async activateVersion(_segmentId, version) {
          writes.push({ kind: 'activate', version });
          activeVersion = version;
        },
      },
      async refreshOverrideSnapshot() {},
      now: () => 500,
    });

    const created = await service.create({
      ownerUserId: 'owner-1',
      segmentId: 'D1',
      content: 'v4 based on v1',
      baseVersion: 1,
      expectedActiveVersion: 2,
      actorId: 'owner-1',
      reason: '用户编辑',
    });
    const archived = await context.store.historyCycle('owner-1', 'obj', current.cycleId);

    assert.deepEqual(writes, [{ kind: 'create', content: 'v4 based on v1', parentVersion: 1 }]);
    assert.equal(created.fromVersion, 2);
    assert.equal(created.toVersion, 4);
    assert.equal(created.baseVersion, 1);
    assert.equal(created.currentCycle.versionContentRef, 'hooks:D1@4');
    assert.equal(archived.termination.baseVersion, 1);
  });

  test('advances a same-millisecond version transition to a distinct cycle id', async () => {
    const context = createHarness();
    const current = await context.store.initialize('owner-1', 'obj', 100, {
      version: 'objective-v2',
      versionContentRef: 'hooks:D1@2',
    });
    let activeVersion = 2;
    const service = new ManualVersionCycleService({
      runtime: {
        catalog: catalog(),
        cycles: context.store,
        cycleChecker: context.checker,
        async resolveVersion() {
          return { version: `objective-v${activeVersion}`, versionContentRef: `hooks:D1@${activeVersion}` };
        },
        async resolveSegmentVersion(versionContentRef) {
          return Number(versionContentRef.match(/@(\d+)$/)?.[1] ?? 0);
        },
      },
      overrideStore: {
        async getActiveVersion() {
          return activeVersion;
        },
        async activateVersion(_segmentId, version) {
          activeVersion = version;
        },
      },
      async refreshOverrideSnapshot() {},
      now: () => 100,
    });

    const switched = await service.switch({
      ownerUserId: 'owner-1',
      segmentId: 'D1',
      targetVersion: 1,
      actorId: 'owner-1',
      reason: 'same millisecond',
    });
    assert.equal(switched.currentCycle.cycleStart, 101);
    assert.notEqual(switched.currentCycle.cycleId, current.cycleId);
    assert.equal(activeVersion, 1);
  });

  test('rejects a backwards clock before mutating the active version', async () => {
    const context = createHarness();
    await context.store.initialize('owner-1', 'obj', 100, {
      version: 'objective-v2',
      versionContentRef: 'hooks:D1@2',
    });
    let writes = 0;
    const service = new ManualVersionCycleService({
      runtime: {
        catalog: catalog(),
        cycles: context.store,
        cycleChecker: context.checker,
        async resolveSegmentVersion() {
          return 2;
        },
      },
      overrideStore: {
        async getActiveVersion() {
          return 2;
        },
        async activateVersion() {
          writes++;
        },
      },
      async refreshOverrideSnapshot() {},
      now: () => 99,
    });

    await assert.rejects(
      service.switch({
        ownerUserId: 'owner-1',
        segmentId: 'D1',
        targetVersion: 1,
        actorId: 'owner-1',
        reason: 'backwards clock',
      }),
      /manual_version_switch_concurrent_transition/,
    );
    assert.equal(writes, 0);
  });

  test('rejects a stale editor active-version precondition before creating content', async () => {
    const context = createHarness();
    await context.store.initialize('owner-1', 'obj', 100, {
      version: 'objective-v3',
      versionContentRef: 'hooks:D1@3',
    });
    let writes = 0;
    const service = new ManualVersionCycleService({
      runtime: {
        catalog: catalog(),
        cycles: context.store,
        cycleChecker: context.checker,
        async resolveVersion() {
          return { version: 'objective-v3', versionContentRef: 'hooks:D1@3' };
        },
        async resolveSegmentVersion() {
          return 3;
        },
      },
      overrideStore: {
        async getActiveVersion() {
          return 3;
        },
        async hasVersion() {
          return true;
        },
        async setContentOverride() {
          writes++;
        },
        async activateVersion() {},
      },
      async refreshOverrideSnapshot() {},
      now: () => 500,
    });

    await assert.rejects(
      service.create({
        ownerUserId: 'owner-1',
        segmentId: 'D1',
        content: 'stale edit',
        baseVersion: 1,
        expectedActiveVersion: 2,
        actorId: 'owner-1',
        reason: '用户编辑',
      }),
      /manual_version_switch_active_version_changed/,
    );
    assert.equal(writes, 0);
  });

  test('compensates when a multi-step version write changes active state before throwing', async () => {
    const context = createHarness();
    await context.store.initialize('owner-1', 'obj', 100, {
      version: 'objective-v2',
      versionContentRef: 'hooks:D1@2',
    });
    let activeVersion = 2;
    const activations = [];
    const service = new ManualVersionCycleService({
      runtime: {
        catalog: catalog(),
        cycles: context.store,
        cycleChecker: context.checker,
        async resolveVersion() {
          return { version: `objective-v${activeVersion}`, versionContentRef: `hooks:D1@${activeVersion}` };
        },
        async resolveSegmentVersion(versionContentRef) {
          return Number(versionContentRef.match(/@(\d+)$/)?.[1] ?? 0);
        },
      },
      overrideStore: {
        async getActiveVersion() {
          return activeVersion;
        },
        async hasVersion() {
          return true;
        },
        async setContentOverride() {
          activeVersion = 4;
          throw new Error('event write failed after active changed');
        },
        async activateVersion(_segmentId, version) {
          activations.push(version);
          activeVersion = version;
        },
      },
      async refreshOverrideSnapshot() {},
      now: () => 500,
    });

    await assert.rejects(
      service.create({
        ownerUserId: 'owner-1',
        segmentId: 'D1',
        content: 'partial v4',
        baseVersion: 1,
        expectedActiveVersion: 2,
        actorId: 'owner-1',
        reason: '用户编辑',
      }),
      /event write failed after active changed/,
    );
    assert.equal(activeVersion, 2);
    assert.deepEqual(activations, [2]);
    assert.equal((await context.store.current('owner-1', 'obj')).versionContentRef, 'hooks:D1@2');
  });

  test('compensates the active version when the durable cycle CAS loses', async () => {
    const context = createHarness();
    await context.store.initialize('owner-1', 'obj', 0, {
      version: 'objective-v3',
      versionContentRef: 'hooks:D1@3',
    });
    let activeVersion = 3;
    const activations = [];
    const service = new ManualVersionCycleService({
      runtime: {
        catalog: catalog(),
        cycles: {
          current: (...args) => context.store.current(...args),
          async switchVersion() {
            return null;
          },
        },
        cycleChecker: context.checker,
        async resolveVersion() {
          return { version: 'objective-v2', versionContentRef: 'hooks:D1@2' };
        },
        async resolveSegmentVersion(versionContentRef) {
          return Number(versionContentRef.match(/@([0-9]+)$/)?.[1] ?? 0);
        },
      },
      overrideStore: {
        async getActiveVersion() {
          return activeVersion;
        },
        async activateVersion(_segmentId, version) {
          activations.push(version);
          activeVersion = version;
        },
      },
      async refreshOverrideSnapshot() {},
      now: () => 500,
    });

    await assert.rejects(
      service.switch({
        ownerUserId: 'owner-1',
        segmentId: 'D1',
        targetVersion: 2,
        actorId: 'owner-1',
        reason: 'switch with a losing CAS',
      }),
      /manual_version_switch_concurrent_transition/,
    );
    assert.deepEqual(activations, [2, 3]);
    assert.equal(activeVersion, 3);
    assert.equal((await context.store.current('owner-1', 'obj')).versionContentRef, 'hooks:D1@3');
  });

  test('initializes the first cycle from the owner pool even when its segment is absent', async () => {
    const { checker, store } = createHarness({ episodes: [episode('absent-only', 100, 'absent')] });
    const result = await checker.checkObjective('owner-1', 'obj', 5_000);
    const current = await store.current('owner-1', 'obj');

    assert.equal(result.status, 'idle');
    assert.equal(current.cycleStart, 100);
    assert.equal(current.evalStatus, 'idle');
  });

  test('prefers the preserved completed-window end and rejects a future start', async () => {
    const preserved = createHarness({ episodes: [episode('a', 100)], cycleModel: model({ cumulativeThreshold: 99 }) });
    preserved.redis.strings.set('harness-unit-run-completed-window-end:owner-1:obj', '900');
    await preserved.checker.checkObjective('owner-1', 'obj', 1_000);
    assert.equal((await preserved.store.current('owner-1', 'obj')).cycleStart, 900);

    const invalid = createHarness();
    invalid.redis.strings.set('harness-unit-run-completed-window-end:owner-1:obj', '1001');
    await assert.rejects(invalid.checker.checkObjective('owner-1', 'obj', 1_000), /cycle_start_after_now:obj/);
  });

  test('any cumulative threshold requests one small window-only record under concurrency', async () => {
    const { checker, store } = createHarness({
      episodes: [episode('a', 1_000), episode('b', 1_100), episode('c', 1_200)],
    });
    await Promise.all([checker.checkTrace('owner-1', 'c', 2_000), checker.checkObjective('owner-1', 'obj', 2_000)]);
    const current = await store.current('owner-1', 'obj');
    const serialized = JSON.stringify(current);

    assert.equal(current.evalStatus, 'requested');
    assert.deepEqual(current.triggeredBy, ['cumulative']);
    assert.deepEqual(current.windows, [{ start: 1_000, end: 2_000 }]);
    assert.equal(current.version, 'v4');
    assert.ok(Buffer.byteLength(serialized) < 1_024, serialized);
    assert.doesNotMatch(serialized, /traceCorpus|invocationId|summary/);
  });

  test('counts disabled segment episodes from the owner pool and requests an ablation evaluation', async () => {
    const episodes = Array.from({ length: 1_530 }, (_, index) => episode(`old-${index}`, index + 1));
    const { checker, store } = createHarness({
      episodes,
      cycleModel: model({ cumulativeThreshold: 1_531, cadenceDays: 365, minimumIntervalMs: 0 }),
    });

    await checker.initializeOwner('owner-1', 2_000);
    episodes.push(episode('latest', 2_001, 'absent'));
    await checker.checkTrace('owner-1', 'latest', 2_002);
    assert.equal((await store.current('owner-1', 'obj')).evalStatus, 'requested');
  });

  test('deduplicated counterexamples and cadence are independent trigger routes', async () => {
    const counterexamples = [
      {
        createdAt: 1_100,
        polarity: 'counterexample',
        confidence: 1,
        incidentKey: 'same',
        source: 'structured-rule',
      },
      {
        createdAt: 1_200,
        polarity: 'counterexample',
        confidence: 1,
        incidentKey: 'same',
        source: 'semantic-sweep',
      },
      {
        createdAt: 1_300,
        polarity: 'counterexample',
        confidence: 1,
        incidentKey: 'other',
        source: 'mcp-marker',
        objectiveId: 'obj',
        episodeRef: { invocationId: 'marker-invocation' },
      },
      {
        createdAt: 1_400,
        polarity: 'counterexample',
        confidence: 1,
        incidentKey: 'ignored',
        source: 'semantic-sweep',
      },
    ];
    const counter = createHarness({ episodes: [episode('a', 1_000)], annotations: counterexamples });
    const counterResult = await counter.checker.checkObjective('owner-1', 'obj', 2_000);
    assert.equal(counterResult.status, 'requested');
    assert.deepEqual((await counter.store.current('owner-1', 'obj')).triggeredBy, ['counterexamples']);

    const cadence = createHarness({ episodes: [episode('a', 1_000)], cycleModel: model({ cumulativeThreshold: 99 }) });
    await cadence.checker.checkObjective('owner-1', 'obj', 1_001);
    const cadenceResult = await cadence.checker.checkObjective('owner-1', 'obj', 1_000 + 7 * DAY);
    assert.equal(cadenceResult.status, 'requested');
    assert.deepEqual((await cadence.store.current('owner-1', 'obj')).triggeredBy, ['cadence']);
  });

  test('counts MCP counterexamples by distinct invocation across metrics', async () => {
    const cycleModel = model({
      cumulativeThreshold: 99,
      counterexampleThreshold: 2,
      cadenceDays: 365,
      minimumIntervalMs: 0,
    });
    cycleModel.metrics = ['metric-a', 'metric-b', 'metric-c'].map((id) => ({
      id,
      label: id,
      kind: 'counter',
      evaluator: { kind: 'code', ruleRef: id },
      trigger: { kind: 'distinct-counterexamples', threshold: 2 },
      verdictRule: { kind: 'counter-zero' },
    }));
    const annotations = [
      {
        createdAt: 1_100,
        polarity: 'counterexample',
        confidence: 1,
        incidentKey: 'mcp-a',
        source: 'mcp-marker',
        metricId: 'metric-a',
        objectiveId: 'obj',
        episodeRef: { invocationId: 'inv-1' },
      },
      {
        createdAt: 1_101,
        polarity: 'counterexample',
        confidence: 1,
        incidentKey: 'mcp-b',
        source: 'mcp-marker',
        metricId: 'metric-b',
        objectiveId: 'obj',
        episodeRef: { invocationId: 'inv-1' },
      },
    ];
    const context = createHarness({ episodes: [episode('inv-1', 1_000)], annotations, cycleModel });

    assert.equal((await context.checker.checkObjective('owner-1', 'obj', 2_000)).status, 'idle');

    annotations.push({
      ...annotations[0],
      createdAt: 2_100,
      incidentKey: 'mcp-c',
      episodeRef: { invocationId: 'inv-2' },
    });
    assert.equal((await context.checker.checkObjective('owner-1', 'obj', 3_000)).status, 'requested');
    assert.deepEqual((await context.store.current('owner-1', 'obj')).triggeredBy, ['counterexamples']);
  });

  test('minimum interval blocks an immediate trigger and consecutive skips expand windows once', async () => {
    const { redis, checker, store } = createHarness({
      episodes: [episode('a', 201), episode('b', 202), episode('c', 203)],
      cycleModel: model(),
    });
    seedHistory(redis, {
      schemaVersion: 1,
      cycleId: 'cycle-1',
      ownerUserId: 'owner-1',
      objectiveId: 'obj',
      version: 'v1',
      versionContentRef: 'hooks:d1-test@v1',
      cycleStart: 0,
      cycleEnd: 100,
      evalStatus: 'written',
      windows: [{ start: 0, end: 100 }],
      approval: { state: 'skipped', rejectCount: 0, at: 110 },
      closedAt: 110,
    });
    seedHistory(redis, {
      schemaVersion: 1,
      cycleId: 'cycle-2',
      ownerUserId: 'owner-1',
      objectiveId: 'obj',
      version: 'v2',
      versionContentRef: 'hooks:d1-test@v2',
      cycleStart: 100,
      cycleEnd: 200,
      evalStatus: 'written',
      windows: [
        { start: 0, end: 100 },
        { start: 100, end: 200 },
      ],
      approval: { state: 'skipped', rejectCount: 0, at: 210 },
      closedAt: 210,
    });
    await store.initialize('owner-1', 'obj', 200, { version: 'v4', versionContentRef: 'hooks:d1-test@v4' });

    const blocked = await checker.checkObjective('owner-1', 'obj', 200 + 2 * 60 * 60 * 1000 - 1);
    assert.equal(blocked.status, 'interval');

    const requested = await checker.checkObjective('owner-1', 'obj', 200 + 2 * 60 * 60 * 1000);
    assert.equal(requested.status, 'requested');
    assert.deepEqual((await store.current('owner-1', 'obj')).windows, [
      { start: 0, end: 100 },
      { start: 100, end: 200 },
      { start: 200, end: 7_200_200 },
    ]);
  });
});
