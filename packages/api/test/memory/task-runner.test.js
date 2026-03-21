import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { TaskRunner } from '../../dist/infrastructure/scheduler/TaskRunner.js';

describe('TaskRunner', () => {
  let runner;

  afterEach(() => {
    if (runner) runner.stop();
  });

  it('registers and lists tasks', () => {
    runner = new TaskRunner();
    runner.register({ name: 'test-task', intervalMs: 1000, enabled: () => true, execute: async () => {} });
    assert.deepEqual(runner.getRegisteredTasks(), ['test-task']);
  });

  it('rejects duplicate task names', () => {
    runner = new TaskRunner();
    const task = { name: 'dup', intervalMs: 1000, enabled: () => true, execute: async () => {} };
    runner.register(task);
    assert.throws(() => runner.register(task), /duplicate task name/);
  });

  it('triggerNow executes task immediately', async () => {
    runner = new TaskRunner();
    let executed = false;
    runner.register({
      name: 'manual',
      intervalMs: 999999,
      enabled: () => true,
      execute: async () => {
        executed = true;
      },
    });
    await runner.triggerNow('manual');
    assert.ok(executed);
  });

  it('triggerNow throws for unknown task', async () => {
    runner = new TaskRunner();
    await assert.rejects(() => runner.triggerNow('nope'), /unknown task/);
  });

  it('start and stop manage timers', () => {
    runner = new TaskRunner({ info: () => {}, error: () => {} });
    runner.register({ name: 'timer-test', intervalMs: 100, enabled: () => true, execute: async () => {} });
    runner.start();
    // Should not throw on double start
    runner.start();
    runner.stop();
    // Should be idempotent
    runner.stop();
  });

  it('skips disabled tasks on tick', async () => {
    runner = new TaskRunner({ info: () => {}, error: () => {} });
    let ran = false;
    runner.register({
      name: 'disabled',
      intervalMs: 10,
      enabled: () => false,
      execute: async () => {
        ran = true;
      },
    });
    runner.start();
    await new Promise((r) => setTimeout(r, 50));
    runner.stop();
    assert.ok(!ran, 'disabled task should not run');
  });

  it('triggerNow propagates errors (for test visibility)', async () => {
    runner = new TaskRunner({ info: () => {}, error: () => {} });
    runner.register({
      name: 'failing',
      intervalMs: 999999,
      enabled: () => true,
      execute: async () => {
        throw new Error('boom');
      },
    });
    await assert.rejects(() => runner.triggerNow('failing'), /boom/);
  });
});
