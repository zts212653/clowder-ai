import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openAlphaBrowserSubscription } from '../../../scripts/lib/alpha-browser-subscription.mjs';
import { readDurableGateRecovery } from '../dist/domains/ball-custody/durable-managed-gate-recovery.js';
import { createAlphaManagedControl } from '../dist/infrastructure/scheduler/templates/alpha-managed-control.js';
import { alphaManagedFixture, until } from './helpers/alpha-managed-scheduler-fixture.js';

function sources(root) {
  return {
    'waiting.test.mjs': `import test from 'node:test'; import {appendFileSync,existsSync} from 'node:fs';
    import {setTimeout} from 'node:timers/promises'; test('private waiting unit', async () => {
      appendFileSync(${JSON.stringify(join(root, 'executions.log'))}, 'once\\n');
      while (!existsSync(${JSON.stringify(join(root, 'release'))})) await setTimeout(20);
    });`,
  };
}
async function running(t, options = {}) {
  const f = await alphaManagedFixture(t, { sources, ...options });
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(new Error('private lifecycle deadline')), 22000);
  t.after(() => clearTimeout(watchdog));
  const work = f.run(controller.signal).then(
    () => null,
    (error) => error,
  );
  await until(() => existsSync(f.marker), 'private unit actually started');
  return { ...f, work, controller };
}

test(
  'a successor guardian consumes the historical exit70 RED and delivers its repair without replay',
  { timeout: 35000 },
  async (t) => {
    let rejectDelivery = true;
    const f = await alphaManagedFixture(t, {
      guardianCatId: 'codex61-sol',
      failureTriageCatId: 'codex61-sol',
      sources(root) {
        return {
          'failed.mjs': `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(join(root, 'executions.log'))},'once\\n'); process.exit(1);`,
        };
      },
      beforeRepairTask() {
        if (rejectDelivery) throw new Error('private repair write unavailable');
      },
    });
    await assert.rejects(f.run(new AbortController().signal, f.principal.catId), /private repair write unavailable/);
    const original = f.service.get(f.principal, f.managed.jobId);
    assert.equal(original.state, 'failed');
    assert.equal(original.cleanupProven, true);
    assert.equal(f.tasks.size, 0);
    // Seed the captured historical publication shape in this private ledger only.
    // Real S3 execution, cleanup and the failed result remain untouched.
    const db = new DatabaseSync(join(f.dataRoot, 'managed-jobs/supervisor.sqlite'));
    db.prepare("UPDATE managed_jobs SET record_json=json_set(record_json,'$.result.exitCode',70) WHERE job_id=?").run(
      f.managed.jobId,
    );
    db.close();
    rejectDelivery = false;
    await f.run();
    const store = openAlphaBrowserSubscription(f.input);
    try {
      assert.equal(store.pending(), undefined);
      assert.equal(store.list()[0].terminalStatus, 'failed');
      assert.equal(store.list()[0].managedJobId, f.managed.jobId);
    } finally {
      store.close();
    }
    assert.equal(f.service.list().length, 1);
    assert.equal(f.service.get(f.principal, f.managed.jobId).result.exitCode, 70);
    assert.deepEqual(f.service.resolve(f.managed.jobId).definition.principal, f.principal);
    assert.equal(readFileSync(f.marker, 'utf8'), 'once\n');
    assert.equal(f.tasks.size, 1);
    const repair = [...f.tasks.values()][0];
    assert.equal(repair.ownerCatId, 'codex61-sol');
    assert.doesNotMatch(repair.why, /Managed execution:/);
    assert.equal(f.delivered.length, 1);
    assert.equal(f.delivered[0].targetCatId, 'codex61-sol');
  },
);

test(
  'transport loss reconnects the same live managed owner without replaying its unit',
  { timeout: 35000 },
  async (t) => {
    const f = await running(t, { observeTransport: true });
    const before = f.service.get(f.principal, f.managed.jobId);
    process.kill(Number(readFileSync(f.transportPid, 'utf8')), 'SIGTERM');
    assert.match((await f.work)?.message ?? '', /without a clean result/);
    assert.deepEqual(f.service.get(f.principal, f.managed.jobId).ownerIdentity, before.ownerIdentity);
    const reattached = f.run(f.controller.signal);
    writeFileSync(join(f.parent, 'release'), 'release');
    await reattached;
    assert.equal(f.service.list().length, 1);
    assert.equal(readFileSync(f.marker, 'utf8'), 'once\n');
    assert.equal(f.service.get(f.principal, f.managed.jobId).state, 'succeeded');
  },
);

test(
  'fresh control reconciles a dead managed worker and reports a pending revision instead of waiting forever',
  { timeout: 35000 },
  async (t) => {
    const f = await running(t);
    const before = f.service.get(f.principal, f.managed.jobId);
    process.kill(before.ownerIdentity.pid, 'SIGKILL');
    const restored = createAlphaManagedControl({
      repoRoot: f.repoRoot,
      dataRoot: f.dataRoot,
      principal: f.principal,
      subscriptionId: f.input.subscriptionId,
    });
    await until(async () => {
      const state = await restored({ action: 'inspect', jobId: f.managed.jobId });
      return state.state === 'lost' && state.cleanupProven;
    }, 'dead owner reconciled');
    const error = await f.work;
    assert.match(error?.message ?? '', /incomplete.*Managed lost/);
    const store = openAlphaBrowserSubscription(f.input);
    try {
      assert.equal(store.pending().headSha, f.input.targetSha);
    } finally {
      store.close();
    }
    assert.equal(f.tasks.size, 1);
    assert.match([...f.tasks.values()][0].why, /Managed execution:.*managed-job-/);
    assert.equal(readFileSync(f.marker, 'utf8'), 'once\n');
  },
);

for (const stop of ['cancelled', 'timed_out']) {
  test(`Alpha ${stop} proves cleanup and never starts a recovery attempt`, { timeout: 35000 }, async (t) => {
    const f = await running(t, stop === 'timed_out' ? { wallSlaMs: 10000 } : {});
    if (stop === 'cancelled') f.service.cancel(f.principal, f.managed.jobId);
    const error = await f.work;
    if (error) throw error;
    const record = f.service.get(f.principal, f.managed.jobId);
    assert.equal(record.state, stop);
    assert.equal(record.cleanupProven, true);
    assert.equal(readDurableGateRecovery(f.descriptor).resumeCount, 0);
    assert.equal(readFileSync(f.marker, 'utf8'), 'once\n');
    assert.equal(f.tasks.size, 1);
  });
}
