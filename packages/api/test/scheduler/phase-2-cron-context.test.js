import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('Phase 2: Cron trigger + ContextSpec', () => {
  let db, ledger, RunLedger, TaskRunnerV2;
  const noop = () => {};
  const silentLogger = { info: noop, error: noop };

  beforeEach(async () => {
    db = new Database(':memory:');
    const schema = await import('../../dist/domains/memory/schema.js');
    schema.applyMigrations(db);
    RunLedger = (await import('../../dist/infrastructure/scheduler/RunLedger.js')).RunLedger;
    TaskRunnerV2 = (await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js')).TaskRunnerV2;
    ledger = new RunLedger(db);
  });

  afterEach(() => {});

  describe('TriggerSpec cron type', () => {
    it('registers a task with cron trigger', () => {
      const runner = new TaskRunnerV2({ logger: silentLogger, ledger });
      runner.register({
        id: 'cron-task',
        profile: 'poller',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        admission: { gate: async () => ({ run: false, reason: 'test' }) },
        run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
      });
      assert.deepEqual(runner.getRegisteredTasks(), ['cron-task']);
      runner.stop();
    });

    it('cron task fires via triggerNow and records ledger', async () => {
      const runner = new TaskRunnerV2({ logger: silentLogger, ledger });
      let executed = false;
      runner.register({
        id: 'cron-exec',
        profile: 'poller',
        trigger: { type: 'cron', expression: '*/5 * * * *' },
        admission: {
          gate: async () => ({ run: true, workItems: [{ signal: 'tick', subjectKey: 'daily-check' }] }),
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
      });
      await runner.triggerNow('cron-exec');
      assert.ok(executed, 'cron task should execute via triggerNow');
      const rows = ledger.query('cron-exec', 10);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].outcome, 'RUN_DELIVERED');
      runner.stop();
    });

    it('getNextCronMs returns positive ms for valid expression', async () => {
      const { getNextCronMs } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
      const ms = getNextCronMs('0 9 * * *');
      assert.ok(typeof ms === 'number');
      assert.ok(ms > 0, 'next cron occurrence should be in the future');
      assert.ok(ms <= 24 * 60 * 60 * 1000, 'daily cron should fire within 24h');
    });

    it('getNextCronMs throws for invalid expression', async () => {
      const { getNextCronMs } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
      assert.throws(() => getNextCronMs('invalid cron'), /invalid|parse|validation|resolve/i);
    });
  });

  describe('ContextSpec', () => {
    it('passes context to execute when task has context spec', async () => {
      const runner = new TaskRunnerV2({ logger: silentLogger, ledger });
      let receivedCtx = null;
      runner.register({
        id: 'ctx-task',
        profile: 'awareness',
        trigger: { type: 'interval', ms: 999999 },
        admission: {
          gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'k' }] }),
        },
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async (_signal, _key, ctx) => {
            receivedCtx = ctx;
          },
        },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
        context: { session: 'new-thread', materialization: 'light' },
      });
      await runner.triggerNow('ctx-task');
      assert.ok(receivedCtx, 'execute should receive context');
      assert.deepEqual(receivedCtx.context, { session: 'new-thread', materialization: 'light' });
      runner.stop();
    });

    it('context is undefined when task has no context spec', async () => {
      const runner = new TaskRunnerV2({ logger: silentLogger, ledger });
      let receivedCtx = null;
      runner.register({
        id: 'no-ctx-task',
        profile: 'awareness',
        trigger: { type: 'interval', ms: 999999 },
        admission: {
          gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'k' }] }),
        },
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async (_signal, _key, ctx) => {
            receivedCtx = ctx;
          },
        },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
      });
      await runner.triggerNow('no-ctx-task');
      assert.ok(receivedCtx);
      assert.equal(receivedCtx.context, undefined);
      runner.stop();
    });
  });

  describe('RunLedger.stats()', () => {
    it('returns outcome counts per task', () => {
      // Insert mixed outcomes
      const now = new Date().toISOString();
      ledger.record({
        task_id: 't1',
        subject_key: 'a',
        outcome: 'RUN_DELIVERED',
        signal_summary: null,
        duration_ms: 10,
        started_at: now,
        assigned_cat_id: null,
      });
      ledger.record({
        task_id: 't1',
        subject_key: 'b',
        outcome: 'RUN_DELIVERED',
        signal_summary: null,
        duration_ms: 20,
        started_at: now,
        assigned_cat_id: null,
      });
      ledger.record({
        task_id: 't1',
        subject_key: 'c',
        outcome: 'RUN_FAILED',
        signal_summary: null,
        duration_ms: 30,
        started_at: now,
        assigned_cat_id: null,
      });
      ledger.record({
        task_id: 't1',
        subject_key: 'd',
        outcome: 'SKIP_NO_SIGNAL',
        signal_summary: null,
        duration_ms: 5,
        started_at: now,
        assigned_cat_id: null,
      });
      ledger.record({
        task_id: 't1',
        subject_key: 'e',
        outcome: 'SKIP_OVERLAP',
        signal_summary: null,
        duration_ms: 1,
        started_at: now,
        assigned_cat_id: null,
      });

      const stats = ledger.stats('t1');
      assert.equal(stats.total, 5);
      assert.equal(stats.delivered, 2);
      assert.equal(stats.failed, 1);
      assert.equal(stats.skipped, 2);
    });

    it('returns zero counts for unknown task', () => {
      const stats = ledger.stats('unknown');
      assert.equal(stats.total, 0);
      assert.equal(stats.delivered, 0);
      assert.equal(stats.failed, 0);
      assert.equal(stats.skipped, 0);
    });
  });

  describe('RunLedger.queryBySubject()', () => {
    it('filters by subject key prefix for thread scoping', () => {
      const now = new Date().toISOString();
      ledger.record({
        task_id: 't1',
        subject_key: 'thread:abc',
        outcome: 'RUN_DELIVERED',
        signal_summary: null,
        duration_ms: 10,
        started_at: now,
        assigned_cat_id: null,
      });
      ledger.record({
        task_id: 't1',
        subject_key: 'thread:xyz',
        outcome: 'RUN_DELIVERED',
        signal_summary: null,
        duration_ms: 20,
        started_at: now,
        assigned_cat_id: null,
      });
      ledger.record({
        task_id: 't1',
        subject_key: 'repo:owner/name',
        outcome: 'RUN_DELIVERED',
        signal_summary: null,
        duration_ms: 30,
        started_at: now,
        assigned_cat_id: null,
      });

      const threadAbc = ledger.queryBySubject('t1', 'thread:abc', 10);
      assert.equal(threadAbc.length, 1);
      assert.equal(threadAbc[0].subject_key, 'thread:abc');

      const repoRuns = ledger.queryBySubject('t1', 'repo:owner/name', 10);
      assert.equal(repoRuns.length, 1);
    });
  });

  describe('TaskRunnerV2.getTaskSummaries()', () => {
    it('returns summaries with trigger, profile, enabled, stats', async () => {
      const runner = new TaskRunnerV2({ logger: silentLogger, ledger });
      runner.register({
        id: 'sum-task',
        profile: 'poller',
        trigger: { type: 'interval', ms: 60000 },
        admission: {
          gate: async () => ({ run: true, workItems: [{ signal: 'ok', subjectKey: 'k' }] }),
        },
        run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
      });

      // Run once to populate ledger
      await runner.triggerNow('sum-task');

      const summaries = runner.getTaskSummaries();
      assert.equal(summaries.length, 1);
      const s = summaries[0];
      assert.equal(s.id, 'sum-task');
      assert.equal(s.profile, 'poller');
      assert.deepEqual(s.trigger, { type: 'interval', ms: 60000 });
      assert.equal(s.enabled, true);
      assert.ok(s.lastRun, 'should have lastRun');
      assert.equal(s.lastRun.outcome, 'RUN_DELIVERED');
      assert.equal(s.runStats.total, 1);
      assert.equal(s.runStats.delivered, 1);
      runner.stop();
    });
  });
});
