/**
 * F139 Phase 3A: Dynamic Task Hydration (AC-G3 + AC-G4)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../dist/infrastructure/scheduler/TaskRunnerV2.js';
import { templateRegistry } from '../../dist/infrastructure/scheduler/templates/registry.js';

describe('Dynamic Task Hydration', () => {
  let db;
  let ledger;
  let runner;
  let store;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    ledger = new RunLedger(db);
    runner = new TaskRunnerV2({
      logger: { info: () => {}, error: () => {} },
      ledger,
    });
    store = new DynamicTaskStore(db);
  });

  test('hydrateDynamic loads enabled tasks from store', () => {
    store.insert({
      id: 'dyn-001',
      templateId: 'reminder',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: '检查 backlog' },
      display: { label: '每日提醒', category: 'system', description: '检查 backlog' },
      deliveryThreadId: 'thread-abc',
      enabled: true,
      createdBy: 'opus',
      createdAt: '2026-03-27T03:00:00Z',
    });
    const loaded = runner.hydrateDynamic(store, templateRegistry);
    assert.equal(loaded, 1);
    const summaries = runner.getTaskSummaries();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].source, 'dynamic');
    assert.equal(summaries[0].dynamicTaskId, 'dyn-001');
  });

  test('hydrateDynamic skips disabled tasks', () => {
    store.insert({
      id: 'dyn-disabled',
      templateId: 'reminder',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'skip me' },
      display: { label: 'Disabled', category: 'system' },
      deliveryThreadId: null,
      enabled: false,
      createdBy: 'opus',
      createdAt: '2026-03-27T03:00:00Z',
    });
    const loaded = runner.hydrateDynamic(store, templateRegistry);
    assert.equal(loaded, 0);
  });

  test('hydrateDynamic skips unknown template', () => {
    store.insert({
      id: 'dyn-bad-template',
      templateId: 'nonexistent-template',
      trigger: { type: 'interval', ms: 60000 },
      params: {},
      display: { label: 'Bad', category: 'system' },
      deliveryThreadId: null,
      enabled: true,
      createdBy: 'opus',
      createdAt: '2026-03-27T03:00:00Z',
    });
    const loaded = runner.hydrateDynamic(store, templateRegistry);
    assert.equal(loaded, 0);
  });

  test('builtin tasks have source=builtin', () => {
    runner.register({
      id: 'builtin-task',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 999999 },
      admission: { gate: async () => ({ run: false, reason: 'test' }) },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });
    const [summary] = runner.getTaskSummaries();
    assert.equal(summary.source, 'builtin');
    assert.equal(summary.dynamicTaskId, undefined);
  });

  test('unregister removes dynamic task', () => {
    store.insert({
      id: 'dyn-to-remove',
      templateId: 'reminder',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'bye' },
      display: { label: 'Remove me', category: 'system' },
      deliveryThreadId: null,
      enabled: true,
      createdBy: 'opus',
      createdAt: '2026-03-27T03:00:00Z',
    });
    runner.hydrateDynamic(store, templateRegistry);
    assert.equal(runner.getTaskSummaries().length, 1);
    const removed = runner.unregister('dyn-to-remove');
    assert.equal(removed, true);
    assert.equal(runner.getTaskSummaries().length, 0);
  });

  test('unregister returns false for unknown task', () => {
    assert.equal(runner.unregister('nonexistent'), false);
  });

  test('registerDynamic after start() schedules timer and executes task', async () => {
    // Start runner with no tasks
    runner.start();

    // Track execution
    let executed = false;

    // Register a dynamic task AFTER start()
    const spec = {
      id: 'dyn-post-start',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 50 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ subjectKey: 'test-subject', signal: 'hi' }],
        }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async () => {
          executed = true;
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    };
    runner.registerDynamic(spec, 'dyn-post-start');

    // Wait for at least one tick
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(executed, true, 'Task registered after start() must execute');

    // Cleanup
    runner.stop();
  });

  test('stop() resets started flag — registerDynamic after stop does not schedule', async () => {
    runner.start();
    runner.stop();

    let executed = false;
    const spec = {
      id: 'dyn-after-stop',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 50 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ subjectKey: 'test', signal: 'hi' }],
        }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async () => {
          executed = true;
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    };
    runner.registerDynamic(spec, 'dyn-after-stop');

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(executed, false, 'Task registered after stop() must NOT execute');
  });

  test('unregister immediately after registerDynamic prevents ghost execution', async () => {
    runner.start();

    let executed = false;
    const spec = {
      id: 'dyn-ghost',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 50 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ subjectKey: 'test', signal: 'hi' }],
        }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async () => {
          executed = true;
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    };
    runner.registerDynamic(spec, 'dyn-ghost');
    // Immediately unregister — the 0ms initial tick is in the queue
    runner.unregister('dyn-ghost');

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(executed, false, 'Unregistered task must not ghost-execute');

    runner.stop();
  });
});
