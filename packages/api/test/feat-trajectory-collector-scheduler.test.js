/**
 * F233 Phase C C2b step 4 — FeatTrajectoryCollectorScheduler tests
 *
 * Verify tick() orchestration with stub collector + real in-memory projector/store.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('FeatTrajectoryCollectorScheduler', () => {
  async function buildHarness({ snapshots = [], collectorThrows = false } = {}) {
    const { FeatTrajectoryCollectorScheduler } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorScheduler.js'
    );
    const { FeatTrajectoryProjector } = await import('../dist/domains/feat-trajectory/FeatTrajectoryProjector.js');
    const { InMemoryFeatTrajectoryStore } = await import('../dist/domains/feat-trajectory/FeatTrajectoryStore.js');

    const store = new InMemoryFeatTrajectoryStore();
    const projector = new FeatTrajectoryProjector(store);
    const collector = {
      async collectAll() {
        if (collectorThrows) throw new Error('git unreachable');
        return snapshots;
      },
    };
    const logs = [];
    const logger = {
      info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
      error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
    };
    const scheduler = new FeatTrajectoryCollectorScheduler({ collector, projector, store, logger });
    return { scheduler, store, logs };
  }

  function makeSnap(featId = 'F188', branchName = 'fix/f188-x') {
    return {
      branchName,
      headCommitSha: 'abc1234',
      headCommitAt: 1_700_000_000_000,
      prNumber: null,
      prState: null,
      mergedToMain: null,
      prOpenedAt: null,
      prMergedAt: null,
      authorIdentity: 'opus-47',
      featureCandidates: [featId],
      associatedThreadIds: [],
      lastThreadMessageAt: null,
      lastThreadActivityAt: null,
      joinProvenance: { confidence: 'high', joinedVia: ['branch_name_F#'] },
      collectedAt: 1_700_000_000_000 + 10 * 24 * 60 * 60 * 1000,
    };
  }

  test('empty snapshots → {collected:0, applied:0, failed:0, featsInStore:0}', async () => {
    const { scheduler } = await buildHarness({ snapshots: [] });
    const result = await scheduler.tick();
    assert.strictEqual(result.collected, 0);
    assert.strictEqual(result.applied, 0);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.featsInStore, 0);
  });

  test('F188 snapshot → applied + stored', async () => {
    const { scheduler, store } = await buildHarness({ snapshots: [makeSnap()] });
    const result = await scheduler.tick();
    assert.strictEqual(result.collected, 1);
    assert.strictEqual(result.applied, 1);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.featsInStore, 1);
    const feats = await store.listFeatIds();
    assert.deepStrictEqual(feats, ['F188']);
  });

  test('multiple snapshots → all applied', async () => {
    const { scheduler, store } = await buildHarness({
      snapshots: [makeSnap('F100', 'fix/f100-a'), makeSnap('F188', 'fix/f188-b'), makeSnap('F233', 'fix/f233-c')],
    });
    const result = await scheduler.tick();
    assert.strictEqual(result.applied, 3);
    assert.strictEqual(result.featsInStore, 3);
    const feats = await store.listFeatIds();
    assert.strictEqual(feats.length, 3);
  });

  test('snapshot apply error → failed++, continue rest', async () => {
    const badSnap = {
      ...makeSnap('F200', 'fix/f200-broken'),
      prOpenedAt: 1_700_000_000_000 + 60_000,
      prNumber: null, // contract violation
    };
    const { scheduler, logs } = await buildHarness({
      snapshots: [makeSnap('F188'), badSnap, makeSnap('F300', 'fix/f300-ok')],
    });
    const result = await scheduler.tick();
    assert.strictEqual(result.collected, 3);
    assert.strictEqual(result.applied, 2);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.featsInStore, 2);
    assert.ok(logs.some((l) => l.level === 'warn' && String(l.msg).includes('applyGitRefSnapshot failed')));
  });

  test('collector throws → result {collected:0, applied:0, failed:0} + logged error', async () => {
    const { scheduler, logs } = await buildHarness({ collectorThrows: true });
    const result = await scheduler.tick();
    assert.strictEqual(result.collected, 0);
    assert.strictEqual(result.applied, 0);
    assert.strictEqual(result.failed, 0);
    assert.ok(
      logs.some((l) => l.level === 'error' && String(l.msg).includes('collector.collectAll failed')),
      'should log error',
    );
  });

  test('idempotency: tick twice on same snapshot does not double count', async () => {
    const { scheduler, store } = await buildHarness({ snapshots: [makeSnap()] });
    const first = await scheduler.tick();
    const second = await scheduler.tick();
    assert.strictEqual(first.applied, 1);
    assert.strictEqual(second.applied, 1);
    const proj = await store.get('F188');
    // branch_pushed should be 1 (cloud P2 stable id: same head sha → same entry id → upsert)
    assert.strictEqual(proj.countsByKind.branch_pushed, 1, 'cloud P2 stable id idempotent across ticks');
  });

  test('custom now() used for tick timestamp', async () => {
    const { FeatTrajectoryCollectorScheduler } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorScheduler.js'
    );
    const { InMemoryFeatTrajectoryStore } = await import('../dist/domains/feat-trajectory/FeatTrajectoryStore.js');
    const { FeatTrajectoryProjector } = await import('../dist/domains/feat-trajectory/FeatTrajectoryProjector.js');

    const store = new InMemoryFeatTrajectoryStore();
    const projector = new FeatTrajectoryProjector(store);
    let collectorReceivedNow = null;
    const collector = {
      async collectAll(now) {
        collectorReceivedNow = now;
        return [];
      },
    };
    const fixed = 1_900_000_000_000;
    const scheduler = new FeatTrajectoryCollectorScheduler({
      collector,
      projector,
      store,
      now: () => fixed,
    });
    await scheduler.tick();
    assert.strictEqual(collectorReceivedNow, fixed, 'collector.collectAll called with scheduler now() value');
  });

  test('cloud round 2 P2: tick records setLastCollectorTickAt(tickStart) even with 0 snapshots', async () => {
    // The tick observation time is the right UI freshness metric — quiet
    // periods (0 snapshots) shouldn't make UI look "stale" when collector
    // is actually running fine.
    const { FeatTrajectoryCollectorScheduler } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorScheduler.js'
    );
    const { InMemoryFeatTrajectoryStore } = await import('../dist/domains/feat-trajectory/FeatTrajectoryStore.js');
    const { FeatTrajectoryProjector } = await import('../dist/domains/feat-trajectory/FeatTrajectoryProjector.js');
    const store = new InMemoryFeatTrajectoryStore();
    const projector = new FeatTrajectoryProjector(store);
    const fixedTickTime = 1_950_000_000_000;
    const scheduler = new FeatTrajectoryCollectorScheduler({
      collector: {
        async collectAll() {
          return [];
        },
      },
      projector,
      store,
      now: () => fixedTickTime,
    });
    assert.strictEqual(await store.getLastCollectorTickAt(), null, 'before tick = null');
    await scheduler.tick();
    assert.strictEqual(
      await store.getLastCollectorTickAt(),
      fixedTickTime,
      'after tick = tickStart, even with 0 snapshots',
    );
  });

  test('cloud round 2 P2: setLastCollectorTickAt error → warn log but tick still returns result', async () => {
    const { FeatTrajectoryCollectorScheduler } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorScheduler.js'
    );
    const { InMemoryFeatTrajectoryStore } = await import('../dist/domains/feat-trajectory/FeatTrajectoryStore.js');
    const { FeatTrajectoryProjector } = await import('../dist/domains/feat-trajectory/FeatTrajectoryProjector.js');
    const store = new InMemoryFeatTrajectoryStore();
    store.setLastCollectorTickAt = async () => {
      throw new Error('redis unreachable');
    };
    const projector = new FeatTrajectoryProjector(store);
    const logs = [];
    const scheduler = new FeatTrajectoryCollectorScheduler({
      collector: {
        async collectAll() {
          return [];
        },
      },
      projector,
      store,
      logger: {
        warn: (obj, msg) => logs.push({ obj, msg }),
        info: () => {},
        error: () => {},
      },
    });
    const result = await scheduler.tick();
    assert.strictEqual(result.collected, 0, 'tick still completes');
    assert.ok(
      logs.some((l) => String(l.msg).includes('setLastCollectorTickAt failed')),
      'warn-log fires on setLastCollectorTickAt error',
    );
  });
});

describe('createFeatTrajectoryCollectorTaskSpec', () => {
  test('returns valid TaskSpec_P1 shape with default interval', async () => {
    const {
      createFeatTrajectoryCollectorTaskSpec,
      DEFAULT_FEAT_TRAJECTORY_COLLECTOR_INTERVAL_MS,
      FEAT_TRAJECTORY_COLLECTOR_TASK_ID,
    } = await import('../dist/domains/feat-trajectory/FeatTrajectoryCollectorTaskSpec.js');
    const scheduler = {
      async tick() {
        return { collected: 0, applied: 0, failed: 0, featsInStore: 0 };
      },
    };
    const spec = createFeatTrajectoryCollectorTaskSpec({ scheduler });
    assert.strictEqual(spec.id, FEAT_TRAJECTORY_COLLECTOR_TASK_ID);
    assert.strictEqual(spec.profile, 'poller');
    assert.strictEqual(spec.trigger.type, 'interval');
    assert.strictEqual(spec.trigger.ms, DEFAULT_FEAT_TRAJECTORY_COLLECTOR_INTERVAL_MS);
    assert.strictEqual(spec.run.overlap, 'skip');
    assert.ok(typeof spec.run.execute === 'function');
    assert.ok(typeof spec.admission.gate === 'function');
  });

  test('custom intervalMs overrides default', async () => {
    const { createFeatTrajectoryCollectorTaskSpec } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorTaskSpec.js'
    );
    const scheduler = {
      async tick() {
        return { collected: 0, applied: 0, failed: 0, featsInStore: 0 };
      },
    };
    const spec = createFeatTrajectoryCollectorTaskSpec({ scheduler, intervalMs: 60_000 });
    assert.strictEqual(spec.trigger.ms, 60_000);
  });

  test('execute() calls scheduler.tick() and logs on apply > 0', async () => {
    const { createFeatTrajectoryCollectorTaskSpec } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorTaskSpec.js'
    );
    let tickCalled = false;
    const scheduler = {
      async tick() {
        tickCalled = true;
        return { collected: 5, applied: 5, failed: 0, featsInStore: 3 };
      },
    };
    const logs = [];
    const spec = createFeatTrajectoryCollectorTaskSpec({
      scheduler,
      log: {
        info: (obj, msg) => logs.push({ level: 'info', msg }),
        warn: (obj, msg) => logs.push({ level: 'warn', msg }),
      },
    });
    await spec.run.execute({ signal: null, subjectKey: 'feat-trajectory-collector' });
    assert.strictEqual(tickCalled, true);
    assert.ok(logs.some((l) => l.level === 'info' && String(l.msg).includes('5 snapshots')));
  });

  test('execute() logs warn when failed > 0', async () => {
    const { createFeatTrajectoryCollectorTaskSpec } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorTaskSpec.js'
    );
    const scheduler = {
      async tick() {
        return { collected: 3, applied: 2, failed: 1, featsInStore: 2 };
      },
    };
    const logs = [];
    const spec = createFeatTrajectoryCollectorTaskSpec({
      scheduler,
      log: {
        info: (obj, msg) => logs.push({ level: 'info', msg }),
        warn: (obj, msg) => logs.push({ level: 'warn', msg }),
      },
    });
    await spec.run.execute({ signal: null, subjectKey: 'feat-trajectory-collector' });
    assert.ok(logs.some((l) => l.level === 'warn' && String(l.msg).includes('failures')));
  });
});
