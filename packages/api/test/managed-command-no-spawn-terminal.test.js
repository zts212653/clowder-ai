import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createDurableManagedGateJob,
  validateDurableManagedGateJob,
} from '../dist/domains/ball-custody/durable-managed-gate-job.js';
import { settleNoSpawnDurableGate } from '../dist/domains/ball-custody/managed-command-no-spawn-terminal.js';

for (const invalid of ['origin', 'path', 'recovery-config']) {
  test(`no-spawn terminal rejects invalid ${invalid} before any gate-store write`, () => {
    const root = mkdtempSync(join(tmpdir(), 'f306-terminal-validation-'));
    const outside = mkdtempSync(join(tmpdir(), 'f306-terminal-outside-'));
    const previous = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = root;
    try {
      const job = createDurableManagedGateJob('actual-task', 60_000, { threadId: 't', catId: 'codex', userId: 'u' });
      if (invalid === 'origin') job.originTaskId = 'forged-task';
      if (invalid === 'path') {
        job.recordPath = join(outside, 'forged.json');
        job.gateReceiptPath = join(outside, 'forged.gate.json');
        job.logPath = join(outside, 'forged.log');
      }
      if (invalid === 'recovery-config') {
        job.kind = 'resumable_full_gate_v2';
        job.recovery = {
          protocolVersion: 2,
          eventLoopGapMs: 100,
          reconciliationBudgetMs: 100,
          pollMs: 10,
          powerEvidenceSource: { kind: 'json_file', path: join(outside, 'power.json') },
        };
      }
      assert.equal(validateDurableManagedGateJob(job, 'actual-task'), false);
      assert.equal(settleNoSpawnDurableGate(job, 'actual-task', 'refused'), false);
      assert.deepEqual(readdirSync(root), [], 'invalid job cannot initialize a gate owner');
      assert.deepEqual(readdirSync(outside), [], 'invalid job cannot create external receipts or supervisor DB');
    } finally {
      if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
}
