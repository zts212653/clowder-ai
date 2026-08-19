import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AutoDreamStore } from '../dist/domains/auto-dream/AutoDreamStore.js';
import { PresentLoopService } from '../dist/domains/auto-dream/PresentLoopService.js';
import { ProactiveRelationshipService } from '../dist/domains/auto-dream/ProactiveRelationshipService.js';
import { renderPresentLoopPrompt } from '../dist/domains/auto-dream/present-loop-contract.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createPresentLoopTemplate } from '../dist/infrastructure/scheduler/templates/present-loop.js';

const OWNER = 'owner-a';
const CAT = 'codex-sol';
const THREAD = 'thread-private-time';
const REQUIRED_CONTRACT_CLAUSES = ['这段时间归你', '不打分', '今天没啥', '发呆是正经事'];
const FORBIDDEN_PERFORMANCE_TERMS = [
  'kpi',
  'quota',
  'score',
  'mandatory output',
  'must publish',
  '必须产出',
  '产出配额',
  '绩效',
  '打卡',
];

describe('F255 present-loop contract and scheduler template', () => {
  let store;
  let service;
  let messageStore;

  beforeEach(async () => {
    store = new AutoDreamStore(':memory:');
    await store.initialize();
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
  });

  afterEach(() => store.close());

  test('renders all anti-performance clauses and no output quota vocabulary', () => {
    const prompt = renderPresentLoopPrompt({
      runId: 'dreamrun_contract',
      schedule: {
        triggerKind: 'cron',
        scheduledAt: '2026-07-17T02:00:00.000Z',
        firedAt: '2026-07-17T02:00:00.000Z',
        latenessMs: 0,
        missedSlots: 0,
        late: false,
      },
      continuity: null,
    });

    for (const clause of REQUIRED_CONTRACT_CLAUSES) assert.match(prompt, new RegExp(clause));
    for (const banned of FORBIDDEN_PERFORMANCE_TERMS) assert.equal(prompt.toLowerCase().includes(banned), false);
    assert.match(prompt, /cat_cafe_settle_present_loop/);
    assert.match(prompt, /quiet.*daze/s);
  });

  test('leases one sleep posture to the next wake and dispatches a hidden trigger once per slot', async () => {
    const preview = await store.createCatLifePreview({
      ownerUserId: OWNER,
      catId: CAT,
      settings: { enabled: true, rhythm: { kind: 'daily' }, wakeTime: '02:42', timezone: 'UTC' },
      derived: {
        cronExpression: '42 2 * * *',
        nextWakeAt: Date.now() + 86_400_000,
        weeklyWakeCount: 7,
        costBand: 'low',
        costNotice: 'fixture',
      },
      bedroomThreadId: THREAD,
      projectionTaskId: 'task-life-sol',
      expiresAt: Date.now() + 60_000,
    });
    await store.decideCatLifePreview(OWNER, preview.previewId, 'confirm');
    const setup = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: THREAD,
      taskId: 'setup',
      firedAt: Date.now(),
    });
    const setupSettlement = await store.settleRun(
      { kind: 'invocation', invocationId: 'inv-setup', userId: OWNER, catId: CAT, threadId: THREAD },
      {
        runId: setup.run.runId,
        outcome: 'quiet',
        sleepPosture: { lastRoom: '窗边', curiosity: '月光去哪了' },
        seedDecision: { kind: 'originate', claim: '窗边那个秘密愿望' },
        intent: {
          kind: 'silence',
          seedRef: { kind: 'decision' },
          expressionKind: 'discover',
          firstAction: { kind: 'evidence_check', summary: '先确认月光落在哪里' },
        },
      },
    );
    await store.ingestPendingCue({
      outputId: 'output-private-cue',
      ownerUserId: OWNER,
      catId: CAT,
      kind: 'desire_cue',
      normalizedClaim: '只有猫在私人时间才能读的线索',
      reason: '不能写进持久 trigger',
      sourceRef: { threadId: 'thread-source', messageId: 'message-source' },
      producer: 'f271-session-close-v1',
      createdAt: '2026-07-17T01:00:00.000Z',
    });

    const template = createPresentLoopTemplate({ service });
    const spec = template.createSpec('dyn-present-loop-codex-sol', {
      trigger: { type: 'cron', expression: '42 * * * *', timezone: 'America/Los_Angeles' },
      params: { targetCatId: CAT, triggerUserId: OWNER },
      deliveryThreadId: THREAD,
    });
    const gate = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gate.run, true);
    if (!gate.run) return;

    const deliveries = [];
    const invocations = [];
    const context = {
      assignedCatId: null,
      schedule: {
        triggerKind: 'cron',
        scheduledAt: '2026-07-17T02:42:00.000Z',
        firedAt: '2026-07-17T03:42:00.000Z',
        latenessMs: 3_600_000,
        missedSlots: 1,
        late: true,
        misfirePolicy: 'merge_late_one',
      },
      deliver: async (message) => {
        deliveries.push(message);
        return 'message-present-loop';
      },
      invokeTrigger: {
        trigger: async (...args) => {
          invocations.push(args);
          return 'dispatched';
        },
      },
    };

    await spec.run.execute(null, `thread-${THREAD}`, context);
    await spec.run.execute(null, `thread-${THREAD}`, context);

    assert.equal(deliveries.length, 1, 'same task slot must not dispatch twice');
    assert.equal(invocations.length, 1);
    assert.equal(deliveries[0].extra.scheduler.hiddenTrigger, true);
    assert.match(deliveries[0].content, /runId=/);
    assert.doesNotMatch(deliveries[0].content, /窗边|月光去哪了|秘密愿望|私人时间才能读的线索/);
    assert.match(invocations[0][3], /窗边/);
    assert.match(invocations[0][3], /月光去哪了/);
    assert.match(invocations[0][3], /秘密愿望/);
    assert.match(invocations[0][3], /私人时间才能读的线索/);
    assert.match(invocations[0][3], /迟到 60 分钟/);
    assert.match(invocations[0][3], /missedSlots=1/);
    assert.doesNotMatch(invocations[0][3], /剩余额度|今日还可/);
    assert.equal(await store.isOffDuty(OWNER, CAT), true);
    const handed = await store.getSleepPosture(OWNER, setupSettlement.sleepPosture.postureId);
    assert.equal(handed?.status, 'pending');
  });

  test('marks the run wake_failed when trigger dispatch fails so off-duty never sticks', async () => {
    const setup = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: THREAD,
      taskId: 'setup-failure-posture',
      firedAt: Date.now(),
    });
    const settled = await store.settleRun(
      { kind: 'invocation', invocationId: 'inv-setup-failure', userId: OWNER, catId: CAT, threadId: THREAD },
      {
        runId: setup.run.runId,
        outcome: 'quiet',
        sleepPosture: { unfinishedThought: '失败以后还要回来' },
      },
    );
    const template = createPresentLoopTemplate({ service });
    const spec = template.createSpec('dyn-present-loop-failure', {
      trigger: { type: 'once', fireAt: Date.now() },
      params: { targetCatId: CAT, triggerUserId: OWNER },
      deliveryThreadId: THREAD,
    });

    await assert.rejects(() =>
      spec.run.execute(null, `thread-${THREAD}`, {
        assignedCatId: null,
        deliver: async () => 'message-failure',
        invokeTrigger: {
          trigger: async () => {
            throw new Error('synthetic dispatch failure');
          },
        },
      }),
    );
    assert.equal(await store.isOffDuty(OWNER, CAT), false);
    assert.equal((await service.getLatestRun(OWNER, CAT))?.state, 'wake_failed');
    const preserved = await store.getSleepPosture(OWNER, settled.sleepPosture.postureId);
    assert.equal(preserved?.status, 'pending');
    assert.equal(preserved?.leasedByRunId, undefined);
  });

  test('treats a full invocation queue as wake_failed instead of a successful wake', async () => {
    const template = createPresentLoopTemplate({ service });
    const spec = template.createSpec('dyn-present-loop-queue-full', {
      trigger: { type: 'once', fireAt: Date.now() },
      params: { targetCatId: CAT, triggerUserId: OWNER },
      deliveryThreadId: THREAD,
    });

    await assert.rejects(
      () =>
        spec.run.execute(null, `thread-${THREAD}`, {
          assignedCatId: null,
          deliver: async () => 'message-queue-full',
          invokeTrigger: { trigger: async () => 'full' },
        }),
      /invocation queue is full/,
    );

    assert.equal(await store.isOffDuty(OWNER, CAT), false);
    assert.equal((await service.getLatestRun(OWNER, CAT))?.state, 'wake_failed');
  });

  test('fails closed when a schedule or callback owner differs from the private diary collection owner', async () => {
    const template = createPresentLoopTemplate({ service });
    const foreignSpec = template.createSpec('dyn-present-loop-foreign-owner', {
      trigger: { type: 'interval', ms: 3_600_000 },
      params: { targetCatId: CAT, triggerUserId: 'owner-b' },
      deliveryThreadId: THREAD,
    });
    assert.deepEqual(await foreignSpec.admission.gate({ taskId: foreignSpec.id, lastRunAt: null, tickCount: 1 }), {
      run: false,
      reason: 'owner is not configured for private diary persistence',
    });

    const foreignRun = await store.beginRun({
      ownerUserId: 'owner-b',
      catId: CAT,
      threadId: THREAD,
      taskId: 'foreign-owner-run',
      firedAt: Date.now(),
    });
    await assert.rejects(
      () =>
        service.settle(
          { kind: 'invocation', invocationId: 'inv-owner-b', userId: 'owner-b', catId: CAT, threadId: THREAD },
          { runId: foreignRun.run.runId, outcome: 'quiet' },
        ),
      (error) => error.code === 'OWNER_NOT_CONFIGURED',
    );
    assert.equal((await store.getRun('owner-b', foreignRun.run.runId))?.state, 'awakened');
  });
});
