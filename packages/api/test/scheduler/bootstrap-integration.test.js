import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('TaskRunnerV2 bootstrap integration', () => {
  let db;

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    applyMigrations(db);
  });

  afterEach(() => db.close());

  it('registers core and independently supplied TaskSpecs and lists them', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const { createSummaryCompactionTaskSpec } = await import('../../dist/domains/memory/SummaryCompactionTaskSpec.js');

    const ledger = new RunLedger(db);
    const runner = new TaskRunnerV2({
      logger: { info: () => {}, error: () => {} },
      ledger,
    });

    // Minimal deps for each spec
    const summarySpec = createSummaryCompactionTaskSpec({
      db,
      enabled: () => true,
      getThreadLastActivity: async () => null,
      getMessagesAfterWatermark: async () => [],
      generateAbstractive: async () => null,
      logger: { info: () => {}, error: () => {} },
    });

    const fixtureSpec = {
      id: 'installed-task-fixture',
      trigger: { type: 'interval', ms: 60_000 },
      admission: { gate: async () => ({ run: false, reason: 'fixture' }) },
      execute: async () => undefined,
    };

    runner.register(summarySpec);
    runner.register(fixtureSpec);

    const ids = runner.getRegisteredTasks();
    assert.deepEqual(ids.sort(), ['installed-task-fixture', 'summary-compact']);
  });

  it('rejects duplicate task id', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');

    const ledger = new RunLedger(db);
    const runner = new TaskRunnerV2({
      logger: { info: () => {}, error: () => {} },
      ledger,
    });

    const spec = {
      id: 'duplicate-fixture',
      trigger: { type: 'interval', ms: 60_000 },
      admission: { gate: async () => ({ run: false, reason: 'fixture' }) },
      execute: async () => undefined,
    };

    runner.register(spec);
    assert.throws(() => runner.register(spec), /duplicate task id/);
  });
});
