import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  CAT,
  createCatLifeServiceFixture,
  ENABLED,
  OWNER,
  resolveTestCat,
} from './helpers/auto-dream-cat-life-fixture.js';

describe('F255 CatLifeSettingsService concurrency and recovery', () => {
  let store;
  let dynamicStore;
  let threadStore;
  let runner;
  let service;
  let fixture;

  beforeEach(async () => {
    fixture = await createCatLifeServiceFixture();
    ({ store, dynamicStore, threadStore, runner, service } = fixture);
  });

  test('serializes two distinct preview confirmations before either can project stale config', async () => {
    const older = await service.preview(OWNER, CAT, ENABLED);
    const newerSettings = {
      ...ENABLED,
      rhythm: { kind: 'daily' },
      wakeTime: '21:15',
    };
    const newer = await service.preview(OWNER, CAT, newerSettings);

    const originalEnsureThread = threadStore.ensureThread.bind(threadStore);
    let signalFirstEnsure;
    let releaseFirstEnsure;
    const firstEnsureEntered = new Promise((resolve) => {
      signalFirstEnsure = resolve;
    });
    const firstEnsureReleased = new Promise((resolve) => {
      releaseFirstEnsure = resolve;
    });
    let ensureCalls = 0;
    threadStore.ensureThread = async (...args) => {
      ensureCalls++;
      if (ensureCalls === 1) {
        signalFirstEnsure();
        await firstEnsureReleased;
      }
      return originalEnsureThread(...args);
    };

    const olderDecision = service.decide(OWNER, older.previewId, 'confirm');
    await firstEnsureEntered;
    const newerDecision = service.decide(OWNER, newer.previewId, 'confirm');
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirstEnsure();
    await Promise.all([olderDecision, newerDecision]);

    const config = await store.getCatLifeConfig(OWNER, CAT);
    assert.equal(config.revision, 2);
    assert.equal(config.settings.wakeTime, '21:15');
    assert.equal(config.settings.rhythm.kind, 'daily');
    const defs = dynamicStore.getAll();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].trigger.expression, '15 21 * * *');
    assert.equal(runner.registered.get(defs[0].id).spec.trigger.expression, '15 21 * * *');
  });

  test('serializes startup reconciliation with a newer confirmed preview for the same cat', async () => {
    const initial = await service.preview(OWNER, CAT, ENABLED);
    await service.decide(OWNER, initial.previewId, 'confirm');

    const originalEnsureThread = threadStore.ensureThread.bind(threadStore);
    let signalReconcileEnsure;
    let releaseReconcileEnsure;
    const reconcileEnsureEntered = new Promise((resolve) => {
      signalReconcileEnsure = resolve;
    });
    const reconcileEnsureReleased = new Promise((resolve) => {
      releaseReconcileEnsure = resolve;
    });
    let ensureCalls = 0;
    threadStore.ensureThread = async (...args) => {
      ensureCalls++;
      if (ensureCalls === 1) {
        signalReconcileEnsure();
        await reconcileEnsureReleased;
      }
      return originalEnsureThread(...args);
    };

    const startupReconcile = service.reconcileAll();
    await reconcileEnsureEntered;
    const newer = await service.preview(OWNER, CAT, {
      ...ENABLED,
      rhythm: { kind: 'daily' },
      wakeTime: '21:15',
    });
    const newerDecision = service.decide(OWNER, newer.previewId, 'confirm');
    await new Promise((resolve) => setImmediate(resolve));
    releaseReconcileEnsure();
    await Promise.all([startupReconcile, newerDecision]);

    const config = await store.getCatLifeConfig(OWNER, CAT);
    assert.equal(config.revision, 2);
    assert.equal(config.settings.wakeTime, '21:15');
    const defs = dynamicStore.getAll();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].trigger.expression, '15 21 * * *');
    assert.equal(runner.registered.get(defs[0].id).spec.trigger.expression, '15 21 * * *');
  });

  test('disables legacy duplicate Present Loop definitions for the same owner and cat', async () => {
    dynamicStore.insert({
      id: 'legacy-present-loop',
      templateId: 'present-loop',
      trigger: { type: 'interval', ms: 3_600_000 },
      params: { targetCatId: CAT, triggerUserId: OWNER },
      display: { label: 'legacy', category: 'system' },
      deliveryThreadId: 'legacy-room',
      enabled: true,
      createdBy: 'legacy',
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    runner.registered.set('legacy-present-loop', { spec: {}, defId: 'legacy-present-loop' });

    const preview = await service.preview(OWNER, CAT, ENABLED);
    await service.decide(OWNER, preview.previewId, 'confirm');

    const defs = dynamicStore.getAll();
    assert.equal(defs.length, 2);
    assert.equal(defs.find((def) => def.id === 'legacy-present-loop').enabled, false);
    assert.equal(defs.filter((def) => def.enabled).length, 1);
    assert.equal(runner.registered.has('legacy-present-loop'), false);
  });

  test('fails closed instead of leaving a stale active projection when reconciliation fails', async () => {
    const first = await service.preview(OWNER, CAT, ENABLED);
    await service.decide(OWNER, first.previewId, 'confirm');
    const stableId = dynamicStore.getAll()[0].id;

    threadStore.ensureThread = () => {
      throw new Error('bedroom storage unavailable');
    };
    const changed = await service.preview(OWNER, CAT, { ...ENABLED, wakeTime: '21:45' });
    await assert.rejects(service.decide(OWNER, changed.previewId, 'confirm'), /bedroom storage unavailable/);

    assert.equal(dynamicStore.getAll().find((def) => def.id === stableId).enabled, false);
    assert.equal(runner.registered.has(stableId), false);
    const config = await store.getCatLifeConfig(OWNER, CAT);
    assert.equal(config.projectionStatus, 'error');
    assert.match(config.projectionError, /bedroom storage unavailable/);
  });

  test('rolls back persisted and partially registered projections when runtime registration fails', async () => {
    runner.registerDynamic = (spec, defId) => {
      runner.registered.set(spec.id, { spec, defId });
      throw new Error('runtime registration unavailable');
    };

    const preview = await service.preview(OWNER, CAT, ENABLED);
    await assert.rejects(service.decide(OWNER, preview.previewId, 'confirm'), /runtime registration unavailable/);

    const [persistedProjection] = dynamicStore.getAll();
    assert.equal(persistedProjection.enabled, false);
    assert.equal(runner.registered.has(persistedProjection.id), false);
    const config = await store.getCatLifeConfig(OWNER, CAT);
    assert.equal(config.projectionStatus, 'error');
    assert.match(config.projectionError, /runtime registration unavailable/);
  });

  test('startup reconciliation disables a projection whose configured cat is no longer available', async () => {
    const preview = await service.preview(OWNER, CAT, ENABLED);
    await service.decide(OWNER, preview.previewId, 'confirm');
    const stableId = dynamicStore.getAll()[0].id;

    fixture.setCatResolver((mentionOrId) =>
      mentionOrId === CAT
        ? {
            error: {
              kind: 'cat_disabled',
              catId: CAT,
              displayName: 'Sol',
              alternatives: [],
            },
          }
        : resolveTestCat(mentionOrId),
    );

    assert.deepEqual(await service.reconcileAll(), { reconciled: 0, disabledOrphans: 0, failed: 1 });
    assert.equal(dynamicStore.getById(stableId).enabled, false);
    assert.equal(runner.registered.has(stableId), false);
    const config = await store.getCatLifeConfig(OWNER, CAT);
    assert.equal(config.projectionStatus, 'error');
    assert.match(config.projectionError, /disabled/i);
    const readable = await service.getConfig(OWNER, CAT);
    assert.equal(readable.catId, CAT);
    assert.equal(readable.projectionStatus, 'error');
  });

  test('rejects invalid timezone and a wake time inside quiet hours before persisting preview', async () => {
    await assert.rejects(service.preview(OWNER, CAT, { ...ENABLED, timezone: 'Mars/Olympus' }), /timezone/i);
    await assert.rejects(
      service.preview(OWNER, CAT, {
        ...ENABLED,
        wakeTime: '07:30',
        quietHours: { start: '23:00', end: '08:00' },
      }),
      /quiet/i,
    );
    assert.equal(dynamicStore.getAll().length, 0);
    assert.equal(await store.getCatLifeConfig(OWNER, CAT), null);
  });
});
