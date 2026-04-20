/**
 * Schedule Route Tests (F139 Phase 2)
 * Uses lightweight Fastify injection (no real HTTP server).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

describe('Schedule Routes', () => {
  let app, db, ledger, runner, taskStore;
  const noop = () => {};
  const silentLogger = { info: noop, error: noop };

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../dist/domains/memory/schema.js');
    const { RunLedger } = await import('../dist/infrastructure/scheduler/RunLedger.js');
    const { TaskRunnerV2 } = await import('../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const { scheduleRoutes } = await import('../dist/routes/schedule.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');

    applyMigrations(db);
    ledger = new RunLedger(db);
    runner = new TaskRunnerV2({ logger: silentLogger, ledger });
    taskStore = new TaskStore();

    // Register test tasks
    runner.register({
      id: 'summary-compact',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 1800000 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'ok', subjectKey: 'thread:abc123' }],
        }),
      },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });

    runner.register({
      id: 'cicd-check',
      profile: 'poller',
      trigger: { type: 'interval', ms: 60000 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'pr', subjectKey: 'repo:owner/name' }],
        }),
      },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'record' },
      enabled: () => true,
      display: { label: 'CI/CD 检查', category: 'pr', subjectKind: 'pr' },
    });

    // Populate ledger with some runs
    await runner.triggerNow('summary-compact');
    await runner.triggerNow('cicd-check');

    app = Fastify({ logger: false });
    await app.register(scheduleRoutes, { taskRunner: runner, taskStore });
    await app.ready();
  });

  afterEach(async () => {
    runner.stop();
    await app.close();
  });

  describe('GET /api/schedule/tasks', () => {
    it('returns all registered tasks with summaries', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/schedule/tasks' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body.tasks));
      assert.equal(body.tasks.length, 2);

      const ids = body.tasks.map((t) => t.id).sort();
      assert.deepEqual(ids, ['cicd-check', 'summary-compact']);

      const summary = body.tasks.find((t) => t.id === 'summary-compact');
      assert.equal(summary.profile, 'awareness');
      assert.deepEqual(summary.trigger, { type: 'interval', ms: 1800000 });
      assert.equal(summary.enabled, true);
      assert.ok(summary.lastRun);
      assert.equal(summary.lastRun.outcome, 'RUN_DELIVERED');
      assert.equal(summary.runStats.total, 1);
      assert.equal(summary.runStats.delivered, 1);
    });

    it('includes zero-run PR summaries for a thread that has tracked PRs', async () => {
      runner.register({
        id: 'review-feedback',
        profile: 'poller',
        trigger: { type: 'interval', ms: 60000 },
        admission: { gate: async () => ({ run: false, reason: 'idle' }) },
        run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'record' },
        enabled: () => true,
        display: { label: 'Review 反馈', category: 'pr', subjectKind: 'pr' },
      });
      taskStore.upsertBySubject({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#42',
        threadId: 'abc123',
        title: 'PR tracking: owner/repo#42',
        why: 'track pr',
        createdBy: 'opus',
      });

      const res = await app.inject({ method: 'GET', url: '/api/schedule/tasks?threadId=abc123' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.tasks.some((task) => task.id === 'review-feedback'));
    });

    it('ignores done PR tracking tasks when deriving zero-run subjectKind fallback', async () => {
      runner.register({
        id: 'review-feedback',
        profile: 'poller',
        trigger: { type: 'interval', ms: 60000 },
        admission: { gate: async () => ({ run: false, reason: 'idle' }) },
        run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'record' },
        enabled: () => true,
        display: { label: 'Review 反馈', category: 'pr', subjectKind: 'pr' },
      });
      const tracking = taskStore.upsertBySubject({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#42',
        threadId: 'abc123',
        title: 'PR tracking: owner/repo#42',
        why: 'track pr',
        createdBy: 'opus',
      });
      taskStore.update(tracking.id, { status: 'done' });

      const res = await app.inject({ method: 'GET', url: '/api/schedule/tasks?threadId=abc123' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(!body.tasks.some((task) => task.id === 'review-feedback'));
    });

    it('includes PR scheduler tasks for threads with active PR tracking even if task has prior runs (#320 P1)', async () => {
      taskStore.upsertBySubject({
        kind: 'pr_tracking',
        subjectKey: 'pr:another/repo#7',
        threadId: 'abc123',
        title: 'PR tracking: another/repo#7',
        why: 'track pr',
        createdBy: 'opus',
      });

      const res = await app.inject({ method: 'GET', url: '/api/schedule/tasks?threadId=abc123' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      // cicd-check has subjectKind='pr' and thread has active pr_tracking → must appear
      const cicd = body.tasks.find((task) => task.id === 'cicd-check');
      assert.ok(cicd, 'cicd-check should appear for thread with active PR tracking');
      // Kind-match included tasks must have foreign run metadata scrubbed
      assert.equal(cicd.lastRun, null, 'lastRun from other PR must be scrubbed');
      assert.equal(cicd.subjectPreview, null, 'subjectPreview from other PR must be scrubbed');
      assert.deepEqual(
        cicd.runStats,
        { total: 0, delivered: 0, failed: 0, skipped: 0 },
        'runStats from other PRs must be zeroed',
      );
    });

    it('excludes PR scheduler tasks for threads without any PR tracking', async () => {
      // thread xyz999 has no tasks at all
      const res = await app.inject({ method: 'GET', url: '/api/schedule/tasks?threadId=xyz999' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(!body.tasks.some((task) => task.id === 'cicd-check'));
    });

    it('matches legacy pr- run subjects for thread filtering', async () => {
      taskStore.upsertBySubject({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#42',
        threadId: 'abc123',
        title: 'PR tracking: owner/repo#42',
        why: 'track pr',
        createdBy: 'opus',
      });
      ledger.record({
        task_id: 'cicd-check',
        subject_key: 'pr-owner/repo#42',
        outcome: 'RUN_DELIVERED',
        signal_summary: null,
        duration_ms: 10,
        started_at: new Date().toISOString(),
        assigned_cat_id: null,
      });

      const res = await app.inject({ method: 'GET', url: '/api/schedule/tasks?threadId=abc123' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.tasks.some((task) => task.id === 'cicd-check'));
    });
  });

  describe('GET /api/schedule/tasks/:id/runs', () => {
    it('returns run history for a valid task', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/schedule/tasks/summary-compact/runs',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body.runs));
      assert.equal(body.runs.length, 1);
      assert.equal(body.runs[0].outcome, 'RUN_DELIVERED');
    });

    it('returns 404 for unknown task', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/schedule/tasks/nonexistent/runs',
      });
      assert.equal(res.statusCode, 404);
    });

    it('includes threadId derived from subjectKey (AC-C3b-1)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/schedule/tasks/summary-compact/runs',
      });
      const body = JSON.parse(res.payload);
      assert.equal(body.runs[0].threadId, 'abc123');
    });

    it('threadId is null for non-thread subjects', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/schedule/tasks/cicd-check/runs',
      });
      const body = JSON.parse(res.payload);
      assert.equal(body.runs[0].threadId, null);
    });

    it('filters by threadId query param (AC-C3b-2)', async () => {
      // Add another run with different thread
      ledger.record({
        task_id: 'summary-compact',
        subject_key: 'thread:xyz789',
        outcome: 'RUN_DELIVERED',
        signal_summary: null,
        duration_ms: 10,
        started_at: new Date().toISOString(),
        assigned_cat_id: null,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/schedule/tasks/summary-compact/runs?threadId=abc123',
      });
      const body = JSON.parse(res.payload);
      assert.equal(body.runs.length, 1);
      assert.equal(body.runs[0].threadId, 'abc123');
    });

    it('finds target thread runs even when other subjects push it beyond LIMIT (P2-1)', async () => {
      // Record one run for our target thread
      ledger.record({
        task_id: 'summary-compact',
        subject_key: 'thread-target',
        outcome: 'RUN_DELIVERED',
        signal_summary: null,
        duration_ms: 10,
        started_at: new Date().toISOString(),
        assigned_cat_id: null,
      });
      // Flood with 55 runs for other subjects to push target beyond default LIMIT=50
      const now = new Date().toISOString();
      for (let i = 0; i < 55; i++) {
        ledger.record({
          task_id: 'summary-compact',
          subject_key: `thread-other${i}`,
          outcome: 'RUN_DELIVERED',
          signal_summary: null,
          duration_ms: 10,
          started_at: now,
          assigned_cat_id: null,
        });
      }
      const res = await app.inject({
        method: 'GET',
        url: '/api/schedule/tasks/summary-compact/runs?threadId=target',
      });
      const body = JSON.parse(res.payload);
      assert.ok(body.runs.length >= 1, 'should find thread-target run despite being beyond default LIMIT');
      assert.equal(body.runs[0].subject_key, 'thread-target');
    });

    it('matches legacy pr- run subjects when filtering by threadId', async () => {
      taskStore.upsertBySubject({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#42',
        threadId: 'abc123',
        title: 'PR tracking: owner/repo#42',
        why: 'track pr',
        createdBy: 'opus',
      });
      ledger.record({
        task_id: 'cicd-check',
        subject_key: 'pr-owner/repo#42',
        outcome: 'RUN_DELIVERED',
        signal_summary: null,
        duration_ms: 10,
        started_at: new Date().toISOString(),
        assigned_cat_id: null,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/schedule/tasks/cicd-check/runs?threadId=abc123',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.runs.some((run) => run.subject_key === 'pr-owner/repo#42'));
    });
  });

  describe('POST /api/schedule/tasks/:id/trigger', () => {
    it('triggers task and returns success', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/schedule/tasks/summary-compact/trigger',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.success, true);
      assert.equal(body.taskId, 'summary-compact');

      // Verify ledger has new entry
      const runs = ledger.query('summary-compact', 10);
      assert.equal(runs.length, 2); // 1 from beforeEach + 1 from trigger
    });

    it('returns 404 for unknown task', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/schedule/tasks/nonexistent/trigger',
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('extractThreadId()', () => {
    it('extracts thread ID from colon format (thread:xxx)', async () => {
      const { extractThreadId } = await import('../dist/routes/schedule.js');
      assert.equal(extractThreadId('thread:abc123'), 'abc123');
      assert.equal(extractThreadId('thread:'), '');
      assert.equal(extractThreadId('repo:owner/name'), null);
      assert.equal(extractThreadId('pr:42'), null);
    });

    it('extracts thread ID from hyphen format used by real tasks (P1-1)', async () => {
      const { extractThreadId } = await import('../dist/routes/schedule.js');
      // SummaryCompactionTaskSpec uses thread-${threadId} format
      assert.equal(extractThreadId('thread-abc123'), 'abc123');
      assert.equal(extractThreadId('thread-'), '');
      // pr- subjects should NOT extract a thread
      assert.equal(extractThreadId('pr-owner/repo#42'), null);
    });
  });

  // NL config route + parseNlToTrigger removed in Phase 3A (KD-10: conversational, not NL input box)

  describe('POST /api/schedule/tasks/preview (P1-1: draft step)', () => {
    let appDyn;
    let registry;

    beforeEach(async () => {
      const { DynamicTaskStore } = await import('../dist/infrastructure/scheduler/DynamicTaskStore.js');
      const { templateRegistry } = await import('../dist/infrastructure/scheduler/templates/registry.js');
      const { scheduleRoutes: sr } = await import('../dist/routes/schedule.js');
      const { InvocationRegistry } = await import(
        '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
      );
      const store = new DynamicTaskStore(db);
      registry = new InvocationRegistry();
      appDyn = Fastify({ logger: false });
      await appDyn.register(sr, { taskRunner: runner, dynamicTaskStore: store, templateRegistry, registry });
      await appDyn.ready();
    });

    afterEach(async () => {
      await appDyn.close();
    });

    it('returns draft without persisting', async () => {
      const res = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks/preview',
        payload: {
          templateId: 'reminder',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          params: { message: 'hello' },
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.draft, 'should return draft object');
      assert.equal(body.draft.templateId, 'reminder');
      assert.ok(!body.draft.id, 'draft should NOT have an id (not persisted)');

      // Verify nothing was persisted
      const tasksRes = await appDyn.inject({ method: 'GET', url: '/api/schedule/tasks' });
      const tasks = JSON.parse(tasksRes.payload).tasks;
      const dynTasks = tasks.filter((t) => t.source === 'dynamic');
      assert.equal(dynTasks.length, 0, 'no dynamic tasks should have been created');
    });

    it('rejects unknown template', async () => {
      const res = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks/preview',
        payload: { templateId: 'nonexistent' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('infers deliveryThreadId from callback auth in request body', async () => {
      const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-from-callback');
      const res = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks/preview',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          templateId: 'reminder',
          trigger: { type: 'once', delayMs: 1000 },
          params: { message: 'hello' },
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.draft.deliveryThreadId, 'thread-from-callback');
    });

    it('returns 409 stale invocation error for stale callback auth invocation', async () => {
      const stale = registry.create('user-1', 'opus', 'thread-from-callback');
      registry.create('user-1', 'opus', 'thread-from-callback');

      const res = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks/preview',
        headers: { 'x-invocation-id': stale.invocationId, 'x-callback-token': stale.callbackToken },
        payload: {
          templateId: 'reminder',
          trigger: { type: 'once', delayMs: 1000 },
          params: { message: 'stale-preview' },
          deliveryThreadId: 'thread-explicit-preview',
        },
      });

      assert.equal(res.statusCode, 409);
      const body = res.json();
      assert.equal(body.code, 'STALE_INVOCATION');
    });

    it('returns 401 for invalid callback credentials in preview (fail-closed, #474)', async () => {
      const { invocationId } = registry.create('user-1', 'opus', 'thread-preview-invalid');
      const res = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks/preview',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': 'invalid-token' },
        payload: {
          templateId: 'reminder',
          trigger: { type: 'once', delayMs: 1000 },
          params: { message: 'invalid-preview' },
          deliveryThreadId: 'thread-explicit-preview',
        },
      });

      assert.equal(res.statusCode, 401);
      const body = res.json();
      assert.ok(body.error.includes('expired'), 'preHandler rejects invalid creds before route handler');
    });
  });

  describe('POST /api/schedule/tasks — targetCatId flows through to reminder execute', () => {
    let appDyn;
    let store;

    beforeEach(async () => {
      const { DynamicTaskStore } = await import('../dist/infrastructure/scheduler/DynamicTaskStore.js');
      const { templateRegistry } = await import('../dist/infrastructure/scheduler/templates/registry.js');
      const { scheduleRoutes: sr } = await import('../dist/routes/schedule.js');
      store = new DynamicTaskStore(db);
      appDyn = Fastify({ logger: false });
      await appDyn.register(sr, { taskRunner: runner, dynamicTaskStore: store, templateRegistry });
      await appDyn.ready();
    });

    afterEach(async () => {
      runner.stop();
      await appDyn.close();
    });

    it('reminder registered with targetCatId=gpt52 wakes gpt52 not opus', async () => {
      // Register with explicit targetCatId
      const triggerCalls = [];
      const mockDeliver = async () => 'msg-e2e';
      const mockInvokeTrigger = { trigger: (...args) => triggerCalls.push(args) };

      // Re-create runner with deliver + invokeTrigger so execute can run
      const { TaskRunnerV2 } = await import('../dist/infrastructure/scheduler/TaskRunnerV2.js');
      const runnerWithDeps = new TaskRunnerV2({
        logger: silentLogger,
        ledger,
        deliver: mockDeliver,
        invokeTrigger: mockInvokeTrigger,
      });

      const { templateRegistry } = await import('../dist/infrastructure/scheduler/templates/registry.js');
      const template = templateRegistry.get('reminder');
      const spec = template.createSpec('e2e-cat-routing', {
        trigger: { type: 'interval', ms: 999999 },
        params: { message: '巡查新闻', targetCatId: 'gpt52' },
        deliveryThreadId: 'th-e2e',
      });
      runnerWithDeps.register(spec);

      await runnerWithDeps.triggerNow('e2e-cat-routing');

      // Verify invokeTrigger was called with gpt52
      assert.equal(triggerCalls.length, 1, 'invokeTrigger should be called once');
      assert.equal(triggerCalls[0][1], 'gpt52', 'should wake gpt52, not opus');
      runnerWithDeps.stop();
    });

    it('reminder without targetCatId falls back to opus (backwards compat)', async () => {
      const triggerCalls = [];
      const mockDeliver = async () => 'msg-e2e-2';
      const mockInvokeTrigger = { trigger: (...args) => triggerCalls.push(args) };

      const { TaskRunnerV2 } = await import('../dist/infrastructure/scheduler/TaskRunnerV2.js');
      const runnerNoCat = new TaskRunnerV2({
        logger: silentLogger,
        ledger,
        deliver: mockDeliver,
        invokeTrigger: mockInvokeTrigger,
      });

      const { templateRegistry } = await import('../dist/infrastructure/scheduler/templates/registry.js');
      const template = templateRegistry.get('reminder');
      const spec = template.createSpec('e2e-fallback', {
        trigger: { type: 'interval', ms: 999999 },
        params: { message: '默认猫' },
        deliveryThreadId: 'th-e2e-2',
      });
      runnerNoCat.register(spec);

      await runnerNoCat.triggerNow('e2e-fallback');

      assert.equal(triggerCalls.length, 1);
      assert.equal(triggerCalls[0][1], 'opus', 'should fall back to opus when no targetCatId');
      runnerNoCat.stop();
    });
  });

  describe('POST /api/schedule/tasks — triggerUserId security boundary', () => {
    let appDyn, store;

    beforeEach(async () => {
      const { DynamicTaskStore } = await import('../dist/infrastructure/scheduler/DynamicTaskStore.js');
      const { templateRegistry } = await import('../dist/infrastructure/scheduler/templates/registry.js');
      const { scheduleRoutes: sr } = await import('../dist/routes/schedule.js');
      store = new DynamicTaskStore(db);
      appDyn = Fastify({ logger: false });
      await appDyn.register(sr, { taskRunner: runner, dynamicTaskStore: store, templateRegistry });
      await appDyn.ready();
    });

    afterEach(async () => {
      runner.stop();
      await appDyn.close();
    });

    it('P1: route unconditionally overwrites forged triggerUserId with server identity', async () => {
      const createRes = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks',
        headers: { 'x-cat-cafe-user': 'real-user-123' },
        payload: {
          templateId: 'reminder',
          trigger: { type: 'interval', ms: 60000 },
          params: { message: 'forge-test', triggerUserId: 'evil-forged-user' },
        },
      });
      assert.equal(createRes.statusCode, 200);

      const stored = store.getAll().find((d) => d.params?.message === 'forge-test');
      assert.ok(stored, 'task should be persisted');
      assert.equal(stored.params.triggerUserId, 'real-user-123', 'route must overwrite forged triggerUserId');
    });

    it('P1: request without identity header defaults triggerUserId to default-user', async () => {
      const createRes = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks',
        payload: {
          templateId: 'reminder',
          trigger: { type: 'interval', ms: 60000 },
          params: { message: 'query-forge-test' },
        },
      });
      assert.equal(createRes.statusCode, 200);

      const stored = store.getAll().find((d) => d.params?.message === 'query-forge-test');
      assert.ok(stored, 'task should be persisted');
      assert.equal(stored.params.triggerUserId, 'default-user', 'must default to default-user without header');
    });

    it('P1: rejects non-object params with 400 (not 500)', async () => {
      const res = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks',
        payload: {
          templateId: 'reminder',
          trigger: { type: 'interval', ms: 60000 },
          params: 'oops-string',
        },
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /plain object/);
    });
  });

  describe('POST /api/schedule/tasks — callback auth infers deliveryThreadId', () => {
    let appDyn, store, registry;

    beforeEach(async () => {
      const { DynamicTaskStore } = await import('../dist/infrastructure/scheduler/DynamicTaskStore.js');
      const { templateRegistry } = await import('../dist/infrastructure/scheduler/templates/registry.js');
      const { scheduleRoutes: sr } = await import('../dist/routes/schedule.js');
      const { InvocationRegistry } = await import(
        '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
      );
      store = new DynamicTaskStore(db);
      registry = new InvocationRegistry();
      appDyn = Fastify({ logger: false });
      await appDyn.register(sr, { taskRunner: runner, dynamicTaskStore: store, templateRegistry, registry });
      await appDyn.ready();
    });

    afterEach(async () => {
      runner.stop();
      await appDyn.close();
    });

    it('uses callback-auth thread from request body when deliveryThreadId is omitted', async () => {
      const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-body-auth');
      const res = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          templateId: 'reminder',
          trigger: { type: 'once', delayMs: 1000 },
          params: { message: 'body-auth-thread' },
        },
      });
      assert.equal(res.statusCode, 200);

      const stored = store.getAll().find((d) => d.params?.message === 'body-auth-thread');
      assert.ok(stored, 'task should be persisted');
      assert.equal(stored.deliveryThreadId, 'thread-body-auth');
    });

    it('P1: callback-authenticated writes derive actor from verified invocation, not client body/header', async () => {
      const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-actor-auth');
      const res = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks',
        headers: {
          'x-invocation-id': invocationId,
          'x-callback-token': callbackToken,
          'x-cat-cafe-user': 'evil-header-user',
        },
        payload: {
          templateId: 'reminder',
          trigger: { type: 'once', delayMs: 1000 },
          createdBy: 'evil-body-cat',
          params: { message: 'callback-actor-auth', triggerUserId: 'evil-body-user' },
        },
      });
      assert.equal(res.statusCode, 200);

      const stored = store.getAll().find((d) => d.params?.message === 'callback-actor-auth');
      assert.ok(stored, 'task should be persisted');
      assert.equal(stored.createdBy, 'opus', 'createdBy must come from callbackAuth.catId');
      assert.equal(stored.params.triggerUserId, 'user-1', 'triggerUserId must come from callbackAuth.userId');
    });

    it('falls back to callback-auth headers when body credentials are absent', async () => {
      const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-header-auth');
      const res = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks',
        headers: {
          'x-invocation-id': invocationId,
          'x-callback-token': callbackToken,
        },
        payload: {
          templateId: 'reminder',
          trigger: { type: 'once', delayMs: 1000 },
          params: { message: 'header-auth-thread' },
        },
      });
      assert.equal(res.statusCode, 200);

      const stored = store.getAll().find((d) => d.params?.message === 'header-auth-thread');
      assert.ok(stored, 'task should be persisted');
      assert.equal(stored.deliveryThreadId, 'thread-header-auth');
    });

    it('prefers explicit deliveryThreadId over callback-auth inferred thread', async () => {
      const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-from-callback');
      const res = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          templateId: 'reminder',
          trigger: { type: 'once', delayMs: 1000 },
          params: { message: 'explicit-thread-wins' },
          deliveryThreadId: 'thread-explicit',
        },
      });
      assert.equal(res.statusCode, 200);

      const stored = store.getAll().find((d) => d.params?.message === 'explicit-thread-wins');
      assert.ok(stored, 'task should be persisted');
      assert.equal(stored.deliveryThreadId, 'thread-explicit');
    });

    it('returns 409 stale invocation error and does not persist for stale callback auth invocation', async () => {
      const stale = registry.create('user-1', 'opus', 'thread-stale');
      registry.create('user-1', 'opus', 'thread-stale');

      const res = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks',
        headers: { 'x-invocation-id': stale.invocationId, 'x-callback-token': stale.callbackToken },
        payload: {
          templateId: 'reminder',
          trigger: { type: 'once', delayMs: 1000 },
          params: { message: 'stale-create' },
          deliveryThreadId: 'thread-explicit-create',
        },
      });

      assert.equal(res.statusCode, 409);
      const body = res.json();
      assert.equal(body.code, 'STALE_INVOCATION');
      const stored = store.getAll().find((d) => d.params?.message === 'stale-create');
      assert.equal(stored, undefined);
    });

    it('returns 401 and does not persist for invalid callback credentials (fail-closed, #474)', async () => {
      const { invocationId } = registry.create('user-1', 'opus', 'thread-create-invalid');
      const res = await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': 'invalid-token' },
        payload: {
          templateId: 'reminder',
          trigger: { type: 'once', delayMs: 1000 },
          params: { message: 'invalid-create' },
          deliveryThreadId: 'thread-explicit-create',
        },
      });

      assert.equal(res.statusCode, 401);
      const body = res.json();
      assert.ok(body.error.includes('expired'), 'preHandler rejects invalid creds before route handler');
      const stored = store.getAll().find((d) => d.params?.message === 'invalid-create');
      assert.equal(stored, undefined);
    });
  });

  describe('PATCH /api/schedule/tasks/:id (P1-2: runtime pause/resume)', () => {
    let appDyn, store;

    beforeEach(async () => {
      const { DynamicTaskStore } = await import('../dist/infrastructure/scheduler/DynamicTaskStore.js');
      const { templateRegistry } = await import('../dist/infrastructure/scheduler/templates/registry.js');
      const { scheduleRoutes: sr } = await import('../dist/routes/schedule.js');
      store = new DynamicTaskStore(db);
      appDyn = Fastify({ logger: false });
      await appDyn.register(sr, { taskRunner: runner, dynamicTaskStore: store, templateRegistry });
      await appDyn.ready();

      // Create a dynamic task
      await appDyn.inject({
        method: 'POST',
        url: '/api/schedule/tasks',
        payload: {
          templateId: 'reminder',
          trigger: { type: 'interval', ms: 60000 },
          params: { message: 'test' },
        },
      });
    });

    afterEach(async () => {
      await appDyn.close();
    });

    it('PATCH enabled=false removes task from runtime', async () => {
      // Find the dynamic task
      const listRes = await appDyn.inject({ method: 'GET', url: '/api/schedule/tasks' });
      const dynTask = JSON.parse(listRes.payload).tasks.find((t) => t.source === 'dynamic');
      assert.ok(dynTask, 'dynamic task should exist');

      // Pause it
      const patchRes = await appDyn.inject({
        method: 'PATCH',
        url: `/api/schedule/tasks/${dynTask.dynamicTaskId}`,
        payload: { enabled: false },
      });
      assert.equal(patchRes.statusCode, 200);

      // Verify runtime no longer has it
      const listRes2 = await appDyn.inject({ method: 'GET', url: '/api/schedule/tasks' });
      const tasks = JSON.parse(listRes2.payload).tasks;
      const found = tasks.find((t) => t.dynamicTaskId === dynTask.dynamicTaskId);
      assert.ok(!found, 'paused task should be unregistered from runtime');
    });

    it('PATCH enabled=true re-registers task in runtime', async () => {
      const listRes = await appDyn.inject({ method: 'GET', url: '/api/schedule/tasks' });
      const dynTask = JSON.parse(listRes.payload).tasks.find((t) => t.source === 'dynamic');

      // Pause then resume
      await appDyn.inject({
        method: 'PATCH',
        url: `/api/schedule/tasks/${dynTask.dynamicTaskId}`,
        payload: { enabled: false },
      });
      const resumeRes = await appDyn.inject({
        method: 'PATCH',
        url: `/api/schedule/tasks/${dynTask.dynamicTaskId}`,
        payload: { enabled: true },
      });
      assert.equal(resumeRes.statusCode, 200);

      // Verify task is back in runtime
      const listRes2 = await appDyn.inject({ method: 'GET', url: '/api/schedule/tasks' });
      const tasks = JSON.parse(listRes2.payload).tasks;
      const found = tasks.find((t) => t.dynamicTaskId === dynTask.dynamicTaskId);
      assert.ok(found, 'resumed task should be re-registered in runtime');
    });
  });
});
