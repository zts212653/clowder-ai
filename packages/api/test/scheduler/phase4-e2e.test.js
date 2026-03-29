/**
 * F139 Phase 4 E2E (AC-H5): Template Execution + Builtin Control
 * Full chain: register → hydrate → trigger → deliver → panel control
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { createDeliverFn } from '../../dist/infrastructure/scheduler/delivery.js';
import { GlobalControlStore } from '../../dist/infrastructure/scheduler/GlobalControlStore.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../dist/infrastructure/scheduler/TaskRunnerV2.js';
import { templateRegistry } from '../../dist/infrastructure/scheduler/templates/registry.js';

describe('F139 Phase 4 E2E', () => {
  let db;
  let ledger;
  let runner;
  let store;
  let globalControlStore;
  let deliverCalls;
  let deliverMock;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    ledger = new RunLedger(db);
    globalControlStore = new GlobalControlStore(db);
    store = new DynamicTaskStore(db);
    deliverCalls = [];

    // Mock messageStore + socketManager for delivery
    const mockMessageStore = {
      append: mock.fn((msg) => ({ id: `msg-${Date.now()}`, threadId: msg.threadId })),
    };
    const mockSocketManager = {
      broadcastAgentMessage: mock.fn(),
    };
    deliverMock = createDeliverFn({
      messageStore: mockMessageStore,
      socketManager: mockSocketManager,
    });

    // Wrap to capture calls
    const wrappedDeliver = async (opts) => {
      deliverCalls.push(opts);
      return deliverMock(opts);
    };

    runner = new TaskRunnerV2({
      logger: { info: () => {}, error: () => {} },
      ledger,
      globalControlStore,
      deliver: wrappedDeliver,
    });
  });

  test('AC-H1+H5: reminder register → hydrate → trigger → deliver', async () => {
    // 1. Register a reminder task ("每天九点提醒我喝水")
    store.insert({
      id: 'remind-water',
      templateId: 'reminder',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: '记得喝水！' },
      display: { label: '喝水提醒', category: 'system', description: '每天九点提醒喝水' },
      deliveryThreadId: 'thread-user-123',
      enabled: true,
      createdBy: 'opus',
      createdAt: new Date().toISOString(),
    });

    // 2. Hydrate into runner
    const loaded = runner.hydrateDynamic(store, templateRegistry);
    assert.equal(loaded, 1);

    // 3. Verify task visible in summaries
    const summaries = runner.getTaskSummaries();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, 'remind-water');
    assert.equal(summaries[0].source, 'dynamic');
    assert.equal(summaries[0].effectiveEnabled, true);

    // 4. Manual trigger → execute
    await runner.triggerNow('remind-water', { manual: true });

    // 5. Verify message was delivered
    assert.equal(deliverCalls.length, 1);
    assert.equal(deliverCalls[0].threadId, 'thread-user-123');
    assert.equal(deliverCalls[0].content, '[定时任务] 记得喝水！');

    // 6. Verify ledger recorded RUN_DELIVERED
    const runs = ledger.query('remind-water', 5);
    assert.ok(runs.length >= 1);
    assert.equal(runs[0].outcome, 'RUN_DELIVERED');
    assert.equal(runs[0].subject_key, 'thread-thread-user-123');
  });

  test('Phase 4b: reminder with invokeTrigger stores trigger message then wakes cat', async () => {
    const triggerCalls = [];
    const mockInvokeTrigger = {
      trigger: (...args) => triggerCalls.push(args),
    };

    // Use wrapped deliver so deliverCalls captures the trigger-message store
    const runnerWithTrigger = new TaskRunnerV2({
      logger: { info: () => {}, error: () => {} },
      ledger,
      globalControlStore,
      deliver: async (opts) => {
        deliverCalls.push(opts);
        return deliverMock(opts);
      },
      invokeTrigger: mockInvokeTrigger,
    });

    store.insert({
      id: 'remind-cat-wake',
      templateId: 'reminder',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: '搜三天内 Anthropic 新闻' },
      display: { label: '新闻速递', category: 'external' },
      deliveryThreadId: 'thread-news-123',
      enabled: true,
      createdBy: 'opus',
      createdAt: new Date().toISOString(),
    });
    runnerWithTrigger.hydrateDynamic(store, templateRegistry);

    await runnerWithTrigger.triggerNow('remind-cat-wake', { manual: true });

    // 1. deliver was called FIRST to store the trigger message (real messageId for retry)
    assert.equal(deliverCalls.length, 1);
    assert.equal(deliverCalls[0].threadId, 'thread-news-123');
    assert.ok(deliverCalls[0].content.includes('搜三天内 Anthropic 新闻'));
    assert.equal(deliverCalls[0].catId, 'system');
    assert.equal(deliverCalls[0].userId, 'scheduler');

    // 2. invokeTrigger was called with the REAL messageId from deliver
    assert.equal(triggerCalls.length, 1);
    assert.equal(triggerCalls[0][0], 'thread-news-123'); // threadId
    assert.equal(triggerCalls[0][1], 'opus'); // catId (default, no actor resolver)
    assert.equal(triggerCalls[0][2], 'default-user'); // userId (from triggerUserId param, not hardcoded 'scheduler')
    assert.ok(triggerCalls[0][3].includes('搜三天内 Anthropic 新闻')); // message contains reminder
    assert.ok(triggerCalls[0][4].startsWith('msg-'), 'messageId should be real stored ID');

    // Ledger still records RUN_DELIVERED
    const runs = ledger.query('remind-cat-wake', 1);
    assert.equal(runs[0].outcome, 'RUN_DELIVERED');
  });

  test('AC-H4: builtin task pause via override → trigger skipped', async () => {
    // Register a reminder
    store.insert({
      id: 'remind-pause-test',
      templateId: 'reminder',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'test' },
      display: { label: 'Test', category: 'system' },
      deliveryThreadId: 'thread-t1',
      enabled: true,
      createdBy: 'opus',
      createdAt: new Date().toISOString(),
    });
    runner.hydrateDynamic(store, templateRegistry);

    // Pause via task override (same as panel UI would do)
    globalControlStore.setTaskOverride('remind-pause-test', false, 'user');

    // Verify effectiveEnabled is false
    const summaries = runner.getTaskSummaries();
    assert.equal(summaries[0].effectiveEnabled, false);

    // Trigger — should be skipped due to override
    await runner.triggerNow('remind-pause-test', { manual: true });

    // Manual trigger bypasses overrides — so it still delivers
    // (This is correct per Phase 3B: manual triggers bypass governance)
    assert.equal(deliverCalls.length, 1);

    // But a non-manual trigger should skip
    deliverCalls.length = 0;
    await runner.triggerNow('remind-pause-test');

    // Non-manual trigger respects override → skip
    assert.equal(deliverCalls.length, 0);

    // Verify ledger has SKIP_TASK_OVERRIDE
    const runs = ledger.query('remind-pause-test', 10);
    const skipRun = runs.find((r) => r.outcome === 'SKIP_TASK_OVERRIDE');
    assert.ok(skipRun, 'should have SKIP_TASK_OVERRIDE ledger entry');
  });

  test('AC-H4: resume after pause → delivery works again', async () => {
    store.insert({
      id: 'remind-resume-test',
      templateId: 'reminder',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'resume test' },
      display: { label: 'Resume', category: 'system' },
      deliveryThreadId: 'thread-t2',
      enabled: true,
      createdBy: 'opus',
      createdAt: new Date().toISOString(),
    });
    runner.hydrateDynamic(store, templateRegistry);

    // Pause
    globalControlStore.setTaskOverride('remind-resume-test', false, 'user');
    await runner.triggerNow('remind-resume-test');
    assert.equal(deliverCalls.length, 0);

    // Resume
    globalControlStore.setTaskOverride('remind-resume-test', true, 'user');
    await runner.triggerNow('remind-resume-test');
    assert.equal(deliverCalls.length, 1);
    assert.equal(deliverCalls[0].content, '[定时任务] resume test');
  });

  test('AC-H2: web-digest trigger delivers formatted digest', async () => {
    // Create runner with fetchContent mock
    const fetchMock = mock.fn(async () => ({
      text: 'Anthropic released Claude 5.0 today with major improvements',
      title: 'Anthropic Blog',
      url: 'https://blog.anthropic.com',
      method: 'server-fetch',
      truncated: false,
    }));

    const runnerWithFetch = new TaskRunnerV2({
      logger: { info: () => {}, error: () => {} },
      ledger,
      globalControlStore,
      deliver: async (opts) => {
        deliverCalls.push(opts);
        return deliverMock(opts);
      },
      fetchContent: fetchMock,
    });

    store.insert({
      id: 'digest-anthropic',
      templateId: 'web-digest',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { url: 'https://blog.anthropic.com', topic: 'AI' },
      display: { label: 'AI 摘要', category: 'external', description: 'Anthropic blog digest' },
      deliveryThreadId: 'thread-news',
      enabled: true,
      createdBy: 'opus',
      createdAt: new Date().toISOString(),
    });
    runnerWithFetch.hydrateDynamic(store, templateRegistry);

    await runnerWithFetch.triggerNow('digest-anthropic', { manual: true });

    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(deliverCalls.length, 1);
    assert.ok(deliverCalls[0].content.includes('Anthropic Blog'));
    assert.ok(deliverCalls[0].content.includes('Claude 5.0'));
    assert.equal(deliverCalls[0].threadId, 'thread-news');
  });

  test('AC-H2b: web-digest browser path stores trigger message then wakes target cat', async () => {
    const fetchMock = mock.fn(async () => ({
      text: '',
      title: '',
      url: 'https://x.com/anthropic',
      method: 'browser',
      truncated: false,
    }));
    const triggerCalls = [];

    const runnerWithFetchAndTrigger = new TaskRunnerV2({
      logger: { info: () => {}, error: () => {} },
      ledger,
      globalControlStore,
      deliver: async (opts) => {
        deliverCalls.push(opts);
        return deliverMock(opts);
      },
      fetchContent: fetchMock,
      invokeTrigger: {
        trigger: (...args) => triggerCalls.push(args),
      },
    });

    store.insert({
      id: 'digest-browser',
      templateId: 'web-digest',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { url: 'https://x.com/anthropic', topic: '今天 AI 新闻', targetCatId: 'gpt52' },
      display: { label: 'AI 新闻巡查', category: 'external', description: 'JS-heavy digest' },
      deliveryThreadId: 'thread-browser',
      enabled: true,
      createdBy: 'gpt52',
      createdAt: new Date().toISOString(),
    });
    runnerWithFetchAndTrigger.hydrateDynamic(store, templateRegistry);

    await runnerWithFetchAndTrigger.triggerNow('digest-browser', { manual: true });

    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(deliverCalls.length, 1);
    assert.equal(deliverCalls[0].threadId, 'thread-browser');
    assert.equal(deliverCalls[0].catId, 'system');
    assert.ok(deliverCalls[0].content.includes('browser-automation'));
    assert.ok(deliverCalls[0].content.includes('https://x.com/anthropic'));
    assert.ok(deliverCalls[0].content.includes('今天 AI 新闻'));

    assert.equal(triggerCalls.length, 1);
    assert.equal(triggerCalls[0][0], 'thread-browser');
    assert.equal(triggerCalls[0][1], 'gpt52');
    assert.equal(triggerCalls[0][2], 'default-user'); // userId (from triggerUserId param)
    assert.ok(triggerCalls[0][3].includes('browser-automation'));
    assert.ok(triggerCalls[0][4].startsWith('msg-'));
    assert.equal(triggerCalls[0][6]?.suggestedSkill, 'browser-automation');

    const runs = ledger.query('digest-browser', 1);
    assert.equal(runs[0].outcome, 'RUN_DELIVERED');
  });

  test('AC-H3: repo-activity trigger delivers repo update from GitHub API', async () => {
    // Mock GitHub API response
    const ghIssues = [
      {
        number: 10,
        title: 'Add streaming',
        html_url: 'https://github.com/anthropics/claude-code/issues/10',
        user: { login: 'alice' },
      },
      {
        number: 11,
        title: 'Fix timeout',
        html_url: 'https://github.com/anthropics/claude-code/pull/11',
        pull_request: { url: '...' },
        user: { login: 'bob' },
      },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({ ok: true, json: async () => ghIssues }));
    try {
      store.insert({
        id: 'repo-watch',
        templateId: 'repo-activity',
        trigger: { type: 'interval', ms: 3600_000 },
        params: { repo: 'anthropics/claude-code' },
        display: { label: 'claude-code 动态', category: 'repo', description: 'Watch repo' },
        deliveryThreadId: 'thread-dev',
        enabled: true,
        createdBy: 'opus',
        createdAt: new Date().toISOString(),
      });
      runner.hydrateDynamic(store, templateRegistry);

      await runner.triggerNow('repo-watch', { manual: true });

      // Must have called GitHub API
      assert.equal(globalThis.fetch.mock.calls.length, 1);
      const fetchUrl = globalThis.fetch.mock.calls[0].arguments[0];
      assert.ok(fetchUrl.includes('api.github.com/repos/anthropics/claude-code'));

      // Delivered content includes real issue/PR data
      assert.equal(deliverCalls.length, 1);
      assert.ok(deliverCalls[0].content.includes('#10'));
      assert.ok(deliverCalls[0].content.includes('Add streaming'));
      assert.ok(deliverCalls[0].content.includes('#11'));
      assert.equal(deliverCalls[0].threadId, 'thread-dev');

      // Verify ledger
      const runs = ledger.query('repo-watch', 1);
      assert.equal(runs[0].outcome, 'RUN_DELIVERED');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('AC-D1: global pause stops all non-manual triggers', async () => {
    store.insert({
      id: 'remind-global-pause',
      templateId: 'reminder',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'global test' },
      display: { label: 'Global', category: 'system' },
      deliveryThreadId: 'thread-gp',
      enabled: true,
      createdBy: 'opus',
      createdAt: new Date().toISOString(),
    });
    runner.hydrateDynamic(store, templateRegistry);

    // Pause globally
    globalControlStore.setGlobalEnabled(false, 'test', 'user');

    // Non-manual trigger → skipped
    await runner.triggerNow('remind-global-pause');
    assert.equal(deliverCalls.length, 0);

    // Manual trigger → still works
    await runner.triggerNow('remind-global-pause', { manual: true });
    assert.equal(deliverCalls.length, 1);
  });
});
