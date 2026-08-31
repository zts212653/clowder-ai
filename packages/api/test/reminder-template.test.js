import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import { reminderTemplate } from '../dist/infrastructure/scheduler/templates/reminder.js';

describe('reminderTemplate', () => {
  it('gate returns run:true with thread workItem when deliveryThreadId set', async () => {
    const spec = reminderTemplate.createSpec('rem-1', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: '喝水提醒' },
      deliveryThreadId: 'th-abc',
    });
    const result = await spec.admission.gate({ taskId: 'rem-1', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].subjectKey, 'thread-th-abc');
    assert.equal(result.workItems[0].signal, '喝水提醒');
  });

  it('gate returns run:false when no deliveryThreadId', async () => {
    const spec = reminderTemplate.createSpec('rem-2', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'test' },
      deliveryThreadId: null,
    });
    const result = await spec.admission.gate({ taskId: 'rem-2', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false);
  });

  it('execute calls deliver with message content and threadId', async () => {
    const deliverMock = mock.fn(async () => 'msg-1');
    const triggerMock = { trigger: mock.fn() };
    const spec = reminderTemplate.createSpec('rem-3', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: '喝水提醒' },
      deliveryThreadId: 'th-abc',
    });
    await spec.run.execute('喝水提醒', 'thread-th-abc', {
      assignedCatId: 'opus',
      deliver: deliverMock,
      invokeTrigger: triggerMock,
    });
    assert.equal(deliverMock.mock.calls.length, 1);
    const arg = deliverMock.mock.calls[0].arguments[0];
    assert.equal(arg.content, `${SCHEDULER_TRIGGER_PREFIX} 喝水提醒`);
    assert.equal(arg.threadId, 'th-abc');
    assert.equal(arg.catId, undefined);
    assert.equal(arg.extra.scheduler.hiddenTrigger, true);
  });

  it('adds late cron timing to the scheduler trigger prompt', async () => {
    const deliverMock = mock.fn(async () => 'msg-late');
    const triggerMock = { trigger: mock.fn() };
    const spec = reminderTemplate.createSpec('rem-late', {
      trigger: { type: 'cron', expression: '42 * * * *', timezone: 'UTC' },
      params: { message: '小本本' },
      deliveryThreadId: 'th-late',
    });
    await spec.run.execute('小本本', 'thread-th-late', {
      assignedCatId: 'codex',
      deliver: deliverMock,
      invokeTrigger: triggerMock,
      schedule: {
        triggerKind: 'cron',
        scheduledAt: '2026-07-07T18:42:00.000Z',
        firedAt: '2026-07-07T19:13:00.000Z',
        latenessMs: 31 * 60 * 1000,
        missedSlots: 0,
        late: true,
        misfirePolicy: 'merge_late_one',
      },
    });

    const content = deliverMock.mock.calls[0].arguments[0].content;
    assert.match(content, /本次是 2026-07-07T18:42:00\.000Z 预定任务的补拍/);
    assert.match(content, /实际 2026-07-07T19:13:00\.000Z 触发/);
    assert.match(content, /迟到 31 分钟/);
    assert.match(content, /小本本/);
  });

  it('deliver payload stays cat-agnostic when assignedCatId is null', async () => {
    const deliverMock = mock.fn(async () => 'msg-2');
    const spec = reminderTemplate.createSpec('rem-4', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'test' },
      deliveryThreadId: 'th-xyz',
    });
    await spec.run.execute('test', 'thread-th-xyz', {
      assignedCatId: null,
      deliver: deliverMock,
    });
    assert.equal(deliverMock.mock.calls[0].arguments[0].catId, undefined);
  });

  it('keeps trigger visible when invokeTrigger is unavailable', async () => {
    const deliverMock = mock.fn(async () => 'msg-visible');
    const spec = reminderTemplate.createSpec('rem-visible', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: '看得见的提醒' },
      deliveryThreadId: 'th-visible',
    });
    await spec.run.execute('看得见的提醒', 'thread-th-visible', {
      assignedCatId: 'opus',
      deliver: deliverMock,
    });
    assert.equal(deliverMock.mock.calls[0].arguments[0].extra, undefined);
  });

  it('execute throws when deliver is not available', async () => {
    const spec = reminderTemplate.createSpec('rem-5', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'test' },
      deliveryThreadId: 'th-xyz',
    });
    await assert.rejects(
      () => spec.run.execute('test', 'thread-th-xyz', { assignedCatId: null }),
      /deliver not available/,
    );
  });

  it('execute uses targetCatId param over assignedCatId fallback', async () => {
    const deliverMock = mock.fn(async () => 'msg-target');
    const triggerMock = { trigger: mock.fn() };
    const spec = reminderTemplate.createSpec('rem-target', {
      trigger: { type: 'interval', ms: 180_000 },
      params: { message: '巡查新闻', targetCatId: 'gpt52' },
      deliveryThreadId: 'th-target',
    });
    await spec.run.execute('巡查新闻', 'thread-th-target', {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: triggerMock,
    });
    // invokeTrigger should be called with gpt52, not opus
    assert.equal(triggerMock.trigger.mock.calls.length, 1);
    assert.equal(triggerMock.trigger.mock.calls[0].arguments[1], 'gpt52');
  });

  it('execute falls back to assignedCatId when no targetCatId', async () => {
    const deliverMock = mock.fn(async () => 'msg-assigned');
    const triggerMock = { trigger: mock.fn() };
    const spec = reminderTemplate.createSpec('rem-assigned', {
      trigger: { type: 'interval', ms: 180_000 },
      params: { message: '巡查新闻' },
      deliveryThreadId: 'th-assigned',
    });
    await spec.run.execute('巡查新闻', 'thread-th-assigned', {
      assignedCatId: 'sonnet',
      deliver: deliverMock,
      invokeTrigger: triggerMock,
    });
    assert.equal(triggerMock.trigger.mock.calls[0].arguments[1], 'sonnet');
  });

  it('F257 LI-001: hold-ball reminder opts into action-or-routing-exit completion', async () => {
    const deliverMock = mock.fn(async () => 'msg-hold-wake');
    const triggerMock = { trigger: mock.fn() };
    const spec = reminderTemplate.createSpec('hold-ball-1748000000-liveness', {
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: { message: '持球唤醒', targetCatId: 'gpt52' },
      deliveryThreadId: 'th-hold-liveness',
    });

    await spec.run.execute('持球唤醒', 'thread-th-hold-liveness', {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: triggerMock,
    });

    assert.equal(triggerMock.trigger.mock.calls[0].arguments[6]?.completionRequirement, 'action-or-routing-exit');
  });

  it('F257 LI-001: ordinary reminder does not opt into action liveness', async () => {
    const deliverMock = mock.fn(async () => 'msg-normal-reminder');
    const triggerMock = { trigger: mock.fn() };
    const spec = reminderTemplate.createSpec('dyn-1748000000-normal', {
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: { message: 'ordinary reminder', targetCatId: 'gpt52' },
      deliveryThreadId: 'th-normal-reminder',
    });

    await spec.run.execute('ordinary reminder', 'thread-th-normal-reminder', {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: triggerMock,
    });

    assert.equal(triggerMock.trigger.mock.calls[0].arguments[6]?.completionRequirement, undefined);
  });

  it('uses default message when param is empty', async () => {
    const deliverMock = mock.fn(async () => 'msg-3');
    const spec = reminderTemplate.createSpec('rem-6', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: {},
      deliveryThreadId: 'th-abc',
    });
    const result = await spec.admission.gate({ taskId: 'rem-6', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].signal, '定时提醒');
    await spec.run.execute('定时提醒', 'thread-th-abc', {
      assignedCatId: 'opus',
      deliver: deliverMock,
    });
    assert.equal(deliverMock.mock.calls[0].arguments[0].content, `${SCHEDULER_TRIGGER_PREFIX} 定时提醒`);
  });
});

describe('reminderTemplate firePolicy activation guard (F167 Phase M — codex P1)', () => {
  const FUTURE = 9_999_999_999_000;

  it('does NOT activate firePolicy for non-hold-ball dyn-* task even if params forge deferWhileThreadBusy', () => {
    // /api/schedule/tasks generates dyn-* ids + accepts arbitrary params (schedule.ts:417).
    // A forged deferWhileThreadBusy must NOT activate pre-fire defer on a public reminder.
    const spec = reminderTemplate.createSpec('dyn-1748000000-abc123', {
      trigger: { type: 'once', fireAt: FUTURE },
      params: { message: 'forged', deferWhileThreadBusy: true },
      deliveryThreadId: 'th-forge',
    });
    assert.equal(spec.firePolicy, undefined, 'forged dyn-* reminder must NOT get firePolicy');
  });

  it('activates firePolicy only for hold-ball-* instanceId with deferWhileThreadBusy', () => {
    const spec = reminderTemplate.createSpec('hold-ball-1748000000-abc123', {
      trigger: { type: 'once', fireAt: FUTURE },
      params: { message: 'wake', deferWhileThreadBusy: true },
      deliveryThreadId: 'th-hold',
    });
    assert.ok(spec.firePolicy, 'hold-ball-* + deferWhileThreadBusy gets firePolicy');
    assert.equal(spec.firePolicy.deferWhileThreadBusy, true);
    assert.equal(spec.firePolicy.threadId, 'th-hold');
  });

  it('ignores caller-supplied deferIntervalMs/maxDefers (no churn injection via public params)', () => {
    // deferIntervalMs:0 + huge maxDefers would cause 0ms re-arm churn on a busy thread.
    // Defer tuning must come from TaskRunnerV2 internal defaults, never public params.
    const spec = reminderTemplate.createSpec('hold-ball-1748000000-xyz', {
      trigger: { type: 'once', fireAt: FUTURE },
      params: { message: 'wake', deferWhileThreadBusy: true, deferIntervalMs: 0, maxDefers: 999999 },
      deliveryThreadId: 'th-hold2',
    });
    assert.ok(spec.firePolicy);
    assert.equal(spec.firePolicy.deferIntervalMs, undefined, 'deferIntervalMs must not be readable from public params');
    assert.equal(spec.firePolicy.maxDefers, undefined, 'maxDefers must not be readable from public params');
  });

  it('does not set firePolicy when deferWhileThreadBusy is absent', () => {
    const spec = reminderTemplate.createSpec('hold-ball-1748000000-nodefer', {
      trigger: { type: 'once', fireAt: FUTURE },
      params: { message: 'wake' },
      deliveryThreadId: 'th-nodefer',
    });
    assert.equal(spec.firePolicy, undefined);
  });
});

describe('reminderTemplate — once-trigger idempotency (sol P1 regression收口)', () => {
  it('once trigger passes a per-instance idempotencyKey to deliver (bounded-retry safe)', async () => {
    const deliverMock = mock.fn(async () => 'msg-once');
    const spec = reminderTemplate.createSpec('hold-ball-1748000000-idem', {
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: { message: 'wake' },
      deliveryThreadId: 'th-idem',
    });
    await spec.run.execute('wake', 'thread-th-idem', { assignedCatId: null, deliver: deliverMock });
    assert.equal(deliverMock.mock.calls[0].arguments[0].idempotencyKey, 'reminder:hold-ball-1748000000-idem');
  });

  it('cron trigger does NOT pass idempotencyKey (each slot is a distinct firing)', async () => {
    const deliverMock = mock.fn(async () => 'msg-cron');
    const spec = reminderTemplate.createSpec('rem-cron-idem', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: '喝水提醒' },
      deliveryThreadId: 'th-cron-idem',
    });
    await spec.run.execute('喝水提醒', 'thread-th-cron-idem', { assignedCatId: null, deliver: deliverMock });
    assert.equal(deliverMock.mock.calls[0].arguments[0].idempotencyKey, undefined);
  });

  it('REGRESSION red→green: hold-ball once wake persists with system provenance via real store', async () => {
    // 2026-07-20 → 23 incident: this exact path threw `append requires
    // provenance` at the write boundary (RUN_FAILED → silent retire → lost
    // hold-ball wake). End-to-end through the REAL in-memory MessageStore.
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { createDeliverFn } = await import('../dist/infrastructure/scheduler/delivery.js');
    const messageStore = new MessageStore();
    const deliver = createDeliverFn({
      messageStore,
      socketManager: { broadcastToRoom: () => {}, emitToUser: () => {} },
    });
    const spec = reminderTemplate.createSpec('hold-ball-1748000000-e2e', {
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: { message: '持球唤醒' },
      deliveryThreadId: 'th-hold-e2e',
    });

    await spec.run.execute('持球唤醒', 'thread-th-hold-e2e', { assignedCatId: null, deliver });

    const messages = messageStore.getByThread('th-hold-e2e');
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].provenance, { author: 'system', routed: false, observation: 'original' });
    assert.equal(messages[0].content, `${SCHEDULER_TRIGGER_PREFIX} 持球唤醒`);
  });
});
