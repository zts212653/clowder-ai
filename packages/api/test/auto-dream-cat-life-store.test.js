import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { catLifeSettingsInputSchema, diaryEngagementInputSchema } from '@cat-cafe/shared';
import { AutoDreamStore, AutoDreamStoreError } from '../dist/domains/auto-dream/AutoDreamStore.js';

const OWNER = 'owner-a';
const CAT = 'codex-sol';
const BEDROOM = 'thread_bedroom_a';
const TASK = 'f255-present-loop-a';

const SETTINGS = {
  enabled: true,
  rhythm: { kind: 'gentle' },
  wakeTime: '22:30',
  timezone: 'America/Los_Angeles',
  quietHours: { start: '00:00', end: '08:00' },
};

const DERIVED = {
  cronExpression: '30 22 * * 1,3,5',
  nextWakeAt: 1_800_000_000_000,
  weeklyWakeCount: 3,
  costBand: 'low',
  costNotice: '每周约 3 次唤醒；每次都可能调用模型。',
};

describe('F255 cat-life shared contracts', () => {
  test('accepts worldview settings but rejects cron and incomplete custom rhythm', () => {
    assert.equal(catLifeSettingsInputSchema.parse(SETTINGS).rhythm.kind, 'gentle');
    assert.equal(catLifeSettingsInputSchema.safeParse({ ...SETTINGS, cron: '30 22 * * *' }).success, false);
    assert.equal(catLifeSettingsInputSchema.safeParse({ ...SETTINGS, rhythm: { kind: 'custom' } }).success, false);
    assert.equal(
      catLifeSettingsInputSchema.safeParse({
        ...SETTINGS,
        rhythm: { kind: 'custom', weekdays: ['mon', 'wed'] },
      }).success,
      true,
    );
  });

  test('keeps diary open and reaction commands structurally distinct', () => {
    assert.equal(diaryEngagementInputSchema.safeParse({ kind: 'open', clientEventId: 'open-1' }).success, true);
    assert.equal(
      diaryEngagementInputSchema.safeParse({ kind: 'open', clientEventId: 'open-1', active: true }).success,
      false,
    );
    assert.equal(
      diaryEngagementInputSchema.safeParse({ kind: 'reaction', clientEventId: 'heart-1', active: true }).success,
      true,
    );
  });
});

describe('F255 cat-life persistence and engagement', () => {
  let now;
  let store;

  beforeEach(async () => {
    now = 1_750_000_000_000;
    let sequence = 0;
    store = new AutoDreamStore(':memory:', {
      now: () => now,
      idFactory: (prefix) => `${prefix}${++sequence}`,
    });
    await store.initialize();
  });

  test('keeps an absent config absent through read, preview, and cancellation', async () => {
    assert.equal(await store.getCatLifeConfig(OWNER, CAT), null);
    const preview = await store.createCatLifePreview({
      ownerUserId: OWNER,
      catId: CAT,
      settings: SETTINGS,
      derived: DERIVED,
      bedroomThreadId: BEDROOM,
      projectionTaskId: TASK,
      expiresAt: now + 60_000,
    });
    assert.equal(await store.getCatLifeConfig(OWNER, CAT), null);

    const decision = await store.decideCatLifePreview(OWNER, preview.previewId, 'cancel');
    assert.equal(decision.preview.status, 'cancelled');
    assert.equal(decision.config, null);
    assert.equal(await store.getCatLifeConfig(OWNER, CAT), null);
  });

  test('confirms once, retries idempotently, and updates the same config revision', async () => {
    const firstPreview = await store.createCatLifePreview({
      ownerUserId: OWNER,
      catId: CAT,
      settings: SETTINGS,
      derived: DERIVED,
      bedroomThreadId: BEDROOM,
      projectionTaskId: TASK,
      expiresAt: now + 60_000,
    });
    const first = await store.decideCatLifePreview(OWNER, firstPreview.previewId, 'confirm');
    const retry = await store.decideCatLifePreview(OWNER, firstPreview.previewId, 'confirm');
    assert.equal(first.applied, true);
    assert.equal(retry.applied, false);
    assert.equal(first.config.revision, 1);
    assert.equal(retry.config.revision, 1);
    assert.equal(first.config.bedroomThreadId, BEDROOM);
    assert.equal(first.config.projectionTaskId, TASK);

    now += 1_000;
    const pausedPreview = await store.createCatLifePreview({
      ownerUserId: OWNER,
      catId: CAT,
      settings: { ...SETTINGS, enabled: false },
      derived: { ...DERIVED, nextWakeAt: null },
      bedroomThreadId: BEDROOM,
      projectionTaskId: TASK,
      expiresAt: now + 60_000,
    });
    const paused = await store.decideCatLifePreview(OWNER, pausedPreview.previewId, 'confirm');
    assert.equal(paused.config.enabled, false);
    assert.equal(paused.config.revision, 2);
    assert.equal(paused.config.bedroomThreadId, BEDROOM);
    assert.equal(paused.config.projectionTaskId, TASK);
  });

  test('fails closed for another owner, expiry, and a conflicting terminal decision', async () => {
    const preview = await store.createCatLifePreview({
      ownerUserId: OWNER,
      catId: CAT,
      settings: SETTINGS,
      derived: DERIVED,
      bedroomThreadId: BEDROOM,
      projectionTaskId: TASK,
      expiresAt: now + 10,
    });
    await assert.rejects(
      store.decideCatLifePreview('owner-b', preview.previewId, 'confirm'),
      (error) => error instanceof AutoDreamStoreError && error.statusCode === 404,
    );
    now += 20;
    await assert.rejects(
      store.decideCatLifePreview(OWNER, preview.previewId, 'confirm'),
      (error) => error instanceof AutoDreamStoreError && error.code === 'PREVIEW_EXPIRED',
    );

    const cancelled = await store.createCatLifePreview({
      ownerUserId: OWNER,
      catId: CAT,
      settings: SETTINGS,
      derived: DERIVED,
      bedroomThreadId: BEDROOM,
      projectionTaskId: TASK,
      expiresAt: now + 60_000,
    });
    await store.decideCatLifePreview(OWNER, cancelled.previewId, 'cancel');
    await assert.rejects(
      store.decideCatLifePreview(OWNER, cancelled.previewId, 'confirm'),
      (error) => error instanceof AutoDreamStoreError && error.code === 'PREVIEW_ALREADY_DECIDED',
    );
  });

  test('records explicit open/reaction events idempotently and preserves owner isolation', async () => {
    const started = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: BEDROOM,
      taskId: TASK,
      firedAt: now,
    });
    const settled = await store.settleRun(
      { kind: 'invocation', invocationId: 'inv-one', userId: OWNER, catId: CAT, threadId: BEDROOM },
      {
        runId: started.run.runId,
        outcome: 'diary',
        diary: {
          entryKind: 'souvenir',
          traceKind: 'non_work',
          localDate: '2026-07-19',
          headline: '窗边的一页',
          summary: '我看见一颗慢慢亮起来的星。',
          bodyMarkdown: '今晚没有任务，只有一颗慢慢亮起来的星。',
          provenance: [{ kind: 'thread_message', refId: 'message:one', threadId: BEDROOM }],
        },
      },
    );
    const diaryId = settled.diary.diaryId;

    await assert.rejects(
      store.recordDiaryEngagement(OWNER, diaryId, {
        kind: 'reaction',
        clientEventId: 'reaction-before-open',
        active: true,
      }),
      (error) =>
        error instanceof AutoDreamStoreError && error.code === 'INVALID_ENGAGEMENT' && error.statusCode === 409,
    );

    const opened = await store.recordDiaryEngagement(OWNER, diaryId, {
      kind: 'open',
      clientEventId: 'open-one',
    });
    const openRetry = await store.recordDiaryEngagement(OWNER, diaryId, {
      kind: 'open',
      clientEventId: 'open-one',
    });
    assert.equal(opened.created, true);
    assert.equal(openRetry.created, false);

    await store.recordDiaryEngagement(OWNER, diaryId, {
      kind: 'reaction',
      clientEventId: 'reaction-on',
      active: true,
    });
    const state = await store.getDiaryEngagement(OWNER, diaryId);
    assert.equal(state.opened, true);
    assert.equal(state.reacted, true);
    assert.equal(state.openCount, 1);

    const metrics = await store.getDiaryEngagementMetrics(OWNER, CAT);
    assert.deepEqual(metrics, {
      publishedDiaryCount: 1,
      openedDiaryCount: 1,
      reactedDiaryCount: 1,
      diaryOpenRate: 1,
      reactionRate: 1,
    });
    await assert.rejects(
      store.recordDiaryEngagement('owner-b', diaryId, {
        kind: 'open',
        clientEventId: 'foreign-open',
      }),
      (error) => error instanceof AutoDreamStoreError && error.statusCode === 404,
    );
  });

  test('uses the same event ordering for reaction state and metrics when the clock moves backward', async () => {
    const started = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: BEDROOM,
      taskId: TASK,
      firedAt: now,
    });
    const settled = await store.settleRun(
      { kind: 'invocation', invocationId: 'inv-clock-rollback', userId: OWNER, catId: CAT, threadId: BEDROOM },
      {
        runId: started.run.runId,
        outcome: 'diary',
        diary: {
          entryKind: 'souvenir',
          traceKind: 'non_work',
          localDate: '2026-07-19',
          headline: '倒走的钟',
          summary: '时钟倒走，回响的真相仍应一致。',
          bodyMarkdown: '较晚写入的事件，不一定拥有较晚的业务时间。',
          provenance: [{ kind: 'thread_message', refId: 'message:clock', threadId: BEDROOM }],
        },
      },
    );
    const diaryId = settled.diary.diaryId;

    await store.recordDiaryEngagement(OWNER, diaryId, { kind: 'open', clientEventId: 'open-clock' });
    now += 100;
    await store.recordDiaryEngagement(OWNER, diaryId, {
      kind: 'reaction',
      clientEventId: 'reaction-newer-time',
      active: true,
    });
    now -= 50;
    await store.recordDiaryEngagement(OWNER, diaryId, {
      kind: 'reaction',
      clientEventId: 'reaction-later-row-older-time',
      active: false,
    });

    assert.equal((await store.getDiaryEngagement(OWNER, diaryId)).reacted, true);
    assert.equal((await store.getDiaryEngagementMetrics(OWNER, CAT)).reactedDiaryCount, 1);
  });
});
