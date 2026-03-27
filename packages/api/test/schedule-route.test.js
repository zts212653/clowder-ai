/**
 * Schedule Route Tests (F139 Phase 2)
 * Uses lightweight Fastify injection (no real HTTP server).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

describe('Schedule Routes', () => {
  let app, db, ledger, runner;
  const noop = () => {};
  const silentLogger = { info: noop, error: noop };

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../dist/domains/memory/schema.js');
    const { RunLedger } = await import('../dist/infrastructure/scheduler/RunLedger.js');
    const { TaskRunnerV2 } = await import('../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const { scheduleRoutes } = await import('../dist/routes/schedule.js');

    applyMigrations(db);
    ledger = new RunLedger(db);
    runner = new TaskRunnerV2({ logger: silentLogger, ledger });

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
    });

    // Populate ledger with some runs
    await runner.triggerNow('summary-compact');
    await runner.triggerNow('cicd-check');

    app = Fastify({ logger: false });
    await app.register(scheduleRoutes, { taskRunner: runner });
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

  describe('POST /api/schedule/nl-config (AC-C4)', () => {
    it('parses "every 30 minutes" to interval', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/schedule/nl-config',
        payload: { prompt: 'every 30 minutes check stale issues' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.proposal);
      assert.deepEqual(body.proposal.trigger, { type: 'interval', ms: 1800000 });
    });

    it('parses "daily at 9" to cron', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/schedule/nl-config',
        payload: { prompt: 'daily at 9 summarize threads' },
      });
      const body = JSON.parse(res.payload);
      assert.ok(body.proposal);
      assert.deepEqual(body.proposal.trigger, { type: 'cron', expression: '0 9 * * *' });
    });

    it('parses "hourly" to cron', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/schedule/nl-config',
        payload: { prompt: 'hourly health check' },
      });
      const body = JSON.parse(res.payload);
      assert.deepEqual(body.proposal.trigger, { type: 'cron', expression: '0 * * * *' });
    });

    it('returns null proposal for unparseable input', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/schedule/nl-config',
        payload: { prompt: 'something vague' },
      });
      const body = JSON.parse(res.payload);
      assert.equal(body.proposal, null);
      assert.ok(body.confirmation.includes('Could not parse'));
    });

    it('returns 400 for missing prompt', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/schedule/nl-config',
        payload: {},
      });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('parseNlToTrigger()', () => {
    it('handles "every 2 hours"', async () => {
      const { parseNlToTrigger } = await import('../dist/routes/schedule.js');
      const result = parseNlToTrigger('every 2 hours');
      assert.ok(result);
      assert.deepEqual(result.trigger, { type: 'interval', ms: 7200000 });
    });

    it('handles "daily at 14:30"', async () => {
      const { parseNlToTrigger } = await import('../dist/routes/schedule.js');
      const result = parseNlToTrigger('daily at 14:30');
      assert.ok(result);
      assert.deepEqual(result.trigger, { type: 'cron', expression: '30 14 * * *' });
    });

    it('rejects invalid hour/minute ranges (P2-2)', async () => {
      const { parseNlToTrigger } = await import('../dist/routes/schedule.js');
      // hour > 23 should be rejected
      assert.equal(parseNlToTrigger('daily at 25'), null);
      // minute > 59 should be rejected
      assert.equal(parseNlToTrigger('daily at 14:99'), null);
      // both invalid
      assert.equal(parseNlToTrigger('daily at 99:99'), null);
    });
  });
});
