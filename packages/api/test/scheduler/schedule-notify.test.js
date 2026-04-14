import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('schedule-notify: computeNextFireTime', () => {
  it('once → returns fireAt directly', async () => {
    const { computeNextFireTime } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    const fireAt = Date.now() + 120_000;
    assert.equal(computeNextFireTime({ type: 'once', fireAt }), fireAt);
  });

  it('interval → returns now + ms (within tolerance)', async () => {
    const { computeNextFireTime } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    const before = Date.now();
    const result = computeNextFireTime({ type: 'interval', ms: 60_000 });
    assert.ok(result >= before + 60_000);
    assert.ok(result <= before + 61_000); // 1s tolerance
  });

  it('cron → returns a future epoch ms', async () => {
    const { computeNextFireTime } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    const result = computeNextFireTime({ type: 'cron', expression: '0 9 * * *' });
    assert.ok(result > Date.now(), 'next cron fire should be in the future');
  });
});

describe('schedule-notify: notification functions', () => {
  const makeDef = (overrides = {}) => ({
    id: 'dyn-test-1',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: Date.now() + 60_000 },
    params: { message: 'test', triggerUserId: 'user-42' },
    display: { label: '测试提醒', category: 'system' },
    deliveryThreadId: 'thread-xyz',
    enabled: true,
    createdBy: 'opus',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  it('notifyTaskRegistered sends to deliveryThreadId with label and time', async () => {
    const { notifyTaskRegistered } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    const calls = [];
    const mockNotify = (opts) => calls.push(opts);
    notifyTaskRegistered(mockNotify, makeDef());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].threadId, 'thread-xyz');
    assert.equal(calls[0].userId, 'user-42');
    assert.equal(calls[0].toast.type, 'info');
    assert.equal(calls[0].toast.title, '定时任务已创建');
    assert.ok(calls[0].toast.message.includes('测试提醒'));
    assert.ok(calls[0].toast.message.includes('一次性'), 'should mention once for once-trigger');
    assert.equal(calls[0].toast.lifecycleEvent, 'registered');
  });

  it('notifyTaskPaused sends pause message', async () => {
    const { notifyTaskPaused } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    const calls = [];
    const mockNotify = (opts) => calls.push(opts);
    notifyTaskPaused(mockNotify, makeDef());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toast.title, '定时任务已暂停');
    assert.ok(calls[0].toast.message.includes('已暂停'));
  });

  it('notifyTaskResumed sends resume message with next time', async () => {
    const { notifyTaskResumed } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    const calls = [];
    const mockNotify = (opts) => calls.push(opts);
    notifyTaskResumed(mockNotify, makeDef());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toast.title, '定时任务已恢复');
    assert.ok(calls[0].toast.message.includes('下次执行时间'));
  });

  it('notifyTaskDeleted sends delete message', async () => {
    const { notifyTaskDeleted } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    const calls = [];
    const mockNotify = (opts) => calls.push(opts);
    notifyTaskDeleted(mockNotify, makeDef());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toast.title, '定时任务已删除');
    assert.ok(calls[0].toast.message.includes('已删除'));
  });

  it('notifyTaskFailed sends failure message with error', async () => {
    const { notifyTaskFailed } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    const calls = [];
    const mockNotify = (opts) => calls.push(opts);
    notifyTaskFailed(mockNotify, makeDef(), 'connection timeout');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toast.type, 'error');
    assert.equal(calls[0].toast.title, '定时任务执行失败');
    assert.ok(calls[0].toast.message.includes('connection timeout'));
  });

  it('no-op when notifier is undefined', async () => {
    const { notifyTaskRegistered } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    // Should not throw
    notifyTaskRegistered(undefined, makeDef());
  });

  it('no-op when deliveryThreadId is null', async () => {
    const { notifyTaskRegistered } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    let called = false;
    const mockNotify = () => {
      called = true;
    };
    notifyTaskRegistered(mockNotify, makeDef({ deliveryThreadId: null }));
    assert.ok(!called, 'should not notify when deliveryThreadId is null');
  });
});

describe('TaskRunnerV2 — execution failure notification (#415)', () => {
  it('RUN_FAILED triggers notifyTaskFailed via onItemOutcome', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const { DynamicTaskStore } = await import('../../dist/infrastructure/scheduler/DynamicTaskStore.js');
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    applyMigrations(db);
    const ledger = new RunLedger(db);
    const dynamicTaskStore = new DynamicTaskStore(db);
    const lifecycleCalls = [];
    const mockNotifyLifecycle = (opts) => lifecycleCalls.push(opts);
    const noop = () => {};
    const runner = new TaskRunnerV2({
      logger: { info: noop, error: noop },
      ledger,
      dynamicTaskStore,
      notifyLifecycle: mockNotifyLifecycle,
    });

    // Seed dynamic store
    dynamicTaskStore.insert({
      id: 'dyn-fail-1',
      templateId: 'reminder',
      trigger: { type: 'interval', ms: 999999 },
      params: { message: 'test', triggerUserId: 'user-42' },
      display: { label: '失败任务', category: 'system' },
      deliveryThreadId: 'thread-fail',
      enabled: true,
      createdBy: 'opus',
      createdAt: new Date().toISOString(),
    });

    runner.registerDynamic(
      {
        id: 'dyn-fail-1',
        profile: 'awareness',
        trigger: { type: 'interval', ms: 999999 },
        admission: {
          gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'k' }] }),
        },
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async () => {
            throw new Error('kaboom');
          },
        },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
      },
      'dyn-fail-1',
    );

    await runner.triggerNow('dyn-fail-1');
    // Allow fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(lifecycleCalls.length >= 1, 'should have sent failure notification');
    const failMsg = lifecycleCalls.find((c) => c.toast.title.includes('执行失败'));
    assert.ok(failMsg, 'should contain failure notification');
    assert.equal(failMsg.threadId, 'thread-fail');
    assert.ok(failMsg.toast.message.includes('kaboom'));
    runner.stop();
  });

  it('RUN_DELIVERED skips lifecycle toast for reminder tasks', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const { DynamicTaskStore } = await import('../../dist/infrastructure/scheduler/DynamicTaskStore.js');
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    applyMigrations(db);
    const ledger = new RunLedger(db);
    const dynamicTaskStore = new DynamicTaskStore(db);
    const lifecycleCalls = [];
    const mockNotifyLifecycle = (opts) => lifecycleCalls.push(opts);
    const noop = () => {};
    const runner = new TaskRunnerV2({
      logger: { info: noop, error: noop },
      ledger,
      dynamicTaskStore,
      notifyLifecycle: mockNotifyLifecycle,
    });

    dynamicTaskStore.insert({
      id: 'dyn-ok-1',
      templateId: 'reminder',
      trigger: { type: 'interval', ms: 999999 },
      params: { message: 'test', triggerUserId: 'user-42' },
      display: { label: '成功任务', category: 'system' },
      deliveryThreadId: 'thread-ok',
      enabled: true,
      createdBy: 'opus',
      createdAt: new Date().toISOString(),
    });

    runner.registerDynamic(
      {
        id: 'dyn-ok-1',
        profile: 'awareness',
        trigger: { type: 'interval', ms: 999999 },
        admission: {
          gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'k' }] }),
        },
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async () => ({ delivered: true }),
        },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
      },
      'dyn-ok-1',
    );

    await runner.triggerNow('dyn-ok-1');
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(lifecycleCalls.length, 0, 'reminder runs should not emit redundant success lifecycle toasts');
    runner.stop();
  });
});

describe('schedule-notify: notifyTaskSucceeded', () => {
  const makeDef2 = (overrides = {}) => ({
    id: 'dyn-test-1',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: Date.now() + 60_000 },
    params: { message: 'test', triggerUserId: 'user-42' },
    display: { label: '测试提醒', category: 'system' },
    deliveryThreadId: 'thread-xyz',
    enabled: true,
    createdBy: 'opus',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  it('recurring task includes next fire time', async () => {
    const { notifyTaskSucceeded } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    const calls = [];
    const mockNotify = (opts) => calls.push(opts);
    notifyTaskSucceeded(mockNotify, makeDef2({ templateId: 'web-digest', trigger: { type: 'interval', ms: 60000 } }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toast.title, '定时任务执行完成');
    assert.ok(calls[0].toast.message.includes('下次执行时间'));
  });

  it('once task says task has ended', async () => {
    const { notifyTaskSucceeded } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    const calls = [];
    const mockNotify = (opts) => calls.push(opts);
    notifyTaskSucceeded(
      mockNotify,
      makeDef2({ templateId: 'web-digest', trigger: { type: 'once', fireAt: Date.now() } }),
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0].toast.message.includes('已执行完成'));
    assert.ok(calls[0].toast.message.includes('自动结束'));
  });

  it('reminder task success is intentionally silent', async () => {
    const { notifyTaskSucceeded } = await import('../../dist/infrastructure/scheduler/schedule-notify.js');
    const calls = [];
    const mockNotify = (opts) => calls.push(opts);
    notifyTaskSucceeded(mockNotify, makeDef2({ templateId: 'reminder', trigger: { type: 'interval', ms: 60000 } }));
    assert.equal(calls.length, 0);
  });
});
