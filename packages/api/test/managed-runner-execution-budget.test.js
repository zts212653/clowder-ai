import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createDurableManagedGateJob,
  initializeDurableManagedGateJob,
} from '../dist/domains/ball-custody/durable-managed-gate-job.js';
import { ManagedRunner } from '../dist/infrastructure/managed-runner.js';

test('the real durable worker delivers the admitted two-hour budget to its child', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gate-budget-worker-'));
  const previousRoot = process.env.CAT_CAFE_DATA_DIR;
  const previousBudget = process.env.CAT_CAFE_GATE_EXECUTION_SLA_MS;
  process.env.CAT_CAFE_DATA_DIR = root;
  process.env.CAT_CAFE_GATE_EXECUTION_SLA_MS = '1500';
  t.after(() => {
    if (previousRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousRoot;
    if (previousBudget === undefined) delete process.env.CAT_CAFE_GATE_EXECUTION_SLA_MS;
    else process.env.CAT_CAFE_GATE_EXECUTION_SLA_MS = previousBudget;
    rmSync(root, { recursive: true, force: true });
  });
  const job = createDurableManagedGateJob(
    'hold-ball-budget-test',
    7_200_000,
    {
      threadId: 'budget-thread',
      catId: 'codex-astra',
      userId: 'budget-user',
    },
    root,
  );
  initializeDurableManagedGateJob(job);
  const runner = new ManagedRunner();
  const { admission, completion } = runner.start(
    `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify({ budget: process.env.CAT_CAFE_GATE_EXECUTION_SLA_MS, origin: process.env.CAT_CAFE_GATE_ORIGIN_TASK_ID, cancelPath: process.env.CAT_CAFE_MANAGED_CANCEL_REQUEST_PATH }))'`,
    { managedJob: job, timeoutMs: 5_000, maximumTimeoutMs: job.wallSlaMs },
  );
  const admitted = await admission;
  const result = await completion;
  assert.equal(admitted.spawned, true);
  assert.equal(result.exitCode, 0, result.tailOutput);
  assert.equal(result.timedOut, false);
  assert.deepEqual(JSON.parse(result.tailOutput.trim()), {
    budget: '7200000',
    origin: job.originTaskId,
    cancelPath: `${job.recordPath}.cancel-request`,
  });
});
