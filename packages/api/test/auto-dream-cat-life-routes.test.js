import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { AutoDreamStore } from '../dist/domains/auto-dream/AutoDreamStore.js';
import { CatLifeSettingsService } from '../dist/domains/auto-dream/CatLifeSettingsService.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { registerAutoDreamRoutes } from '../dist/routes/auto-dream.js';

const OWNER = 'owner-a';
const CAT = 'codex-sol';
const SETTINGS = {
  enabled: true,
  rhythm: { kind: 'gentle' },
  wakeTime: '22:30',
  timezone: 'America/Los_Angeles',
  quietHours: { start: '00:00', end: '08:00' },
};

function resolveTestCat(mentionOrId) {
  const normalized = (mentionOrId.startsWith('@') ? mentionOrId.slice(1) : mentionOrId).toLowerCase();
  if (normalized === CAT) return { ok: CAT };
  if (normalized === 'disabled-cat') {
    return {
      error: {
        kind: 'cat_disabled',
        catId: 'disabled-cat',
        displayName: 'Disabled Cat',
        alternatives: [],
      },
    };
  }
  return { error: { kind: 'cat_not_found', mention: mentionOrId, alternatives: [] } };
}

describe('F255 owner-session cat-life and diary engagement routes', () => {
  let app;
  let store;
  let dynamicDb;
  let dynamicStore;
  let diaryId;

  beforeEach(async () => {
    store = new AutoDreamStore(':memory:');
    await store.initialize();
    dynamicDb = new Database(':memory:');
    applyMigrations(dynamicDb);
    dynamicStore = new DynamicTaskStore(dynamicDb);
    const threadStore = new ThreadStore();
    const registered = new Map();
    const settingsService = new CatLifeSettingsService({
      store,
      dynamicTaskStore: dynamicStore,
      taskRunner: {
        unregister: (id) => registered.delete(id),
        registerDynamic: (spec, id) => registered.set(id, spec),
      },
      templateRegistry: {
        get: (id) =>
          id === 'present-loop'
            ? {
                createSpec: (instanceId, params) => ({
                  id: instanceId,
                  trigger: params.trigger,
                  display: { label: 'private time', category: 'system' },
                }),
              }
            : null,
      },
      threadStore,
      privateOwnerUserId: OWNER,
      resolveCatTarget: resolveTestCat,
    });

    const started = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: 'thread-bedroom',
      taskId: 'task-present-loop',
      firedAt: Date.now(),
    });
    const settled = await store.settleRun(
      {
        kind: 'invocation',
        invocationId: 'inv-route',
        userId: OWNER,
        catId: CAT,
        threadId: 'thread-bedroom',
      },
      {
        runId: started.run.runId,
        outcome: 'diary',
        diary: {
          entryKind: 'souvenir',
          traceKind: 'non_work',
          localDate: '2026-07-19',
          headline: '一颗慢星',
          summary: '今晚在窗边待了一会儿。',
          bodyMarkdown: '今晚没有任务。我在窗边看见一颗慢慢亮起来的星。',
          provenance: [{ kind: 'thread_message', refId: 'message:route', threadId: 'thread-bedroom' }],
        },
      },
    );
    diaryId = settled.diary.diaryId;

    app = Fastify();
    app.decorateRequest('sessionUserId', undefined);
    app.addHook('preHandler', async (request) => {
      const header = request.headers['x-test-user'];
      request.sessionUserId = typeof header === 'string' ? header : undefined;
    });
    registerAutoDreamRoutes(app, { store, settingsService, ownerUserId: OWNER });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    store.close();
    dynamicDb.close();
  });

  test('keeps GET/default and cancelled previews side-effect free', async () => {
    const absent = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/cats/${CAT}/life-settings`,
      headers: { 'x-test-user': OWNER },
    });
    assert.equal(absent.statusCode, 200);
    assert.equal(absent.json().config, null);
    assert.equal(dynamicStore.getAll().length, 0);

    const forged = await app.inject({
      method: 'POST',
      url: `/api/auto-dream/cats/${CAT}/life-settings/preview`,
      headers: { 'x-test-user': OWNER },
      payload: { settings: SETTINGS, ownerUserId: 'owner-b' },
    });
    assert.equal(forged.statusCode, 400);

    const preview = await app.inject({
      method: 'POST',
      url: `/api/auto-dream/cats/${CAT}/life-settings/preview`,
      headers: { 'x-test-user': OWNER },
      payload: { settings: SETTINGS },
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(dynamicStore.getAll().length, 0);
    const cancelled = await app.inject({
      method: 'POST',
      url: '/api/auto-dream/life-settings/decision',
      headers: { 'x-test-user': OWNER },
      payload: { previewId: preview.json().previewId, decision: 'cancel' },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().config, null);
    assert.equal(dynamicStore.getAll().length, 0);
  });

  test('maps a direct-loopback browser session sentinel to the configured F255 owner', async () => {
    const lifeSettings = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/cats/${CAT}/life-settings`,
      headers: { 'x-test-user': 'default-user' },
    });
    assert.equal(lifeSettings.statusCode, 200);

    const diaries = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/diaries?catId=${CAT}`,
      headers: { 'x-test-user': 'default-user' },
    });
    assert.equal(diaries.statusCode, 200);
    assert.equal(diaries.json().diaries.length, 1);

    const opened = await app.inject({
      method: 'POST',
      url: `/api/auto-dream/diaries/${diaryId}/engagement`,
      headers: { 'x-test-user': 'default-user' },
      payload: { kind: 'open', clientEventId: 'browser-sentinel-open' },
    });
    assert.equal(opened.statusCode, 200);

    const foreignLifeSettings = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/cats/${CAT}/life-settings`,
      headers: { 'x-test-user': 'owner-b' },
    });
    assert.equal(foreignLifeSettings.statusCode, 403);
  });

  test('rejects a browser session sentinel outside a direct loopback request', async () => {
    const remoteRead = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/diaries?catId=${CAT}`,
      headers: { 'x-test-user': 'default-user' },
      remoteAddress: '203.0.113.10',
    });
    assert.equal(remoteRead.statusCode, 403);

    const remoteWrite = await app.inject({
      method: 'POST',
      url: `/api/auto-dream/cats/${CAT}/life-settings/preview`,
      headers: { 'x-test-user': 'default-user' },
      remoteAddress: '203.0.113.10',
      payload: { settings: SETTINGS },
    });
    assert.equal(remoteWrite.statusCode, 403);
    assert.equal(dynamicStore.getAll().length, 0);

    const proxiedRead = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/diaries?catId=${CAT}`,
      headers: {
        'x-test-user': 'default-user',
        'x-forwarded-for': '203.0.113.10',
      },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(proxiedRead.statusCode, 403);
  });

  test('confirms one projection and reads the same sanitized config', async () => {
    const preview = await app.inject({
      method: 'POST',
      url: `/api/auto-dream/cats/${CAT}/life-settings/preview`,
      headers: { 'x-test-user': OWNER },
      payload: { settings: SETTINGS },
    });
    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/auto-dream/life-settings/decision',
      headers: { 'x-test-user': OWNER },
      payload: { previewId: preview.json().previewId, decision: 'confirm' },
    });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.json().config.projectionStatus, 'ready');
    assert.equal(dynamicStore.getAll().length, 1);

    const read = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/cats/${CAT}/life-settings`,
      headers: { 'x-test-user': OWNER },
    });
    assert.deepEqual(read.json().config, confirmed.json().config);
    for (const forbidden of ['ownerUserId', 'projectionTaskId', 'bedroomThreadId', 'cronExpression']) {
      assert.equal(JSON.stringify(read.json()).includes(forbidden), false);
    }
  });

  test('returns typed 400 errors for unknown and disabled life-setting cats', async () => {
    for (const [catId, code] of [
      ['codex-slo', 'CAT_NOT_FOUND'],
      ['disabled-cat', 'CAT_DISABLED'],
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/auto-dream/cats/${catId}/life-settings/preview`,
        headers: { 'x-test-user': OWNER },
        payload: { settings: SETTINGS },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, code);
    }
    assert.equal(dynamicStore.getAll().length, 0);
  });

  test('returns collapsed/list engagement state and persists explicit open and reaction commands', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/diaries?catId=${CAT}`,
      headers: { 'x-test-user': OWNER },
    });
    assert.equal(listed.json().diaries[0].engagement.opened, false);
    assert.equal(listed.json().engagementMetrics.diaryOpenRate, 0);
    assert.equal('bodyMarkdown' in listed.json().diaries[0], false);
    assert.equal('provenance' in listed.json().diaries[0], false);
    assert.equal('observations' in listed.json().diaries[0], false);

    const prematureReaction = await app.inject({
      method: 'POST',
      url: `/api/auto-dream/diaries/${diaryId}/engagement`,
      headers: { 'x-test-user': OWNER },
      payload: { kind: 'reaction', clientEventId: 'route-reaction-too-early', active: true },
    });
    assert.equal(prematureReaction.statusCode, 409);
    assert.equal(prematureReaction.json().code, 'INVALID_ENGAGEMENT');

    const opened = await app.inject({
      method: 'POST',
      url: `/api/auto-dream/diaries/${diaryId}/engagement`,
      headers: { 'x-test-user': OWNER },
      payload: { kind: 'open', clientEventId: 'route-open-1' },
    });
    const reacted = await app.inject({
      method: 'POST',
      url: `/api/auto-dream/diaries/${diaryId}/engagement`,
      headers: { 'x-test-user': OWNER },
      payload: { kind: 'reaction', clientEventId: 'route-reaction-1', active: true },
    });
    assert.equal(opened.statusCode, 200);
    assert.equal(reacted.statusCode, 200);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/diaries/${diaryId}`,
      headers: { 'x-test-user': OWNER },
    });
    assert.equal(detail.json().diary.bodyMarkdown.includes('慢慢亮起来'), true);
    assert.deepEqual(detail.json().diary.engagement, { opened: true, reacted: true, openCount: 1 });

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/auto-dream/diaries/${diaryId}/engagement`,
      headers: { 'x-test-user': 'owner-b' },
      payload: { kind: 'open', clientEventId: 'foreign-open' },
    });
    assert.equal(foreign.statusCode, 404);
  });
});
