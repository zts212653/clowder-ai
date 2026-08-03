import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import { AutoDreamStore } from '../dist/domains/auto-dream/AutoDreamStore.js';
import { registerAutoDreamRoutes } from '../dist/routes/auto-dream.js';

const OWNER = 'owner-a';
const CAT = 'codex-sol';
const THREAD = 'thread-diary';

describe('F255 owner-session diary routes', () => {
  let app;
  let store;
  let diaryId;
  let proactiveVisitId;
  let proactiveSeedId;

  beforeEach(async () => {
    store = new AutoDreamStore(':memory:');
    await store.initialize();
    const started = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: THREAD,
      taskId: 'present-loop-route-test',
      firedAt: Date.now(),
    });
    const settled = await store.settleRun(
      { kind: 'invocation', invocationId: 'inv-route', userId: OWNER, catId: CAT, threadId: THREAD },
      {
        runId: started.run.runId,
        outcome: 'diary',
        diary: {
          entryKind: 'souvenir',
          traceKind: 'non_work',
          localDate: '2026-07-16',
          headline: '一页自己的时间',
          summary: '旧现场。',
          bodyMarkdown: '我在窗边待了一会儿。',
          provenance: [{ kind: 'thread_message', refId: 'message:one', threadId: THREAD }],
        },
      },
    );
    diaryId = settled.diary.diaryId;
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
      projectionTaskId: 'task-life-route',
      expiresAt: Date.now() + 60_000,
    });
    await store.decideCatLifePreview(OWNER, preview.previewId, 'confirm');
    const proactiveRun = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: THREAD,
      taskId: 'present-loop-proactive-route-test',
      firedAt: Date.now(),
    });
    const proactive = await store.settleRun(
      { kind: 'invocation', invocationId: 'inv-proactive-route', userId: OWNER, catId: CAT, threadId: THREAD },
      {
        runId: proactiveRun.run.runId,
        outcome: 'quiet',
        seedDecision: { kind: 'originate', claim: '我想在固定 home 靠近一次' },
        intent: {
          kind: 'body_language',
          seedRef: { kind: 'decision' },
          expressionKind: 'care',
          firstAction: { kind: 'attentive_pause', summary: '先安静等一个合适时机' },
        },
      },
    );
    proactiveVisitId = proactive.proactive.visit.visitId;
    proactiveSeedId = proactive.proactive.seed.seedId;
    await store.proactive.markProjected(OWNER, CAT, {
      visitId: proactiveVisitId,
      surface: { kind: 'body_language', refId: 'body-language-route-fixture' },
    });

    app = Fastify();
    app.decorateRequest('sessionUserId', undefined);
    app.addHook('preHandler', async (request) => {
      const header = request.headers['x-test-user'];
      request.sessionUserId = typeof header === 'string' ? header : undefined;
    });
    registerAutoDreamRoutes(app, {
      store,
      ownerUserId: OWNER,
      settingsService: {
        getConfig: async () => null,
        preview: async () => {
          throw new Error('not used');
        },
        decide: async () => {
          throw new Error('not used');
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  test('requires a session and never accepts owner identity from query', async () => {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/auto-dream/diaries' });
    assert.equal(unauthenticated.statusCode, 401);

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/diaries/${diaryId}?ownerUserId=${OWNER}`,
      headers: { 'x-test-user': 'owner-b' },
    });
    assert.equal(foreign.statusCode, 404);
  });

  test('lists and reads immutable historical pages only inside the session owner', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/diaries?catId=${CAT}&limit=5`,
      headers: { 'x-test-user': OWNER },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().diaries.length, 1);
    assert.equal(listed.json().metrics.reportificationWarning, false);

    const read = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/diaries/${diaryId}`,
      headers: { 'x-test-user': OWNER },
    });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json().diary, {
      diaryId,
      catId: CAT,
      localDate: '2026-07-16',
      headline: '一页自己的时间',
      summary: '旧现场。',
      bodyMarkdown: '我在窗边待了一会儿。',
      engagement: { opened: false, reacted: false, openCount: 0 },
    });
    assert.match(read.json().historicalNotice, /现场记录未清洗/);
  });

  test('projects off-duty and metrics without persisting a second status source', async () => {
    const live = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: THREAD,
      taskId: 'present-loop-live-status',
      firedAt: Date.now(),
    });
    const status = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/cats/${CAT}/status`,
      headers: { 'x-test-user': OWNER },
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().offDuty, true);
    assert.equal(status.json().metrics.outcomes.diary, 1);

    await store.failRun(OWNER, live.run.runId, 'test cleanup');
    const cleared = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/cats/${CAT}/status`,
      headers: { 'x-test-user': OWNER },
    });
    assert.equal(cleared.json().offDuty, false);
  });

  test('records and reads body-free typed echoes only inside the owner session', async () => {
    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/api/auto-dream/cats/${CAT}/proactive-echoes`,
      payload: { visitId: proactiveVisitId, kind: 'not_now', clientEventId: 'echo-ui-one' },
    });
    assert.equal(unauthenticated.statusCode, 401);

    const forged = await app.inject({
      method: 'POST',
      url: `/api/auto-dream/cats/${CAT}/proactive-echoes`,
      headers: { 'x-test-user': OWNER },
      payload: {
        visitId: proactiveVisitId,
        kind: 'not_now',
        clientEventId: 'echo-ui-one',
        ownerUserId: OWNER,
      },
    });
    assert.equal(forged.statusCode, 400);

    const request = {
      method: 'POST',
      url: `/api/auto-dream/cats/${CAT}/proactive-echoes`,
      headers: { 'x-test-user': OWNER },
      payload: { visitId: proactiveVisitId, kind: 'not_now', clientEventId: 'echo-ui-one' },
    };
    const first = await app.inject(request);
    const retry = await app.inject(request);
    assert.equal(first.statusCode, 200);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().echoId, first.json().echoId);
    assert.equal((await store.listOwnedSeeds(OWNER, CAT, { status: 'dormant' }))[0].seedId, proactiveSeedId);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/auto-dream/cats/${CAT}/proactive-echoes?limit=5`,
      headers: { 'x-test-user': OWNER },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().echoes.length, 1);
    assert.equal(listed.json().echoes[0].kind, 'not_now');
    assert.equal(JSON.stringify(listed.json()).includes('我想在固定 home'), false);
  });
});
