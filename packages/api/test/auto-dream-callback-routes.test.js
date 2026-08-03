import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import { AutoDreamStore } from '../dist/domains/auto-dream/AutoDreamStore.js';
import { PresentLoopService } from '../dist/domains/auto-dream/PresentLoopService.js';
import { ProactiveRelationshipService } from '../dist/domains/auto-dream/ProactiveRelationshipService.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { callbackAutoDreamRoutes } from '../dist/routes/callback-auto-dream-routes.js';

const OWNER = 'owner-a';
const CAT = 'codex-sol';
const THREAD = 'thread-present-loop';

function invocationRecord(overrides = {}) {
  return {
    invocationId: 'inv-current',
    callbackToken: 'token-current',
    userId: OWNER,
    catId: CAT,
    threadId: THREAD,
    clientMessageIds: new Set(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('F255 invocation-authenticated settlement routes', () => {
  let app;
  let store;
  let service;
  let settingsPreviewCalls;
  let messageStore;

  beforeEach(async () => {
    store = new AutoDreamStore(':memory:');
    await store.initialize();
    const preview = await store.createCatLifePreview({
      ownerUserId: OWNER,
      catId: CAT,
      settings: { enabled: true, rhythm: { kind: 'daily' }, wakeTime: '12:00', timezone: 'UTC' },
      derived: {
        cronExpression: '0 12 * * *',
        nextWakeAt: Date.now() + 86_400_000,
        weeklyWakeCount: 7,
        costBand: 'low',
        costNotice: 'fixture',
      },
      bedroomThreadId: THREAD,
      projectionTaskId: 'task-life-callback',
      expiresAt: Date.now() + 60_000,
    });
    await store.decideCatLifePreview(OWNER, preview.previewId, 'confirm');
    messageStore = new MessageStore();
    const proactiveRelationshipService = new ProactiveRelationshipService({ store, messageStore });
    service = new PresentLoopService(
      store,
      {
        reconcile: async () => ({ projected: 0, removed: 0, failed: 0 }),
      },
      OWNER,
      proactiveRelationshipService,
    );
    settingsPreviewCalls = [];
    const registry = {
      verify: async (invocationId, token) =>
        invocationId === 'inv-current' && token === 'token-current'
          ? { ok: true, record: invocationRecord() }
          : { ok: false, reason: 'invalid_token' },
    };
    const agentKeyRegistry = {
      verify: async () => ({
        ok: true,
        record: {
          agentKeyId: 'agent-key-one',
          catId: CAT,
          userId: OWNER,
          secretHash: 'hash',
          salt: 'salt',
          scope: 'user-bound',
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      }),
    };
    app = Fastify();
    await app.register(callbackAutoDreamRoutes, {
      registry,
      agentKeyRegistry,
      service,
      settingsService: {
        preview: async (ownerUserId, catId, settings) => {
          settingsPreviewCalls.push({ ownerUserId, catId, settings });
          return {
            previewId: 'lifepreview_callback',
            catId,
            settings,
            nextWakeAt: Date.now() + 60_000,
            weeklyWakeCount: 3,
            costBand: 'low',
            costNotice: '每次都可能调用模型。',
            expiresAt: Date.now() + 900_000,
          };
        },
      },
      store,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  async function begin(taskId) {
    return store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: THREAD,
      taskId,
      firedAt: Date.now(),
    });
  }

  test('rejects caller-supplied identity and rejects agent-key settlement', async () => {
    const started = await begin('reject-identity');
    const forged = await app.inject({
      method: 'POST',
      url: '/api/callbacks/auto-dream/settle',
      headers: { 'x-invocation-id': 'inv-current', 'x-callback-token': 'token-current' },
      payload: { runId: started.run.runId, outcome: 'quiet', ownerUserId: 'owner-b' },
    });
    assert.equal(forged.statusCode, 400);
    assert.equal((await store.getRun(OWNER, started.run.runId)).state, 'awakened');

    const agentKey = await app.inject({
      method: 'POST',
      url: '/api/callbacks/auto-dream/settle',
      headers: { 'x-agent-key-secret': 'persistent-secret' },
      payload: { runId: started.run.runId, outcome: 'quiet' },
    });
    assert.equal(agentKey.statusCode, 401);
    assert.equal((await store.getRun(OWNER, started.run.runId)).state, 'awakened');
  });

  test('derives owner, cat, thread, and invocation from auth and settles idempotently', async () => {
    const started = await begin('valid-settlement');
    const request = {
      method: 'POST',
      url: '/api/callbacks/auto-dream/settle',
      headers: { 'x-invocation-id': 'inv-current', 'x-callback-token': 'token-current' },
      payload: {
        runId: started.run.runId,
        outcome: 'diary',
        diary: {
          entryKind: 'evidence',
          traceKind: 'non_work',
          localDate: '2026-07-16',
          headline: '写给醒来的我',
          summary: '某天的一页。',
          bodyMarkdown: '今天没有要交差的东西。',
          provenance: [{ kind: 'thread_message', refId: 'message:source', threadId: THREAD }],
        },
        sleepPosture: {},
      },
    };
    const first = await app.inject(request);
    const retry = await app.inject(request);
    assert.equal(first.statusCode, 200);
    assert.equal(retry.statusCode, 200);
    assert.equal(first.json().run.settlementInvocationId, 'inv-current');
    assert.equal(first.json().diary.ownerUserId, OWNER);
    assert.equal(first.json().diary.catId, CAT);
    assert.equal(first.json().diary.sourceThreadId, THREAD);
    assert.equal(retry.json().diary.diaryId, first.json().diary.diaryId);
  });

  test('accepts a strict cat-owned seed and intent payload and delivers its canonical message', async () => {
    const started = await begin('proactive-settlement');
    const request = {
      method: 'POST',
      url: '/api/callbacks/auto-dream/settle',
      headers: { 'x-invocation-id': 'inv-current', 'x-callback-token': 'token-current' },
      payload: {
        runId: started.run.runId,
        outcome: 'quiet',
        seedDecision: { kind: 'originate', claim: '我惦记co-creator今天有没有休息' },
        intent: {
          kind: 'message',
          seedRef: { kind: 'decision' },
          expressionKind: 'care',
          firstAction: { kind: 'attentive_pause', summary: '先看了看今天的余温' },
          message: { body: '我惦记你今天有没有休息。' },
        },
      },
    };
    const first = await app.inject(request);
    const retry = await app.inject(request);
    assert.equal(first.statusCode, 200);
    assert.equal(retry.statusCode, 200);
    assert.equal(first.json().proactive.visit.homeThreadId, THREAD);
    assert.equal(retry.json().proactive.visit.canonicalMessageId, first.json().proactive.visit.canonicalMessageId);
    assert.equal((await messageStore.getByThread(THREAD, 10, OWNER)).length, 1);
  });

  test('allows owner-scoped agent-key reads but never cross-owner disclosure', async () => {
    const started = await begin('readable-diary');
    const settled = await store.settleRun(invocationRecord(), {
      runId: started.run.runId,
      outcome: 'diary',
      diary: {
        entryKind: 'souvenir',
        traceKind: 'non_work',
        localDate: '2026-07-16',
        headline: '一小页',
        summary: '旧现场。',
        bodyMarkdown: '翻到这一页。',
        provenance: [{ kind: 'thread_message', refId: 'message:read', threadId: THREAD }],
      },
    });
    const read = await app.inject({
      method: 'GET',
      url: `/api/callbacks/auto-dream/diaries/${settled.diary.diaryId}`,
      headers: { 'x-agent-key-secret': 'persistent-secret' },
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().diary.bodyMarkdown, '翻到这一页。');

    const missing = await app.inject({
      method: 'GET',
      url: '/api/callbacks/auto-dream/diaries/dream_unknown',
      headers: { 'x-agent-key-secret': 'persistent-secret' },
    });
    assert.equal(missing.statusCode, 404);
  });

  test('derives the owner for cat-life preview and rejects caller-supplied identity', async () => {
    const settings = {
      enabled: true,
      rhythm: { kind: 'gentle' },
      wakeTime: '22:30',
      timezone: 'America/Los_Angeles',
    };
    const forged = await app.inject({
      method: 'POST',
      url: '/api/callbacks/auto-dream/life-settings/preview',
      headers: { 'x-invocation-id': 'inv-current', 'x-callback-token': 'token-current' },
      payload: { catId: CAT, settings, ownerUserId: 'owner-b' },
    });
    assert.equal(forged.statusCode, 400);
    assert.equal(settingsPreviewCalls.length, 0);

    const preview = await app.inject({
      method: 'POST',
      url: '/api/callbacks/auto-dream/life-settings/preview',
      headers: { 'x-invocation-id': 'inv-current', 'x-callback-token': 'token-current' },
      payload: { catId: CAT, settings },
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().previewId, 'lifepreview_callback');
    assert.deepEqual(settingsPreviewCalls, [{ ownerUserId: OWNER, catId: CAT, settings }]);
  });
});
