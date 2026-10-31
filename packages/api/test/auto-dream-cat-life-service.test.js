import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { CAT, createCatLifeServiceFixture, ENABLED, OWNER } from './helpers/auto-dream-cat-life-fixture.js';

describe('F255 CatLifeSettingsService projection', () => {
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

  test('does not create config, task, or bedroom for an empty owner', async () => {
    assert.equal(await service.getConfig(OWNER, CAT), null);
    assert.deepEqual(await service.reconcileAll(), { reconciled: 0, disabledOrphans: 0, failed: 0 });
    assert.equal(dynamicStore.getAll().length, 0);
    assert.equal(threadStore.list(OWNER).length, 0);
  });

  test('canonicalizes mention-style cat IDs before preview persistence and projection', async () => {
    const preview = await service.preview(OWNER, '@codex-sol', ENABLED);
    assert.equal(preview.catId, CAT);

    const confirmed = await service.decide(OWNER, preview.previewId, 'confirm');
    assert.equal(confirmed.config.catId, CAT);
    assert.equal((await store.getCatLifeConfig(OWNER, CAT)).catId, CAT);
    assert.equal(await store.getCatLifeConfig(OWNER, '@codex-sol'), null);
    assert.equal(dynamicStore.getAll()[0].params.targetCatId, CAT);
    assert.deepEqual(threadStore.list(OWNER)[0].participants, [CAT]);
  });

  test('rejects unknown and disabled cat IDs before any life-setting side effect', async () => {
    await assert.rejects(service.preview(OWNER, 'codex-slo', ENABLED), (error) => {
      assert.equal(error.code, 'CAT_NOT_FOUND');
      return true;
    });
    await assert.rejects(service.preview(OWNER, 'disabled-cat', ENABLED), (error) => {
      assert.equal(error.code, 'CAT_DISABLED');
      return true;
    });

    assert.equal(dynamicStore.getAll().length, 0);
    assert.equal(threadStore.list(OWNER).length, 0);
    assert.equal((await store.listCatLifeConfigs(OWNER)).length, 0);
  });

  test('preview and cancellation have no projection side effect and hide execution details', async () => {
    const preview = await service.preview(OWNER, CAT, ENABLED);
    assert.equal(preview.catId, CAT);
    assert.equal(preview.weeklyWakeCount, 3);
    assert.equal(preview.costBand, 'low');
    assert.match(preview.costNotice, /模型/);
    assert.ok(preview.nextWakeAt > Date.parse('2026-07-19T20:00:00Z'));
    assert.equal(JSON.stringify(preview).includes('cron'), false);
    assert.equal(JSON.stringify(preview).includes('task'), false);
    assert.equal(JSON.stringify(preview).includes('thread'), false);
    assert.equal(dynamicStore.getAll().length, 0);
    assert.equal(threadStore.list(OWNER).length, 0);

    const cancelled = await service.decide(OWNER, preview.previewId, 'cancel');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.config, null);
    assert.equal(dynamicStore.getAll().length, 0);
    assert.equal(threadStore.list(OWNER).length, 0);
  });

  test('keeps an enabled public next wake in the future after late confirmation and later reads', async () => {
    const preview = await service.preview(OWNER, CAT, {
      ...ENABLED,
      rhythm: { kind: 'daily' },
      wakeTime: '13:05',
    });
    assert.equal(preview.nextWakeAt, Date.parse('2026-07-19T20:05:00Z'));

    fixture.setNow(Date.parse('2026-07-19T20:06:00Z'));
    const confirmed = await service.decide(OWNER, preview.previewId, 'confirm');
    assert.ok(confirmed.config.nextWakeAt > fixture.now());

    fixture.setNow(confirmed.config.nextWakeAt + 1);
    const reread = await service.getConfig(OWNER, CAT);
    assert.ok(reread.nextWakeAt > fixture.now());
  });

  test('confirmation creates one stable bedroom and one stable projection', async () => {
    const preview = await service.preview(OWNER, CAT, ENABLED);
    const confirmed = await service.decide(OWNER, preview.previewId, 'confirm');
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.config.catId, CAT);
    assert.equal(confirmed.config.enabled, true);
    assert.equal(confirmed.config.projectionStatus, 'ready');
    assert.equal(JSON.stringify(confirmed).includes('projectionTaskId'), false);
    assert.equal(JSON.stringify(confirmed).includes('bedroomThreadId'), false);
    assert.equal(JSON.stringify(confirmed).includes('cronExpression'), false);

    const defs = dynamicStore.getAll();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].templateId, 'present-loop');
    assert.equal(defs[0].params.targetCatId, CAT);
    assert.equal(defs[0].params.triggerUserId, OWNER);
    assert.equal(defs[0].params.managedBy, 'f255-cat-life');
    assert.equal(defs[0].trigger.type, 'cron');
    assert.equal(defs[0].trigger.timezone, ENABLED.timezone);
    assert.equal(runner.registered.size, 1);

    const bedrooms = threadStore.list(OWNER);
    assert.equal(bedrooms.length, 1);
    assert.equal(bedrooms[0].systemKind, 'cat_bedroom');
    assert.deepEqual(bedrooms[0].participants, [CAT]);
    assert.deepEqual(bedrooms[0].preferredCats, [CAT]);
  });

  test('startup reconciliation heals a legacy bedroom missing its system identity', async () => {
    const preview = await service.preview(OWNER, CAT, ENABLED);
    await service.decide(OWNER, preview.previewId, 'confirm');
    const [bedroom] = threadStore.list(OWNER);

    threadStore.updateSystemKind(bedroom.id, null);
    assert.equal(threadStore.get(bedroom.id).systemKind, undefined);

    assert.deepEqual(await service.reconcileAll(), { reconciled: 1, disabledOrphans: 0, failed: 0 });
    assert.equal(threadStore.get(bedroom.id).systemKind, 'cat_bedroom');
  });

  test('edit, pause, resume, and concurrent confirm retries reuse one projection identity', async () => {
    const first = await service.preview(OWNER, CAT, ENABLED);
    await Promise.all([
      service.decide(OWNER, first.previewId, 'confirm'),
      service.decide(OWNER, first.previewId, 'confirm'),
    ]);
    const stableId = dynamicStore.getAll()[0].id;

    const paused = await service.preview(OWNER, CAT, { ...ENABLED, enabled: false });
    assert.equal(paused.nextWakeAt, null);
    assert.equal(paused.weeklyWakeCount, 0);
    assert.match(paused.costNotice, /暂停/);
    assert.match(paused.costNotice, /不会产生模型唤醒/);
    const pausedResult = await service.decide(OWNER, paused.previewId, 'confirm');
    assert.equal(pausedResult.config.enabled, false);
    assert.equal(pausedResult.config.nextWakeAt, null);
    assert.equal(pausedResult.config.revision, 2);
    assert.equal(dynamicStore.getAll().length, 1);
    assert.equal(dynamicStore.getAll()[0].id, stableId);
    assert.equal(dynamicStore.getAll()[0].enabled, false);
    assert.equal(runner.registered.size, 0);

    const resumed = await service.preview(OWNER, CAT, {
      ...ENABLED,
      rhythm: { kind: 'custom', weekdays: ['tue', 'thu'] },
      wakeTime: '21:15',
    });
    const resumedResult = await service.decide(OWNER, resumed.previewId, 'confirm');
    assert.equal(resumedResult.config.revision, 3);
    assert.equal(dynamicStore.getAll().length, 1);
    assert.equal(dynamicStore.getAll()[0].id, stableId);
    assert.equal(dynamicStore.getAll()[0].trigger.expression, '15 21 * * 2,4');
    assert.equal(runner.registered.size, 1);
    assert.equal(threadStore.list(OWNER).length, 1);
  });
});
