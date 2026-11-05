import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { openAlphaBrowserSubscription } from '../../../scripts/lib/alpha-browser-subscription.mjs';
import { readDurableGateRecovery } from '../dist/domains/ball-custody/durable-managed-gate-recovery.js';
import { alphaManagedFixture } from './helpers/alpha-managed-scheduler-fixture.js';

for (const materializationExitCode of [0, 7]) {
  test(
    `managed Alpha materialization exit ${materializationExitCode} preserves seal/ready and original subscription settlement`,
    { timeout: 30000 },
    async (t) => {
      const f = await alphaManagedFixture(t, { materializationExitCode });
      const controller = new AbortController();
      const watchdog = setTimeout(() => controller.abort(new Error('private install fixture deadline')), 20000);
      try {
        await f.run(controller.signal);
      } finally {
        clearTimeout(watchdog);
      }
      assert.equal(readFileSync(f.installLog, 'utf8'), 'once\n');
      assert.equal(existsSync(f.marker), materializationExitCode === 0);
      const recovery = readDurableGateRecovery(f.descriptor);
      assert.equal(recovery.resumeCount, 0);
      assert.equal(recovery.frozenIdentity === null, materializationExitCode !== 0);
      assert.equal(f.tasks.size, materializationExitCode === 0 ? 0 : 1);
      const store = openAlphaBrowserSubscription(f.input);
      try {
        assert.equal(store.pending(), undefined);
      } finally {
        store.close();
      }
      await f.run();
      assert.equal(readFileSync(f.installLog, 'utf8'), 'once\n');
    },
  );
}
