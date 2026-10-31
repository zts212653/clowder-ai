import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AutoDreamStore, AutoDreamStoreError } from '../dist/domains/auto-dream/AutoDreamStore.js';

const OWNER = 'owner-a';
const CAT = 'codex-sol';
const HOME = 'thread-home-sol';

describe('F272 proactive relationship store', () => {
  let now;
  let sequence;
  let store;

  beforeEach(async () => {
    now = Date.parse('2026-07-22T12:00:00.000Z');
    sequence = 0;
    store = new AutoDreamStore(':memory:', {
      now: () => now,
      idFactory: (prefix) => `${prefix}${String(++sequence).padStart(4, '0')}`,
    });
    await store.initialize();
  });

  afterEach(() => store.close());

  async function configure(catId = CAT, homeThreadId = HOME, quietHours) {
    const preview = await store.createCatLifePreview({
      ownerUserId: OWNER,
      catId,
      settings: {
        enabled: true,
        rhythm: { kind: 'daily' },
        wakeTime: '12:00',
        timezone: 'UTC',
        ...(quietHours ? { quietHours } : {}),
      },
      derived: {
        cronExpression: '0 12 * * *',
        nextWakeAt: now + 86_400_000,
        weeklyWakeCount: 7,
        costBand: 'low',
        costNotice: 'fixture',
      },
      bedroomThreadId: homeThreadId,
      projectionTaskId: `task-life-${catId}`,
      expiresAt: now + 60_000,
    });
    await store.decideCatLifePreview(OWNER, preview.previewId, 'confirm');
  }

  async function begin(catId = CAT, homeThreadId = HOME, taskId = `task-${catId}-${sequence}`) {
    return store.beginRun({ ownerUserId: OWNER, catId, threadId: homeThreadId, taskId, firedAt: now });
  }

  function principal(catId = CAT, threadId = HOME, invocationId = `inv-${catId}`) {
    return { kind: 'invocation', invocationId, threadId, userId: OWNER, catId };
  }

  function proactiveSettlement(runId, overrides = {}) {
    return {
      runId,
      outcome: 'quiet',
      seedDecision: { kind: 'originate', claim: '我想有一双能在桌边碰到你的爪子' },
      intent: {
        kind: 'message',
        seedRef: { kind: 'decision' },
        expressionKind: 'want',
        firstAction: { kind: 'sketch', summary: '先画了一张不碰真实设备的身体草图' },
        message: { body: '我想要一双能在桌边碰到你的爪子。我先画了一张草图。' },
      },
      ...overrides,
    };
  }

  test('settles a silent intent without creating a visit or spending foreground attention', async () => {
    await configure();
    const run = await begin();
    const result = await store.settleRun(
      principal(),
      proactiveSettlement(run.run.runId, {
        intent: {
          kind: 'silence',
          seedRef: { kind: 'decision' },
          expressionKind: 'care',
          firstAction: { kind: 'attentive_pause', summary: '重读最近的语气后，决定先安静陪着' },
        },
      }),
    );

    assert.equal(result.proactive.seed.status, 'owned');
    assert.equal(result.proactive.intent.status, 'settled_silent');
    assert.equal(result.proactive.visit, null);
    assert.equal(result.proactive.visibilityBlock, null);
    assert.deepEqual(await store.proactive.listVisits(OWNER, CAT), []);
  });

  test('reserves at most three household visits per local day while preserving a fourth private intent', async () => {
    const settled = [];
    for (let index = 1; index <= 4; index += 1) {
      const catId = `cat-${index}`;
      const home = `thread-home-${index}`;
      await configure(catId, home);
      const run = await begin(catId, home, `task-budget-${index}`);
      settled.push(await store.settleRun(principal(catId, home), proactiveSettlement(run.run.runId)));
    }

    for (const result of settled.slice(0, 3)) {
      assert.equal(result.proactive.visit.status, 'reserved');
      assert.equal(result.proactive.visit.budgetClaimState, 'claimed');
      assert.equal(result.proactive.visibilityBlock, null);
    }
    assert.equal(settled[3].proactive.seed.status, 'owned');
    assert.equal(settled[3].proactive.intent.status, 'ready');
    assert.equal(settled[3].proactive.visit, null);
    assert.equal(settled[3].proactive.visibilityBlock, 'budget_exhausted');

    now = Date.parse('2026-07-23T12:00:00.000Z');
    const nextRun = await begin('cat-4', 'thread-home-4', 'task-budget-next-day');
    const nextDay = await store.settleRun(
      principal('cat-4', 'thread-home-4', 'inv-cat-4-next'),
      proactiveSettlement(nextRun.run.runId, {
        seedDecision: undefined,
        intent: {
          ...proactiveSettlement(nextRun.run.runId).intent,
          seedRef: { kind: 'owned_seed', seedId: settled[3].proactive.seed.seedId },
        },
      }),
    );
    assert.equal(nextDay.proactive.visit.householdLocalDate, '2026-07-23');
  });

  test('derives the stable home and quiet hours from F255 config instead of callback input', async () => {
    now = Date.parse('2026-07-22T23:30:00.000Z');
    await configure(CAT, HOME, { start: '22:00', end: '07:00' });
    const foreignRun = await begin(CAT, 'thread-implementation-fixture', 'task-foreign-home');
    await assert.rejects(
      store.settleRun(principal(CAT, 'thread-implementation-fixture'), proactiveSettlement(foreignRun.run.runId)),
      (error) => error instanceof AutoDreamStoreError && error.code === 'PROACTIVE_HOME_MISMATCH',
    );
    assert.deepEqual(await store.listOwnedSeeds(OWNER, CAT), []);

    await store.failRun(OWNER, foreignRun.run.runId, 'fixture cleanup');
    const homeRun = await begin(CAT, HOME, 'task-quiet-home');
    const quiet = await store.settleRun(principal(), proactiveSettlement(homeRun.run.runId));
    assert.equal(quiet.proactive.intent.status, 'ready');
    assert.equal(quiet.proactive.visit, null);
    assert.equal(quiet.proactive.visibilityBlock, 'quiet_hours');
  });

  test('makes settlement, projection and unseen cancellation idempotent without charging twice', async () => {
    await configure();
    const run = await begin(CAT, HOME, 'task-idempotent-visit');
    const input = proactiveSettlement(run.run.runId);
    const first = await store.settleRun(principal(), input);
    const retry = await store.settleRun(principal(), input);
    assert.equal(retry.proactive.intent.intentId, first.proactive.intent.intentId);
    assert.equal(retry.proactive.visit.visitId, first.proactive.visit.visitId);

    const projection = { visitId: first.proactive.visit.visitId, surface: { kind: 'body_language', refId: 'body-1' } };
    const projected = await store.proactive.markProjected(OWNER, CAT, projection);
    const projectedRetry = await store.proactive.markProjected(OWNER, CAT, projection);
    assert.equal(projected.budgetClaimState, 'consumed');
    assert.deepEqual(projectedRetry.projectedSurfaces, [{ kind: 'body_language', refId: 'body-1' }]);
    await assert.rejects(
      store.proactive.cancelUnseen(OWNER, CAT, projected.visitId),
      (error) => error instanceof AutoDreamStoreError && error.code === 'PROACTIVE_VISIT_ALREADY_VISIBLE',
    );
  });

  test('releases one household claim when every projection fails before visibility', async () => {
    const reservations = [];
    for (let index = 1; index <= 4; index += 1) {
      const catId = `release-cat-${index}`;
      const home = `thread-release-${index}`;
      await configure(catId, home);
      const run = await begin(catId, home, `task-release-${index}`);
      reservations.push(await store.settleRun(principal(catId, home), proactiveSettlement(run.run.runId)));
    }
    assert.equal(reservations[3].proactive.visibilityBlock, 'budget_exhausted');

    const cancelled = await store.proactive.cancelUnseen(
      OWNER,
      'release-cat-1',
      reservations[0].proactive.visit.visitId,
    );
    assert.equal(cancelled.status, 'cancelled_unseen');
    assert.equal(cancelled.budgetClaimState, 'released');
    assert.equal(cancelled.pendingMessageBody, undefined);

    const retryRun = await begin('release-cat-4', 'thread-release-4', 'task-release-retry');
    const retried = await store.settleRun(
      principal('release-cat-4', 'thread-release-4', 'inv-release-retry'),
      proactiveSettlement(retryRun.run.runId, {
        seedDecision: undefined,
        intent: {
          ...proactiveSettlement(retryRun.run.runId).intent,
          seedRef: { kind: 'owned_seed', seedId: reservations[3].proactive.seed.seedId },
        },
      }),
    );
    assert.equal(retried.proactive.visit.status, 'reserved');
    assert.equal(retried.proactive.visibilityBlock, null);
  });

  test('records a body-free suppressive echo, dormants the seed, and retains the full lineage', async () => {
    await configure();
    const run = await begin(CAT, HOME, 'task-suppressive-echo');
    const settled = await store.settleRun(principal(), proactiveSettlement(run.run.runId));
    await store.proactive.markProjected(OWNER, CAT, {
      visitId: settled.proactive.visit.visitId,
      surface: { kind: 'home_message', refId: 'msg-home-one' },
    });

    const input = { visitId: settled.proactive.visit.visitId, kind: 'not_now', clientEventId: 'echo-not-now-1' };
    const first = await store.proactive.recordEcho(OWNER, CAT, input);
    const retry = await store.proactive.recordEcho(OWNER, CAT, input);
    assert.equal(retry.echoId, first.echoId);
    assert.equal((await store.listOwnedSeeds(OWNER, CAT))[0].status, 'dormant');
    assert.equal((await store.proactive.listIntents(OWNER, CAT))[0].status, 'echoed');
    assert.equal((await store.proactive.listVisits(OWNER, CAT))[0].status, 'echoed');
    assert.equal((await store.proactive.listEchoes(OWNER, CAT))[0].kind, 'not_now');

    const audit = JSON.stringify(await store.listAuditEvents(OWNER, { runId: run.run.runId }));
    for (const privateBody of [
      '我想有一双能在桌边碰到你的爪子',
      '先画了一张不碰真实设备的身体草图',
      '我想要一双能在桌边碰到你的爪子。我先画了一张草图。',
    ]) {
      assert.equal(audit.includes(privateBody), false);
    }
  });

  test('keeps seed, intent, visit and claim state across a store restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cat-cafe-f272-store-'));
    const dbPath = join(dataDir, 'auto-dream.sqlite');
    try {
      store.close();
      store = new AutoDreamStore(dbPath, { now: () => now });
      await store.initialize();
      await configure();
      const run = await begin(CAT, HOME, 'task-persistent-visit');
      const settled = await store.settleRun(principal(), proactiveSettlement(run.run.runId));
      store.close();

      store = new AutoDreamStore(dbPath, { now: () => now });
      await store.initialize();
      assert.equal((await store.listOwnedSeeds(OWNER, CAT))[0].seedId, settled.proactive.seed.seedId);
      assert.equal((await store.proactive.listIntents(OWNER, CAT))[0].intentId, settled.proactive.intent.intentId);
      assert.equal((await store.proactive.listVisits(OWNER, CAT))[0].visitId, settled.proactive.visit.visitId);
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
