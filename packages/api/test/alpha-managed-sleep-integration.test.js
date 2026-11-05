import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { openAlphaBrowserSubscription } from '../../../scripts/lib/alpha-browser-subscription.mjs';
import { readGateExecution } from '../../../scripts/lib/gate-execution-api.mjs';
import { openGateExecutionReader } from '../../../scripts/lib/gate-execution-db.mjs';
import { readAlphaRecoveryObservation } from '../dist/domains/ball-custody/durable-managed-alpha-observation.js';
import { readDurableGateRecovery } from '../dist/domains/ball-custody/durable-managed-gate-recovery.js';
import { alphaRecoveryJournalPath } from '../dist/domains/ball-custody/durable-managed-gate-recovery-child-contract.js';
import { alphaManagedFixture, until } from './helpers/alpha-managed-scheduler-fixture.js';

for (const priorFailure of [true, false]) {
  test(
    priorFailure
      ? 'Alpha161 shape: a real nested failure before sleep is retained and never replayed'
      : 'same managed owner resumes only interrupted Alpha work and preserves earlier green',
    { timeout: 45000 },
    async (t) => {
      const f = await alphaManagedFixture(t, {
        recovery: { eventLoopGapMs: 300, reconciliationBudgetMs: 10000, pollMs: 50 },
        sources: (root) => ({
          'first.test.mjs': `import test from 'node:test'; import {appendFileSync} from 'node:fs';
          test('known green', () => appendFileSync(${JSON.stringify(join(root, 'green.log'))}, 'once\\n'));`,
          'second.test.mjs': `import test from 'node:test'; import assert from 'node:assert/strict';
          import {writeFileSync,appendFileSync,existsSync} from 'node:fs'; import {setTimeout} from 'node:timers/promises';
          test('parent remains in flight', async t => {
            const epoch = process.env.CAT_CAFE_MANAGED_GATE_RESUME_EPOCH ?? '0';
            appendFileSync(${JSON.stringify(join(root, 'attempts.log'))}, epoch+'\\n');
            if (epoch !== '0') return;
            if (${priorFailure}) await t.test('actual assertion before sleep', () => assert.fail('Alpha161 regression shape'));
            writeFileSync(${JSON.stringify(join(root, 'ready'))}, 'ready');
            while (!existsSync(${JSON.stringify(join(root, 'release'))})) await setTimeout(20);
          });`,
        }),
      });
      const controller = new AbortController();
      const watchdog = globalThis.setTimeout(
        () => controller.abort(new Error('private sleep fixture deadline')),
        35000,
      );
      t.after(() => clearTimeout(watchdog));
      const work = f.run(controller.signal).then(
        () => null,
        (error) => error,
      );
      let owner;
      try {
        await until(() => existsSync(join(f.parent, 'ready')), 'nested test is in flight');
        const record = f.service.get(f.principal, f.managed.jobId);
        owner = record.ownerIdentity;
        await until(
          () =>
            readAlphaRecoveryObservation(f.descriptor, record.attemptToken).kind ===
            (priorFailure ? 'failed' : 'clean'),
          'structured reporter evidence is durable',
        );
        await until(
          () => readDurableGateRecovery(f.descriptor).lastObservedAt > statSync(join(f.parent, 'ready')).mtimeMs,
          'the managed heartbeat follows the prior green',
        );
        process.kill(owner.pid, 'SIGSTOP');
        const startedAt = Date.now();
        await setTimeout(600);
        writeFileSync(
          f.powerEvidence,
          JSON.stringify({
            version: 1,
            confirmedSleep: [
              { evidenceId: 'private-controlled-sleep', startedAt, endedAt: Date.now(), wakeKind: 'full' },
            ],
          }),
        );
        process.kill(owner.pid, 'SIGCONT');
        owner = null;
        const error = await work;
        if (error) throw error;
      } catch (error) {
        throw new Error(`${error.message}\n${f.service.tail(f.principal, f.managed.jobId)}`, { cause: error });
      } finally {
        if (owner) {
          try {
            process.kill(owner.pid, 'SIGCONT');
          } catch {}
        }
        writeFileSync(join(f.parent, 'release'), 'release');
        controller.abort(new Error('fixture cleanup'));
      }
      const recovery = readDurableGateRecovery(f.descriptor);
      const store = openAlphaBrowserSubscription(f.input);
      try {
        assert.equal(store.pending(), undefined);
        const revision = store.list()[0];
        const receipt = readGateExecution({ ...f.input, jobId: revision.jobId, generation: revision.generation });
        assert.equal(readFileSync(join(f.parent, 'green.log'), 'utf8'), 'once\n');
        const record = f.service.get(f.principal, f.managed.jobId);
        assert.equal(
          recovery.resumeCount,
          priorFailure ? 0 : 1,
          `${JSON.stringify(recovery)}\n${f.service.tail(f.principal, f.managed.jobId)}\n${readFileSync(alphaRecoveryJournalPath(f.descriptor, record.attemptToken), 'utf8')}`,
        );
        assert.equal(recovery.pauseEpoch, 1);
        if (priorFailure) {
          assert.notEqual(receipt.terminalStatus, 'green');
          assert.equal(readFileSync(join(f.parent, 'attempts.log'), 'utf8'), '0\n');
          assert.equal(f.tasks.size, 1);
          assert.match(f.service.tail(f.principal, f.managed.jobId), /observed failure.*no automatic replay/);
        } else {
          assert.equal(receipt.terminalStatus, 'green');
          const database = openGateExecutionReader(f.input.databasePath);
          const previous = database
            .prepare('SELECT used_ms FROM gate_execution_budgets WHERE job_id=? AND generation=1 AND budget_id=?')
            .get(revision.jobId, receipt.budgets[0].budgetId);
          const interrupted = database
            .prepare(`SELECT a.receipt_json FROM gate_execution_unit_attempts a
          JOIN gate_execution_units u USING(job_id,generation,unit_id)
          WHERE a.job_id=? AND a.generation=1 AND a.terminal_status='cancelled' AND u.budget_id=?`)
            .all(revision.jobId, receipt.budgets[0].budgetId)
            .reduce((sum, row) => sum + JSON.parse(row.receipt_json).executionDurationMs, 0);
          database.close();
          assert.equal(receipt.units[0].state, 'reused');
          assert.ok(
            interrupted > 0 && receipt.budgets[0].usedMs >= previous.used_ms + interrupted,
            'recovery preserves the cumulative execution budget',
          );
          assert.equal(readFileSync(join(f.parent, 'attempts.log'), 'utf8'), '0\n1\n');
          assert.equal(f.tasks.size, 0);
        }
      } finally {
        store.close();
      }
    },
  );
}
