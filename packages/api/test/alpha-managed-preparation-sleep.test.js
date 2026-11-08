import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { openAlphaBrowserSubscription } from '../../../scripts/lib/alpha-browser-subscription.mjs';
import { readGateExecution } from '../../../scripts/lib/gate-execution-api.mjs';
import { readDurableGateRecovery } from '../dist/domains/ball-custody/durable-managed-gate-recovery.js';
import { alphaManagedFixture, until } from './helpers/alpha-managed-scheduler-fixture.js';

for (const preparationExit of [0, 7]) {
  test(
    `a live preparation survives sleep without replay and preserves exit ${preparationExit}`,
    { timeout: 45_000 },
    async (t) => {
      const f = await alphaManagedFixture(t, {
        recovery: { eventLoopGapMs: 300, reconciliationBudgetMs: 10_000, pollMs: 50 },
        preparations: [{ cwd: '.', argv: [process.execPath, 'prepare.mjs'], env: {} }],
        preparationSources: (root) => ({
          'prepare.mjs': `import {appendFileSync,writeFileSync,existsSync} from 'node:fs';
          import {setTimeout} from 'node:timers/promises';
          appendFileSync(${JSON.stringify(join(root, 'preparations.log'))}, 'once\\n');
          writeFileSync(${JSON.stringify(join(root, 'preparation-ready'))}, String(process.pid));
          while (!existsSync(${JSON.stringify(join(root, 'release-preparation'))})) await setTimeout(20);
          process.exit(${preparationExit});`,
        }),
      });
      const controller = new AbortController();
      const watchdog = globalThis.setTimeout(() => controller.abort(new Error('preparation fixture deadline')), 35_000);
      t.after(() => clearTimeout(watchdog));
      const work = f.run(controller.signal).then(
        () => null,
        (error) => error,
      );
      let ownerPid;
      let preparationPid;
      try {
        const ready = join(f.parent, 'preparation-ready');
        await until(() => existsSync(ready), 'preparation command is live');
        await until(
          () => readDurableGateRecovery(f.descriptor).lastObservedAt > statSync(ready).mtimeMs,
          'owner observed the live preparation',
        );
        ownerPid = f.service.get(f.principal, f.managed.jobId).ownerIdentity.pid;
        preparationPid = Number(readFileSync(ready, 'utf8'));
        process.kill(ownerPid, 'SIGSTOP');
        process.kill(-preparationPid, 'SIGSTOP');
        const startedAt = Date.now();
        await setTimeout(600);
        const endedAt = Date.now();
        writeFileSync(
          f.powerEvidence,
          JSON.stringify({
            version: 1,
            confirmedSleep: [{ evidenceId: 'private-preparation-sleep', startedAt, endedAt, wakeKind: 'full' }],
          }),
        );
        process.kill(-preparationPid, 'SIGCONT');
        process.kill(ownerPid, 'SIGCONT');
        ownerPid = null;
        preparationPid = null;
        await until(() => {
          const recovery = readDurableGateRecovery(f.descriptor);
          return recovery.lastObservedAt > endedAt && recovery.state !== 'reconciling_owner';
        }, 'owner handled the clock gap');
        assert.equal(readDurableGateRecovery(f.descriptor).pauseEpoch, 1);
        assert.equal(
          readDurableGateRecovery(f.descriptor).state,
          'running',
          f.service.tail(f.principal, f.managed.jobId),
        );
        writeFileSync(join(f.parent, 'release-preparation'), 'release');
        const error = await work;
        if (error) throw error;
        const store = openAlphaBrowserSubscription(f.input);
        try {
          const revision = store.list()[0];
          const result = readGateExecution({ ...f.input, jobId: revision.jobId, generation: revision.generation });
          assert.equal(readFileSync(join(f.parent, 'preparations.log'), 'utf8'), 'once\n');
          assert.equal(readDurableGateRecovery(f.descriptor).resumeCount, 0);
          if (preparationExit === 0) {
            assert.equal(result.terminalStatus, 'green');
            assert.equal(readFileSync(f.marker, 'utf8'), 'once\n');
            assert.equal(f.tasks.size, 0);
          } else {
            assert.equal(result.terminalStatus, 'failed');
            assert.equal(result.result.failureReceipt.exitCode, 7);
            assert.equal(existsSync(f.marker), false);
            assert.equal(f.tasks.size, 1);
          }
        } finally {
          store.close();
        }
      } catch (error) {
        throw new Error(`${error.message}\n${f.service.tail(f.principal, f.managed.jobId)}`, { cause: error });
      } finally {
        for (const pid of [ownerPid, preparationPid ? -preparationPid : null]) {
          if (pid) {
            try {
              process.kill(pid, 'SIGCONT');
            } catch {}
          }
        }
        writeFileSync(join(f.parent, 'release-preparation'), 'release');
        controller.abort(new Error('fixture cleanup'));
        await work;
      }
    },
  );
}
